import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { ToolError } from '../tools/tool';
import { BUILTIN_WORKFLOWS_DIR } from '../assets';
import type { Logger } from '../logger';
import type { ProgressReporter } from '../progress';
import type { Config } from '../config/config';

export interface ComfyUINode {
  inputs: Record<string, unknown>;
  class_type: string;
  _meta?: Record<string, unknown>;
}

export interface ComfyUIOutput {
  files: Array<{
    filename: string;
    subfolder: string;
    type: 'output' | 'temp' | 'input';
  }>;
}

export interface WorkflowPatchmap {
  /** Node ID whose outputs contain the generated file(s) to download */
  outputNode: string;
  /** img2video only: LoadImage node where the uploaded image filename is set */
  imageNode?: string;
  imageField?: string;
  /**
   * Maps each tool parameter name to one or more {nodeId, field} pairs.
   * The pool patches all listed nodes when that parameter is provided.
   */
  params: Record<string, Array<{ nodeId: string; field: string }>>;
}

/**
 * Deep-merges a patch into a workflow JSON.
 * patch format: { nodeId: { inputField: value } }
 * Only the specified fields are changed; everything else stays as-is.
 */
export function patchWorkflow(
  workflow: Record<string, ComfyUINode>,
  patch: Record<string, Record<string, unknown>>,
): Record<string, ComfyUINode> {
  const result: Record<string, ComfyUINode> = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    const nodePatch = patch[nodeId];
    if (nodePatch) {
      result[nodeId] = { ...node, inputs: { ...node.inputs, ...nodePatch } };
    } else {
      result[nodeId] = node;
    }
  }
  return result;
}

interface ActiveServer {
  url: string;
  weight: number;
  activeJobs: number;
}

export class ComfyUIPool {
  private activeServers: ActiveServer[] = [];
  private roundRobinIndex = 0;

  constructor(
    private readonly config: Config['comfyui'],
    private readonly userWorkflowsDir: string,
    private readonly cwd: string,
    private readonly logger: Logger,
    private readonly progress: ProgressReporter,
  ) {}

  /**
   * Ping each configured server's GET /system_stats.
   * Unreachable servers are excluded with a warning.
   * If no servers are reachable, the pool is empty (tools will return ToolError when called).
   */
  async init(): Promise<void> {
    const results = await Promise.allSettled(
      this.config.servers.map(async (server) => {
        const url = `${server.url}/system_stats`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return server;
      }),
    );

    this.activeServers = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        this.activeServers.push({ ...result.value, activeJobs: 0 });
      } else {
        this.logger.warn(`ComfyUI server unreachable, excluding from pool`, {
          url: this.config.servers[i]?.url,
          reason: (result.reason as Error).message,
        });
      }
    });

    if (this.activeServers.length === 0) {
      this.logger.warn(
        'ComfyUI pool is empty — all servers unreachable; comfyui_* tools will return errors',
      );
    } else {
      this.logger.info(`ComfyUI pool initialised`, { servers: this.activeServers.length });
    }
  }

  /**
   * Select the least-loaded active server that has capacity.
   * Queries GET /queue on each server; picks the one with the lowest queue_remaining / weight.
   * Skips servers at maxConcurrentPerServer capacity.
   * Falls back to round-robin if all queue queries fail.
   * Throws a retryable ToolError if the pool is empty or all servers at capacity.
   */
  async selectServer(): Promise<{ url: string; weight: number }> {
    if (this.activeServers.length === 0) {
      throw new ToolError(
        'No ComfyUI servers available — all servers were unreachable at startup',
        true,
      );
    }

    const scores = await Promise.allSettled(
      this.activeServers.map(async (server) => {
        const response = await fetch(`${server.url}/queue`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { queue_running: number; queue_pending: number };
        const queueRemaining = data.queue_running + data.queue_pending;
        return { server, score: queueRemaining / server.weight };
      }),
    );

    const maxConcurrent = this.config.maxConcurrentPerServer;

    let best: { url: string; weight: number } | null = null;
    let bestScore = Infinity;
    for (const result of scores) {
      if (result.status === 'fulfilled') {
        const { server, score } = result.value;
        if (server.activeJobs >= maxConcurrent) {
          continue;
        }
        if (score < bestScore) {
          bestScore = score;
          best = server;
        }
      }
    }

    if (best !== null) {
      return best;
    }

    const availableServers = this.activeServers.filter((s) => s.activeJobs < maxConcurrent);
    if (availableServers.length > 0) {
      this.logger.warn(
        'ComfyUI queue queries failed for all servers, falling back to round-robin',
        {
          available: availableServers.length,
          atCapacity: this.activeServers.length - availableServers.length,
        },
      );
      const idx = this.roundRobinIndex % availableServers.length;
      this.roundRobinIndex++;
      const server = availableServers[idx]!;
      return { url: server.url, weight: server.weight };
    }

    throw new ToolError(
      `All ComfyUI servers at capacity (max ${maxConcurrent} concurrent jobs per server). Please retry.`,
      true,
    );
  }

  /**
   * Resolve a workflow name to an absolute file path.
   * Checks userWorkflowsDir first (user override), then BUILTIN_WORKFLOWS_DIR.
   * Throws a non-retryable ToolError if neither exists.
   */
  resolveWorkflow(name: string): string {
    const userPath = join(this.userWorkflowsDir, `${name}.json`);
    if (existsSync(userPath)) {
      return userPath;
    }
    const builtinPath = join(BUILTIN_WORKFLOWS_DIR, `${name}.json`);
    if (existsSync(builtinPath)) {
      return builtinPath;
    }
    throw new ToolError(
      `Workflow "${name}" not found in ${this.userWorkflowsDir} or built-in workflows`,
      false,
    );
  }

  /**
   * Load a workflow JSON and its companion .patchmap.json from disk.
   * Returns the parsed workflow object and patchmap.
   * Throws a non-retryable ToolError if the patchmap is missing or malformed.
   */
  loadWorkflow(name: string): {
    workflow: Record<string, ComfyUINode>;
    patchmap: WorkflowPatchmap;
  } {
    const workflowPath = this.resolveWorkflow(name);
    const patchmapPath = workflowPath.replace(/\.json$/, '.patchmap.json');

    let workflow: Record<string, ComfyUINode>;
    try {
      workflow = JSON.parse(readFileSync(workflowPath, 'utf8')) as Record<string, ComfyUINode>;
    } catch (err) {
      throw new ToolError(`Failed to load workflow "${name}": ${(err as Error).message}`, false);
    }

    let patchmap: WorkflowPatchmap;
    try {
      patchmap = JSON.parse(readFileSync(patchmapPath, 'utf8')) as WorkflowPatchmap;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ToolError(`Patchmap file missing for workflow "${name}": ${patchmapPath}`, false);
      }
      throw new ToolError(
        `Failed to load patchmap for "${name}": ${(err as Error).message}`,
        false,
      );
    }

    return { workflow, patchmap };
  }

  /**
   * Upload a local file to a ComfyUI server.
   * Returns the server-assigned filename.
   * Throws a retryable ToolError on failure.
   */
  async uploadImage(localPath: string, server: { url: string; weight: number }): Promise<string> {
    this.assertWithinWorkspace(localPath);

    let buffer: Buffer;
    try {
      buffer = await readFile(localPath);
    } catch (err) {
      const retryable = (err as NodeJS.ErrnoException).code !== 'ENOENT';
      throw new ToolError(
        `Failed to read image file "${localPath}": ${(err as Error).message}`,
        retryable,
      );
    }

    const formData = new FormData();
    const blob = new Blob([new Uint8Array(buffer)]);
    formData.append('image', blob, basename(localPath));

    let response: Response;
    try {
      response = await fetch(`${server.url}/upload/image`, { method: 'POST', body: formData });
    } catch (err) {
      throw new ToolError(`Image upload to ${server.url} failed: ${(err as Error).message}`, true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ToolError(
        `Image upload to ${server.url} failed with HTTP ${response.status}: ${body}`,
        response.status >= 500,
      );
    }

    const data = (await response.json()) as { name: string };
    return data.name;
  }

  /**
   * Queue a workflow on a ComfyUI server.
   * Increments the active job counter for the server.
   * Returns the prompt ID.
   * Throws retryable ToolError on 5xx/network; non-retryable on 4xx.
   */
  async queueWorkflow(workflow: object, server: { url: string; weight: number }): Promise<string> {
    this.incrementJobCount(server.url);

    let response: Response;
    try {
      response = await fetch(`${server.url}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow }),
      });
    } catch (err) {
      this.decrementJobCount(server.url);
      throw new ToolError(
        `Workflow queue to ${server.url} failed: ${(err as Error).message}`,
        true,
      );
    }

    if (!response.ok) {
      this.decrementJobCount(server.url);
      const body = await response.text().catch(() => '');
      throw new ToolError(
        `Workflow queue to ${server.url} failed with HTTP ${response.status}: ${body}`,
        response.status >= 500,
      );
    }

    const data = (await response.json()) as { prompt_id: string };
    return data.prompt_id;
  }

  /**
   * Poll GET /history/{promptId} until the workflow completes or timeoutMs elapses.
   * Decrements the active job counter when the workflow completes.
   * Returns the output file list from all output nodes.
   * Throws a retryable ToolError on timeout.
   */
  async pollResult(
    promptId: string,
    server: { url: string; weight: number },
    timeoutMs: number,
  ): Promise<ComfyUIOutput> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let response: Response;
      try {
        response = await fetch(`${server.url}/history/${promptId}`);
      } catch (err) {
        throw new ToolError(`Poll failed for prompt ${promptId}: ${(err as Error).message}`, true);
      }

      if (response.ok) {
        const history = (await response.json()) as Record<
          string,
          {
            status: {
              completed: boolean;
              status_str?: string;
              messages?: Array<[string, Record<string, unknown>]>;
            };
            outputs: Record<
              string,
              {
                images?: Array<{
                  filename: string;
                  subfolder: string;
                  type: 'output' | 'temp' | 'input';
                }>;
                videos?: Array<{
                  filename: string;
                  subfolder: string;
                  type: 'output' | 'temp' | 'input';
                }>;
              }
            >;
          }
        >;
        const entry = history[promptId];
        if (entry?.status?.completed) {
          this.decrementJobCount(server.url);

          // Check for ComfyUI execution errors
          if (entry.status.status_str === 'error') {
            const lastMessage = entry.status.messages?.[entry.status.messages.length - 1];
            const errorType = lastMessage?.[0] ?? 'unknown';
            const errorDetail = lastMessage?.[1]
              ? JSON.stringify(lastMessage[1]).slice(0, 500)
              : 'no details';
            throw new ToolError(
              `ComfyUI workflow execution error: ${errorType}. Details: ${errorDetail}`,
              false,
            );
          }

          const files: ComfyUIOutput['files'] = [];
          for (const node of Object.values(entry.outputs)) {
            if (node.images) {
              files.push(...node.images);
            }
            const nodeAny = node as Record<string, unknown>;
            if (nodeAny.videos && Array.isArray(nodeAny.videos)) {
              files.push(...(nodeAny.videos as ComfyUIOutput['files']));
            }
          }
          return { files };
        }
      }

      await new Promise<void>((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
    }

    this.decrementJobCount(server.url);
    throw new ToolError(`Workflow ${promptId} timed out after ${timeoutMs}ms`, true);
  }

  /**
   * Download a generated output file from a ComfyUI server to a local workspace path.
   * Throws a retryable ToolError on failure.
   */
  async downloadOutput(
    file: ComfyUIOutput['files'][number],
    server: { url: string; weight: number },
    localPath: string,
  ): Promise<void> {
    this.assertWithinWorkspace(localPath);

    const url = new URL('/view', server.url);
    url.searchParams.set('filename', file.filename);
    url.searchParams.set('subfolder', file.subfolder);
    url.searchParams.set('type', file.type);

    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (err) {
      throw new ToolError(`Download from ${server.url} failed: ${(err as Error).message}`, true);
    }

    if (!response.ok) {
      throw new ToolError(`Download from ${server.url} failed with HTTP ${response.status}`, true);
    }

    const buffer = await response.arrayBuffer();
    const abs = resolve(this.cwd, localPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, Buffer.from(buffer));
  }

  private incrementJobCount(url: string): void {
    const server = this.activeServers.find((s) => s.url === url);
    if (server) {
      server.activeJobs++;
    }
  }

  private decrementJobCount(url: string): void {
    const server = this.activeServers.find((s) => s.url === url);
    if (server && server.activeJobs > 0) {
      server.activeJobs--;
    }
  }

  private assertWithinWorkspace(filePath: string): void {
    const abs = resolve(this.cwd, filePath);
    const boundary = this.cwd.endsWith(sep) ? this.cwd : this.cwd + sep;
    if (!abs.startsWith(boundary)) {
      throw new ToolError(`path "${filePath}" is outside the workspace (${this.cwd})`, false);
    }
  }
}
