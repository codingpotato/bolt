/**
 * Slash command system.
 *
 * Messages that start with `/` are intercepted by AgentCore before they reach
 * the LLM. The SlashCommandRegistry dispatches them to registered handlers.
 */

/** Execution context provided to every slash command handler. */
export interface SlashContext {
  /** Write output back to the user. */
  send(message: string): Promise<void>;
  /** The current session ID. */
  sessionId: string;
}

/** Value returned by a slash command handler. */
export interface SlashResult {
  /** When true, the agent loop terminates after this command. */
  exit?: boolean;
}

/** A single registered slash command. */
export interface SlashCommand {
  /** Command name without the leading /. Case-insensitive during lookup. */
  name: string;
  /** One-line description shown by /help. */
  description: string;
  execute(args: string[], ctx: SlashContext): Promise<SlashResult>;
}

export class SlashCommandRegistry {
  private readonly commands: Map<string, SlashCommand> = new Map();

  register(cmd: SlashCommand): void {
    this.commands.set(cmd.name.toLowerCase(), cmd);
  }

  /** Returns all registered commands in registration order. */
  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  /** Returns true if the message starts with a slash command prefix. */
  isSlashCommand(message: string): boolean {
    return message.trimStart().startsWith('/');
  }

  /**
   * Parse and dispatch a slash command message.
   * Always returns a SlashResult — unknown commands send an error message and
   * return `{}` rather than throwing.
   */
  async dispatch(message: string, ctx: SlashContext): Promise<SlashResult> {
    const trimmed = message.trim();
    // Strip leading slash and split on whitespace
    const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
    const name = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    const cmd = this.commands.get(name);
    if (!cmd) {
      const cmdList = this.list()
        .map((c) => `  /${c.name} — ${c.description}`)
        .join('\n');
      await ctx.send(`Unknown command: /${name}\n\nAvailable commands:\n${cmdList}`);
      return {};
    }

    return cmd.execute(args, ctx);
  }
}

/**
 * Create a SlashCommandRegistry pre-loaded with the built-in commands:
 * /help, /exit, /session.
 */
export function createSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry();

  registry.register({
    name: 'help',
    description: 'List available slash commands.',
    async execute(_args, ctx) {
      const lines = registry.list().map((c) => `  /${c.name} — ${c.description}`);
      await ctx.send(`Slash commands:\n${lines.join('\n')}`);
      return {};
    },
  });

  registry.register({
    name: 'exit',
    description: 'Exit the agent.',
    async execute(_args, _ctx) {
      return { exit: true };
    },
  });

  registry.register({
    name: 'session',
    description: 'Show the current session ID.',
    async execute(_args, ctx) {
      await ctx.send(`Session ID: ${ctx.sessionId}`);
      return {};
    },
  });

  return registry;
}
