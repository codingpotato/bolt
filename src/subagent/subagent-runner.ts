import { spawn } from 'node:child_process';
import type { AuthConfig } from '../auth/auth';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';

export interface SubagentPayload {
  prompt: string;
  authConfig: AuthConfig;
  model: string;
  allowedTools?: string[];
  /** Optional system prompt override — used by skill_run to inject the skill's system prompt. */
  systemPrompt?: string;
  /** Inherited rules from parent (safety, communication, operating modes). */
  inheritedRules?: string;
}

export interface SubagentResult {
  output: string;
}

export type SubagentRunner = (
  payload: SubagentPayload,
  scriptPath: string,
  execPath?: string,
) => Promise<SubagentResult>;

/**
 * Spawns a child bolt sub-agent process, passes the payload via stdin,
 * and returns the structured result from stdout.
 *
 * The child constructs its Anthropic client from `authConfig` — it does not
 * read process.env for credentials, ensuring full auth isolation.
 *
 * @param payload - The subagent payload containing prompt and config
 * @param scriptPath - Path to the subagent script (JS or TS)
 * @param execPath - Optional Node.js executable path (defaults to process.execPath)
 * @param logger - Logger for sub-agent lifecycle events
 * @throws if the child exits with a non-zero code (includes captured stderr)
 */
export async function runSubagent(
  payload: SubagentPayload,
  scriptPath: string,
  execPath: string = process.execPath,
  logger: Logger = createNoopLogger(),
): Promise<SubagentResult> {
  const startTime = Date.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));

  logger.info('Sub-agent process spawning', {
    execPath,
    scriptPath,
    payloadBytes,
    model: payload.model,
    allowedTools: payload.allowedTools,
    hasSystemPrompt: !!payload.systemPrompt,
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Sub-agent spawn failed', {
        execPath,
        scriptPath,
        error: message,
      });
      reject(new Error(`Failed to spawn sub-agent: ${message}`));
      return;
    }

    logger.debug('Sub-agent process spawned', { pid: child.pid });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const chunkStr = chunk.toString();
      stderrBuf += chunkStr;
      logger.debug('Sub-agent stderr', { chunk: chunkStr.trim() });
    });

    child.on('close', (code: number) => {
      const duration = Date.now() - startTime;

      if (code !== 0) {
        logger.warn('Sub-agent exited with non-zero code', {
          exitCode: code,
          duration,
          stderrPreview: stderrBuf.trim().slice(0, 500),
        });
        reject(new Error(`Sub-agent exited with code ${code}: ${stderrBuf.trim()}`));
        return;
      }

      logger.debug('Sub-agent stdout captured', {
        bytes: stdoutBuf.length,
        preview: stdoutBuf.slice(0, 200),
      });

      try {
        const result = JSON.parse(stdoutBuf) as SubagentResult;
        logger.info('Sub-agent completed', {
          duration,
          outputLength: result.output.length,
          outputPreview: result.output.slice(0, 300),
        });

        resolve(result);
      } catch {
        logger.error('Sub-agent produced invalid JSON', {
          stdoutPreview: stdoutBuf.slice(0, 500),
          stderrPreview: stderrBuf.trim().slice(0, 500),
        });
        reject(new Error(`Sub-agent produced invalid JSON output: ${stdoutBuf.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      logger.error('Sub-agent process error', {
        error: err.message,
        execPath,
        scriptPath,
      });
      reject(new Error(`Sub-agent process error: ${err.message}`));
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
