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
import { fileSearchTool } from '../tools/file-search';
import { globTool } from '../tools/glob';
import { fileInsertTool } from '../tools/file-insert';
import { webFetchTool } from '../tools/web-fetch';
import { createAuditLogger } from '../audit/audit-logger';
import { createLogger, createTraceLogger, createNoopTraceLogger } from '../logger';
import { AgentCore } from '../agent/agent';
import { TodoStore } from '../todo/todo-store';
import { createTodoTools } from '../todo/todo-tools';
import { TaskRegistry } from '../tasks/task-registry';
import { createTaskTools } from '../tasks/task-tools';
import {
  assembleSystemPrompt,
  watchAgentPrompt,
  extractPromptSections,
  estimateTokenCount,
} from '../agent-prompt/agent-prompt';
import { CliProgressReporter, WebChannelProgressReporter } from '../progress';
import { SessionStore } from '../memory/session-store';
import { MemoryStore } from '../memory/memory-store';
import { MemoryManager } from '../memory/memory-manager';
import { createMemorySearchTool } from '../tools/memory-search';
import { createMemoryWriteTool } from '../tools/memory-write';
import { createSubagentRunTool } from '../tools/subagent-run';
import { createSkillRunTool } from '../tools/skill-run';
import { runSubagent } from '../subagent/subagent-runner';
import { loadSkills } from '../skills/skill-loader';
import { createSkillsSlashCommand } from '../skills/skills-slash-command';
import { createRunSkillSlashCommand } from '../skills/run-skill-slash-command';
import { createSlashCommandRegistry } from '../slash-commands/slash-commands';
import { createSearchProvider, validateSearchProvider } from '../search';
import { createWebSearchTool } from '../tools/web-search';
import { createUserReviewTool } from '../tools/user-review';
import { WebChannel } from '../channels/web-channel';
import { ComfyUIPool } from '../comfyui/comfyui-pool';
import { createComfyUIText2ImgTool } from '../tools/comfyui-text2img';
import { createComfyUIImg2VideoTool } from '../tools/comfyui-img2video';
import { createVideoMergeTool } from '../tools/video-merge';
import { createVideoAddAudioTool } from '../tools/video-add-audio';
import { createVideoAddSubtitlesTool } from '../tools/video-add-subtitles';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { createContentProjectTools } from '../tools/content-project-tools';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const INHERITED_SECTIONS = ['Safety Rules', 'Communication Style', 'Operating Modes'] as const;

/**
 * Resolves the subagent script path and execution info.
 * In production (running from dist/), uses subagent.js with node.
 * In development (running from src/ with tsx), uses subagent.ts with tsx.
 */
function resolveSubagentScript(): { scriptPath: string; execPath: string } {
  const jsPath = join(__dirname, 'subagent.js');
  const tsPath = join(__dirname, 'subagent.ts');

  if (existsSync(jsPath)) {
    return { scriptPath: jsPath, execPath: process.execPath };
  }
  if (existsSync(tsPath)) {
    // In development mode, use tsx to run TypeScript directly
    return { scriptPath: tsPath, execPath: 'tsx' };
  }
  throw new Error(
    `Subagent script not found. Expected ${jsPath} or ${tsPath}. ` +
      'Run "npm run build" to compile TypeScript.',
  );
}

function buildInheritedRules(systemPrompt: string): string {
  const sections = extractPromptSections(systemPrompt, INHERITED_SECTIONS);
  return Object.entries(sections)
    .map(([name, content]) => `## ${name}\n\n${content}`)
    .join('\n\n');
}

async function serve(serveArgs: string[]): Promise<void> {
  const config = resolveConfig();

  // Parse --port and --token overrides
  const portFlagIndex = serveArgs.indexOf('--port');
  const port =
    portFlagIndex !== -1
      ? parseInt(serveArgs[portFlagIndex + 1] ?? String(config.channels.web.port), 10)
      : config.channels.web.port;
  if (isNaN(port)) {
    process.stderr.write('bolt serve: --port must be a number\n');
    process.exit(1);
  }
  const tokenFlagIndex = serveArgs.indexOf('--token');
  const token =
    tokenFlagIndex !== -1
      ? (serveArgs[tokenFlagIndex + 1] ?? undefined)
      : config.channels.web.token;
  const hostFlagIndex = serveArgs.indexOf('--host');
  const host =
    hostFlagIndex !== -1 ? (serveArgs[hostFlagIndex + 1] ?? undefined) : config.channels.web.host;

  const auth = resolveAuth();
  const client = createAnthropicClient(auth);

  const cwd = config.workspace.root;
  const dataDir = resolve(cwd, config.dataDir);

  const log = createAuditLogger(dataDir);
  const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));
  const traceLogger = config.logTrace ? createTraceLogger(cwd) : createNoopTraceLogger();

  const todoStore = new TodoStore();
  const taskRegistry = new TaskRegistry(dataDir);
  await taskRegistry.loadActiveProjects();

  const sessionsDir = join(dataDir, config.memory.sessionPath);
  const sessionStore = new SessionStore(sessionsDir, logger);
  const memoryStoreDir = join(dataDir, config.memory.storePath);
  const corruptedDir = join(dataDir, 'corrupted');
  const memoryStore = new MemoryStore(memoryStoreDir, corruptedDir, logger);
  await memoryStore.loadAll();
  const memoryManager = new MemoryManager(
    sessionStore,
    config.memory,
    logger,
    memoryStore,
    client,
    config.model,
  );

  const toolBus = new ToolBus(logger);
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(fileSearchTool);
  toolBus.register(globTool);
  toolBus.register(fileInsertTool);
  toolBus.register(webFetchTool);
  for (const tool of createTodoTools(todoStore)) toolBus.register(tool);
  for (const tool of createTaskTools(taskRegistry)) toolBus.register(tool);
  toolBus.register(createMemorySearchTool(memoryStore));
  toolBus.register(createMemoryWriteTool(memoryStore));
  const { scriptPath: subagentScript, execPath: subagentExec } = resolveSubagentScript();

  logger.debug('Subagent script resolved', { scriptPath: subagentScript, execPath: subagentExec });

  const projectSkillsDir = join(dataDir, 'skills');
  const userSkillsDir = join(homedir(), '.bolt', 'skills');
  const builtinSkillsDir = join(__dirname, '../skills');
  const skills = await loadSkills(
    projectSkillsDir,
    userSkillsDir,
    (msg) => logger.warn(msg),
    builtinSkillsDir,
  );

  const allTools = toolBus.list();
  const systemPrompt = await assembleSystemPrompt(config, skills, allTools, logger, traceLogger);

  const estimatedTokens = estimateTokenCount(systemPrompt);
  if (estimatedTokens > config.agentPrompt.maxTokens) {
    logger.warn('System prompt exceeds token threshold', {
      estimatedTokens,
      threshold: config.agentPrompt.maxTokens,
    });
    process.stderr.write(
      `Warning: system prompt estimated ${estimatedTokens} tokens (threshold: ${config.agentPrompt.maxTokens}). Consider reducing AGENT.md size.\n`,
    );
  }

  const inheritedRules = buildInheritedRules(systemPrompt);

  toolBus.register(
    createSubagentRunTool(
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
      () => systemPrompt,
      logger,
    ),
  );
  toolBus.register(
    createSkillRunTool(
      skills,
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
      inheritedRules,
      logger,
    ),
  );
  const slashRegistry = createSlashCommandRegistry();
  slashRegistry.register(createSkillsSlashCommand(skills));
  slashRegistry.register(
    createRunSkillSlashCommand(
      skills,
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
    ),
  );
  slashRegistry.register({
    name: 'exit',
    description: 'Not available in daemon mode.',
    async execute(_args, ctx) {
      await ctx.send('/exit is not available from the web UI. Stop the server from the console.');
      return {};
    },
  });

  const channel = new WebChannel(
    {
      port,
      host,
      token,
      mode: config.channels.web.mode,
      enabled: true,
      workspaceRoot: cwd,
      persistent: true,
    },
    logger,
  );

  const progress = new WebChannelProgressReporter(
    (text) => channel.sendProgress(text),
    (event) => channel.sendSubagentStatus(event.skill, event.status, event.durationMs, event.error),
  );
  const ctx = {
    cwd,
    log,
    logger,
    progress,
    channel,
  };

  const agent = new AgentCore(
    client,
    channel,
    toolBus,
    ctx,
    config,
    systemPrompt,
    undefined,
    logger,
    traceLogger,
    sessionStore,
    undefined,
    memoryManager,
    slashRegistry,
  );

  const searchProvider = createSearchProvider(config);
  await validateSearchProvider(searchProvider, logger);
  toolBus.register(createWebSearchTool(searchProvider, config.search.maxResults));
  toolBus.register(createUserReviewTool());

  const userWorkflowsDir = join(dataDir, 'workflows');
  let comfyuiPool: ComfyUIPool | null = null;
  if (config.comfyui.servers.length > 0) {
    comfyuiPool = new ComfyUIPool(config.comfyui, userWorkflowsDir, cwd, logger, progress);
    await comfyuiPool.init();
  }
  toolBus.register(createComfyUIText2ImgTool(comfyuiPool, config.comfyui.timeoutMs));
  toolBus.register(createComfyUIImg2VideoTool(comfyuiPool, config.comfyui.timeoutMs));

  const ffmpegPath = await FfmpegRunner.detect(config.ffmpeg.path);
  if (ffmpegPath) {
    logger.info('FFmpeg detected', { path: ffmpegPath });
  } else {
    logger.warn('FFmpeg not found; video tools will be unavailable');
  }
  const ffmpegRunner = ffmpegPath ? new FfmpegRunner(ffmpegPath, config.ffmpeg, cwd) : null;
  toolBus.register(createVideoMergeTool(ffmpegRunner));
  toolBus.register(createVideoAddAudioTool(ffmpegRunner));
  toolBus.register(createVideoAddSubtitlesTool(ffmpegRunner));

  for (const tool of createContentProjectTools(taskRegistry)) toolBus.register(tool);

  logger.info('Tools registered', {
    count: toolBus.list().length,
    tools: toolBus.list().map((t) => t.name),
  });
  logger.info('Skills loaded', { count: skills.length, skills: skills.map((s) => s.name) });

  const shutdown = async (): Promise<void> => {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
    logger.info('Shutdown initiated');
    process.stderr.write('\nbolt serve: shutting down gracefully...\n');
    await channel.stop();
    logger.info('Shutdown complete');
    process.exit(0);
  };
  const handleSignal = (signal: string): void => {
    logger.info('Signal received', { signal });
    shutdown().catch((err: unknown) => {
      logger.error('Shutdown error', { error: err instanceof Error ? err.message : String(err) });
      process.stderr.write(
        `bolt serve: shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  await channel.listen();
  const boundHost = host ?? '127.0.0.1';
  logger.info('bolt serve started', {
    port,
    host: boundHost,
    model: config.model,
    auth: auth.mode,
  });
  process.stderr.write(
    `bolt serve: listening on http://${boundHost}:${port} (model: ${config.model})\n`,
  );

  await agent.run();
  await shutdown();
}

async function main(): Promise<void> {
  const config = resolveConfig();
  const args = process.argv.slice(2);

  if (args[0] === 'serve') {
    await serve(args.slice(1));
    return;
  }

  const auth = resolveAuth();
  const client = createAnthropicClient(auth);

  const cwd = config.workspace.root;
  // Resolve dataDir to an absolute path so audit logger and future components
  // are not sensitive to cwd changes after startup.
  const dataDir = resolve(cwd, config.dataDir);

  const log = createAuditLogger(dataDir);
  const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));
  const traceLogger = config.logTrace ? createTraceLogger(cwd) : createNoopTraceLogger();

  const verbose = args.includes('--verbose') || config.cli.verbose;
  const quiet = args.includes('--quiet') || !config.cli.progress;

  const sessionFlagIndex = args.indexOf('--session');
  const sessionId = sessionFlagIndex !== -1 ? args[sessionFlagIndex + 1] : undefined;

  const progress = new CliProgressReporter(process.stdout, verbose, quiet);

  const todoStore = new TodoStore();
  const taskRegistry = new TaskRegistry(dataDir);
  await taskRegistry.loadActiveProjects();

  const sessionsDir = join(dataDir, config.memory.sessionPath);
  const sessionStore = new SessionStore(sessionsDir, logger);
  const memoryStoreDir = join(dataDir, config.memory.storePath);
  const corruptedDir = join(dataDir, 'corrupted');
  const memoryStore = new MemoryStore(memoryStoreDir, corruptedDir, logger);
  await memoryStore.loadAll();
  const memoryManager = new MemoryManager(
    sessionStore,
    config.memory,
    logger,
    memoryStore,
    client,
    config.model,
  );

  const toolBus = new ToolBus(logger);
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(fileSearchTool);
  toolBus.register(globTool);
  toolBus.register(fileInsertTool);
  toolBus.register(webFetchTool);
  for (const tool of createTodoTools(todoStore)) toolBus.register(tool);
  for (const tool of createTaskTools(taskRegistry)) toolBus.register(tool);
  toolBus.register(createMemorySearchTool(memoryStore));
  toolBus.register(createMemoryWriteTool(memoryStore));
  const { scriptPath: subagentScript, execPath: subagentExec } = resolveSubagentScript();

  logger.debug('Subagent script resolved', { scriptPath: subagentScript, execPath: subagentExec });

  const projectSkillsDir = join(dataDir, 'skills');
  const userSkillsDir = join(homedir(), '.bolt', 'skills');
  const builtinSkillsDir = join(__dirname, '../skills');
  const skills = await loadSkills(
    projectSkillsDir,
    userSkillsDir,
    (msg) => logger.warn(msg),
    builtinSkillsDir,
  );

  const allTools = toolBus.list();
  const systemPrompt = await assembleSystemPrompt(config, skills, allTools, logger, traceLogger);

  const estimatedTokens = estimateTokenCount(systemPrompt);
  if (estimatedTokens > config.agentPrompt.maxTokens) {
    logger.warn('System prompt exceeds token threshold', {
      estimatedTokens,
      threshold: config.agentPrompt.maxTokens,
    });
    process.stderr.write(
      `Warning: system prompt estimated ${estimatedTokens} tokens (threshold: ${config.agentPrompt.maxTokens}). Consider reducing AGENT.md size.\n`,
    );
  }

  const inheritedRules = buildInheritedRules(systemPrompt);

  toolBus.register(
    createSubagentRunTool(
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
      () => systemPrompt,
      logger,
    ),
  );
  toolBus.register(
    createSkillRunTool(
      skills,
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
      inheritedRules,
      logger,
    ),
  );
  const slashRegistry = createSlashCommandRegistry();
  slashRegistry.register(createSkillsSlashCommand(skills));
  slashRegistry.register(
    createRunSkillSlashCommand(
      skills,
      auth,
      config.model,
      subagentScript,
      subagentExec,
      runSubagent,
    ),
  );
  const channel = new CliChannel(process.stdin, process.stdout, () =>
    progress.clearPendingThinking(),
  );
  const ctx = {
    cwd,
    log,
    logger,
    progress,
    channel,
    confirm: (message: string) =>
      channel.question(`\n${message}\nType "y" to confirm: `).then((a) => {
        const answer = a.trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      }),
  };
  const agent = new AgentCore(
    client,
    channel,
    toolBus,
    ctx,
    config,
    systemPrompt,
    undefined,
    logger,
    traceLogger,
    sessionStore,
    sessionId,
    memoryManager,
    slashRegistry,
  );

  let _cleanupWatcher: (() => void) | null = null;
  if (config.agentPrompt.watchForChanges && process.stdout.isTTY) {
    _cleanupWatcher = watchAgentPrompt(config, async () => {
      const newPrompt = await assembleSystemPrompt(config, skills, toolBus.list(), logger);
      logger.info('System prompt reloaded after AGENT.md change');
      agent.updateSystemPrompt(newPrompt);
    });
  }

  const searchProvider = createSearchProvider(config);
  await validateSearchProvider(searchProvider, logger);
  toolBus.register(createWebSearchTool(searchProvider, config.search.maxResults));
  toolBus.register(createUserReviewTool());

  const userWorkflowsDir = join(dataDir, 'workflows');
  let comfyuiPool: ComfyUIPool | null = null;
  if (config.comfyui.servers.length > 0) {
    comfyuiPool = new ComfyUIPool(config.comfyui, userWorkflowsDir, cwd, logger, progress);
    await comfyuiPool.init();
  }
  toolBus.register(createComfyUIText2ImgTool(comfyuiPool, config.comfyui.timeoutMs));
  toolBus.register(createComfyUIImg2VideoTool(comfyuiPool, config.comfyui.timeoutMs));

  const ffmpegPath = await FfmpegRunner.detect(config.ffmpeg.path);
  if (ffmpegPath) {
    logger.info('FFmpeg detected', { path: ffmpegPath });
  } else {
    logger.warn('FFmpeg not found; video tools will be unavailable');
  }
  const ffmpegRunner = ffmpegPath ? new FfmpegRunner(ffmpegPath, config.ffmpeg, cwd) : null;
  toolBus.register(createVideoMergeTool(ffmpegRunner));
  toolBus.register(createVideoAddAudioTool(ffmpegRunner));
  toolBus.register(createVideoAddSubtitlesTool(ffmpegRunner));

  for (const tool of createContentProjectTools(taskRegistry)) toolBus.register(tool);

  logger.info('Tools registered', {
    count: toolBus.list().length,
    tools: toolBus.list().map((t) => t.name),
  });
  logger.info('Skills loaded', { count: skills.length, skills: skills.map((s) => s.name) });

  logger.info('bolt started', { model: config.model, auth: auth.mode, logLevel: config.logLevel });

  process.stderr.write(`bolt ready (model: ${config.model}, auth: ${auth.mode})\n`);
  process.stderr.write('Type a message and press Enter. Ctrl+D to exit.\n\n');

  await agent.run();
  _cleanupWatcher?.();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
