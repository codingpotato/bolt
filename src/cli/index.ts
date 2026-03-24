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
import { createSkillRunTool, buildSkillPrompt } from '../tools/skill-run';
import { runSubagent } from '../subagent/subagent-runner';
import type { SubagentPayload } from '../subagent/subagent-runner'; // type-only
import { loadSkills } from '../skills/skill-loader';
import { createSkillsSlashCommand } from '../skills/skills-slash-command';
import { createSlashCommandRegistry } from '../slash-commands/slash-commands';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

async function main(): Promise<void> {
  const config = resolveConfig();
  const args = process.argv.slice(2);

  // Dispatch 'bolt run-skill <name> [--<arg> <value> ...]' sub-command.
  if (args[0] === 'run-skill') {
    const skillName = args[1];
    if (!skillName) {
      process.stderr.write('Usage: bolt run-skill <skill-name> [--<arg> <value> ...]\n');
      process.exit(1);
    }

    const cwd = process.cwd();
    const dataDir = resolve(cwd, config.dataDir);
    const logger = createLogger(config.logLevel, join(dataDir, 'bolt.log'));
    const projectSkillsDir = join(dataDir, 'skills');
    const userSkillsDir = join(homedir(), '.bolt', 'skills');
    const skills = await loadSkills(projectSkillsDir, userSkillsDir, (msg) => logger.warn(msg));

    const skill = skills.find((s) => s.name === skillName);
    if (!skill) {
      process.stderr.write(`bolt: unknown skill "${skillName}"\n`);
      process.exit(1);
    }

    // Parse --key value pairs from remaining args.
    const skillArgs: Record<string, string> = {};
    const remaining = args.slice(2);
    for (let i = 0; i < remaining.length; i += 2) {
      const key = remaining[i] ?? '';
      const value = remaining[i + 1];
      if (!key.startsWith('--') || value === undefined) {
        process.stderr.write(`bolt: invalid argument "${key}"\n`);
        process.exit(1);
      }
      skillArgs[key.slice(2)] = value;
    }

    // Validate required input fields.
    const required = (skill.inputSchema.required as string[] | undefined) ?? [];
    for (const field of required) {
      if (!(field in skillArgs)) {
        process.stderr.write(`bolt: missing required argument --${field}\n`);
        process.exit(1);
      }
    }

    const auth = resolveAuth();
    const subagentScript = join(__dirname, 'subagent.js');
    const prompt = buildSkillPrompt(skillName, skillArgs, skill.outputSchema);

    const payload: SubagentPayload = {
      prompt,
      authConfig: auth,
      model: config.model,
      systemPrompt: skill.systemPrompt,
      ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
    };

    try {
      const result = await runSubagent(payload, subagentScript);
      process.stdout.write(result.output + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`bolt: skill failed: ${msg}\n`);
      process.exit(1);
    }
    return;
  }

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
  const skills = await loadSkills(projectSkillsDir, userSkillsDir, (msg) => logger.warn(msg));
  toolBus.register(createSkillRunTool(skills, auth, config.model, subagentScript, runSubagent));
  const slashRegistry = createSlashCommandRegistry();
  slashRegistry.register(createSkillsSlashCommand(skills));

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

  logger.info('bolt started', { model: config.model, auth: auth.mode, logLevel: config.logLevel });

  process.stderr.write(`bolt ready (model: ${config.model}, auth: ${auth.mode})\n`);
  process.stderr.write('Type a message and press Enter. Ctrl+D to exit.\n\n');

  await agent.run();
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
