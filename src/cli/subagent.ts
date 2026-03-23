#!/usr/bin/env node

/**
 * bolt sub-agent entry point.
 *
 * Protocol:
 *   stdin  — JSON SubagentPayload
 *   stdout — JSON SubagentResult { output: string }
 *   stderr — operational logs (ignored by parent except on non-zero exit)
 *   exit 0 — success, exit 1 — failure
 *
 * The Anthropic client is constructed from the payload's authConfig,
 * NOT from process.env, ensuring auth isolation from the parent.
 */

import type { Channel, UserTurn } from '../channels';
import { ToolBus } from '../tools/tool-bus';
import { bashTool } from '../tools/bash';
import { fileReadTool, fileWriteTool, fileEditTool } from '../tools/file';
import { webFetchTool } from '../tools/web-fetch';
import { createAuditLogger } from '../audit/audit-logger';
import { createLogger } from '../logger';
import { createAnthropicClient } from '../auth/auth';
import { AgentCore } from '../agent/agent';
import { TodoStore } from '../todo/todo-store';
import { createTodoTools } from '../todo/todo-tools';
import { NoopProgressReporter } from '../progress';
import { DEFAULT_SYSTEM_PROMPT } from '../agent-prompt/agent-prompt';
import type { SubagentPayload, SubagentResult } from '../subagent/subagent-runner';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** A one-shot channel: yields the prompt once, then captures the response. */
export class CaptureChannel implements Channel {
  private output = '';

  constructor(private readonly prompt: string) {}

  async *receive(): AsyncIterableIterator<UserTurn> {
    yield { content: this.prompt };
  }

  async send(message: string): Promise<void> {
    this.output = message;
  }

  getOutput(): string {
    return this.output;
  }
}

async function main(): Promise<void> {
  // Read the full stdin payload before doing anything.
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });

  const payload = JSON.parse(raw) as SubagentPayload;

  // Use a per-run temp dir so this sub-agent has no access to the parent's data.
  const dataDir = join(tmpdir(), `bolt-subagent-${randomUUID()}`);
  const cwd = resolve(process.cwd());

  const client = createAnthropicClient(payload.authConfig);
  const log = createAuditLogger(dataDir);
  const logger = createLogger('warn', join(dataDir, 'bolt.log'));

  const toolBus = new ToolBus();
  const todoStore = new TodoStore();

  // Register basic tools — no memory or agent_suggest for sub-agents.
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(webFetchTool);
  for (const tool of createTodoTools(todoStore)) toolBus.register(tool);

  const channel = new CaptureChannel(payload.prompt);
  const ctx = {
    cwd,
    log,
    logger,
    progress: new NoopProgressReporter(),
    allowedTools: payload.allowedTools,
  };

  // Build a minimal config for the sub-agent.
  const config = {
    model: payload.model,
    dataDir,
    logLevel: 'warn' as const,
    memory: {
      compactThreshold: 0.8,
      keepRecentMessages: 10,
      taskHistoryMessages: 20,
      taskHistoryTokenBudget: 20000,
      injectRecentChat: false,
      storePath: 'memory',
      sessionPath: 'sessions',
      searchBackend: 'keyword' as const,
    },
    agentPrompt: {
      projectFile: '.bolt/AGENT.md',
      userFile: '~/.bolt/AGENT.md',
      suggestionsPath: '.bolt/suggestions',
    },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    channels: {
      web: { enabled: false, port: 3000, mode: 'http' as const },
    },
    cli: { verbose: false, progress: false },
    auth: { mode: 'api-key' as const },
    local: {},
    tools: { timeoutMs: 30000, allowedTools: [] },
    codeWorkflows: { testFixRetries: 3 },
  };

  const agent = new AgentCore(client, channel, toolBus, ctx, config, DEFAULT_SYSTEM_PROMPT);
  await agent.run();

  const result: SubagentResult = { output: channel.getOutput() };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err: unknown) => {
  process.stderr.write(`Sub-agent error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
