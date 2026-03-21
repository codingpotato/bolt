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

  const toolBus = new ToolBus();
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(webFetchTool);

  const ctx = { cwd, log, logger };
  const channel = new CliChannel();
  const agent = new AgentCore(client, channel, toolBus, ctx, config, undefined, logger);

  logger.info('bolt started', { model: config.model, auth: auth.mode, logLevel: config.logLevel });

  process.stderr.write(`bolt ready (model: ${config.model}, auth: ${auth.mode})\n`);
  process.stderr.write('Type a message and press Enter. Ctrl+D to exit.\n\n');

  await agent.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
