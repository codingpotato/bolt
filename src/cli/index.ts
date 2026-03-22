#!/usr/bin/env node

/**
 * bolt CLI entry point.
 * Wires together auth, config, channel, tool bus, and agent core.
 */

import { resolveConfig } from '../config/config';
import { resolveAuth, createAnthropicClient } from '../auth/auth';
import { CliChannel } from '../channels/cli-channel';
import { ToolBus } from '../tools/tool-bus';
import { bashTool } from '../tools/bash';
import { fileReadTool, fileWriteTool, fileEditTool } from '../tools/file';
import { webFetchTool } from '../tools/web-fetch';
import { createAuditLogger } from '../audit/audit-logger';
import { createLogger } from '../logger';
import { AgentCore } from '../agent/agent';
import { TodoStore } from '../todo/todo-store';
import { createTodoTools } from '../todo/todo-tools';
import { TaskStore } from '../tasks/task-store';
import { createTaskTools } from '../tasks/task-tools';
import { loadAgentPrompt } from '../agent-prompt/agent-prompt';
import { CliProgressReporter } from '../progress';
import { SessionStore } from '../memory/session-store';
import { MemoryManager } from '../memory/memory-manager';
import { resolve, join } from 'node:path';

async function main(): Promise<void> {
  const config = resolveConfig();
  const auth = resolveAuth();
  const client = createAnthropicClient(auth);

  const cwd = process.cwd();
  // Resolve dataDir to an absolute path so audit logger and future components
  // are not sensitive to cwd changes after startup.
  const dataDir = resolve(cwd, config.dataDir);

  const log = createAuditLogger(dataDir);
  const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));

  // Parse progress-related CLI flags (override config defaults).
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose') || config.cli.verbose;
  const quiet = args.includes('--quiet') || !config.cli.progress;

  // Parse --session <id> flag for resuming a prior session.
  const sessionFlagIndex = args.indexOf('--session');
  const sessionId = sessionFlagIndex !== -1 ? args[sessionFlagIndex + 1] : undefined;

  const progress = new CliProgressReporter(process.stdout, verbose, quiet);

  const todoStore = new TodoStore();
  const taskStore = new TaskStore(dataDir);

  const sessionsDir = join(dataDir, config.memory.sessionPath);
  const sessionStore = new SessionStore(sessionsDir, logger);
  const memoryManager = new MemoryManager(sessionStore, config.memory, logger);

  const toolBus = new ToolBus();
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(webFetchTool);
  for (const tool of createTodoTools(todoStore)) toolBus.register(tool);
  for (const tool of createTaskTools(taskStore)) toolBus.register(tool);

  const ctx = { cwd, log, logger, progress };
  const channel = new CliChannel(process.stdin, process.stdout, () => progress.clearPendingThinking());
  const systemPrompt = await loadAgentPrompt(config);
  const agent = new AgentCore(
    client,
    channel,
    toolBus,
    ctx,
    config,
    systemPrompt,
    undefined,
    logger,
    sessionStore,
    sessionId,
    memoryManager,
  );

  logger.info('bolt started', { model: config.model, auth: auth.mode, logLevel: config.logLevel });

  process.stderr.write(`bolt ready (model: ${config.model}, auth: ${auth.mode})\n`);
  process.stderr.write('Type a message and press Enter. Ctrl+D to exit.\n\n');

  await agent.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
