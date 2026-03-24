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
import { loadAgentPrompt, expandTilde } from '../agent-prompt/agent-prompt';
import { CliProgressReporter } from '../progress';
import { SessionStore } from '../memory/session-store';
import { MemoryStore } from '../memory/memory-store';
import { MemoryManager } from '../memory/memory-manager';
import { createMemorySearchTool } from '../tools/memory-search';
import { createMemoryWriteTool } from '../tools/memory-write';
import { createAgentSuggestTool } from '../tools/agent-suggest';
import { SuggestionStore } from '../suggestions/suggestion-store';
import { handleSuggestionsCli } from '../suggestions/suggestions-cli';
import { createSubagentRunTool } from '../tools/subagent-run';
import { createSkillRunTool } from '../tools/skill-run';
import { runSubagent } from '../subagent/subagent-runner';
import { loadSkills } from '../skills/skill-loader';
import { createSkillsSlashCommand } from '../skills/skills-slash-command';
import { createRunSkillSlashCommand } from '../skills/run-skill-slash-command';
import { createSlashCommandRegistry } from '../slash-commands/slash-commands';
import { createSearchProvider, validateSearchProvider } from '../search';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

async function main(): Promise<void> {
  const config = resolveConfig();
  const args = process.argv.slice(2);

  // Dispatch 'bolt suggestions [...]' sub-command before starting the agent.
  if (args[0] === 'suggestions') {
    const cwd = process.cwd();
    const dataDir = resolve(cwd, config.dataDir);
    const suggestionsDir = resolve(cwd, config.agentPrompt.suggestionsPath);
    const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));
    const store = new SuggestionStore(suggestionsDir, logger);
    const paths = {
      project: resolve(cwd, config.agentPrompt.projectFile),
      user: expandTilde(config.agentPrompt.userFile),
    };
    await handleSuggestionsCli(args.slice(1), store, paths, (s) => process.stdout.write(s + '\n'));
    return;
  }


  const auth = resolveAuth();
  const client = createAnthropicClient(auth);

  const cwd = process.cwd();
  // Resolve dataDir to an absolute path so audit logger and future components
  // are not sensitive to cwd changes after startup.
  const dataDir = resolve(cwd, config.dataDir);

  const log = createAuditLogger(dataDir);
  const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));

  // Parse progress-related CLI flags (override config defaults).
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
  const memoryStoreDir = join(dataDir, config.memory.storePath);
  const corruptedDir = join(dataDir, 'corrupted');
  const memoryStore = new MemoryStore(memoryStoreDir, corruptedDir, logger);
  await memoryStore.loadAll();
  const memoryManager = new MemoryManager(sessionStore, config.memory, logger, memoryStore, client, config.model);

  const toolBus = new ToolBus();
  toolBus.register(bashTool);
  toolBus.register(fileReadTool);
  toolBus.register(fileWriteTool);
  toolBus.register(fileEditTool);
  toolBus.register(webFetchTool);
  for (const tool of createTodoTools(todoStore)) toolBus.register(tool);
  for (const tool of createTaskTools(taskStore)) toolBus.register(tool);
  toolBus.register(createMemorySearchTool(memoryStore));
  toolBus.register(createMemoryWriteTool(memoryStore));
  const suggestionsDir = resolve(cwd, config.agentPrompt.suggestionsPath);
  const suggestionStore = new SuggestionStore(suggestionsDir, logger);
  toolBus.register(createAgentSuggestTool(suggestionStore, suggestionsDir));
  const subagentScript = join(__dirname, 'subagent.js');
  toolBus.register(createSubagentRunTool(auth, config.model, subagentScript, runSubagent));

  const projectSkillsDir = join(dataDir, 'skills');
  const userSkillsDir = join(homedir(), '.bolt', 'skills');
  // Built-in skills are co-located with this file in src/skills/ (dev) or dist/skills/ (prod).
  const builtinSkillsDir = join(__dirname, '../skills');
  const skills = await loadSkills(projectSkillsDir, userSkillsDir, (msg) => logger.warn(msg), builtinSkillsDir);
  toolBus.register(createSkillRunTool(skills, auth, config.model, subagentScript, runSubagent));
  const slashRegistry = createSlashCommandRegistry();
  slashRegistry.register(createSkillsSlashCommand(skills));
  slashRegistry.register(createRunSkillSlashCommand(skills, auth, config.model, subagentScript, runSubagent));

  const channel = new CliChannel(process.stdin, process.stdout, () => progress.clearPendingThinking());
  const ctx = {
    cwd,
    log,
    logger,
    progress,
    confirm: (message: string) =>
      channel.question(`\n${message}\nType "y" to confirm: `).then((a) => {
        const answer = a.trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      }),
  };
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
    slashRegistry,
  );

  const searchProvider = createSearchProvider(config);
  await validateSearchProvider(searchProvider, logger);

  logger.info('bolt started', { model: config.model, auth: auth.mode, logLevel: config.logLevel });

  process.stderr.write(`bolt ready (model: ${config.model}, auth: ${auth.mode})\n`);
  process.stderr.write('Type a message and press Enter. Ctrl+D to exit.\n\n');

  await agent.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
