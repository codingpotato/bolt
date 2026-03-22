# Slash Commands

## Goal

Slash commands are user-directed CLI directives that begin with `/`. They are intercepted by the agent loop **before** the message reaches the LLM, so they consume no API tokens and respond immediately.

---

## Format

```
/<command> [args...]
```

Leading whitespace before the `/` is stripped; command names are case-insensitive.

---

## Built-in Commands

| Command | Args | Description |
|---------|------|-------------|
| `/help` | — | List all available slash commands |
| `/exit` | — | Exit the agent cleanly (same effect as Ctrl+D) |
| `/session` | — | Show the current session ID |

---

## How It Works

1. In `AgentCore.run()`, each user turn is checked for a `/` prefix before being sent to the LLM.
2. Matching turns are passed to `SlashCommandRegistry.dispatch()`.
3. The registry parses the command name and trailing args, looks up the handler, and calls `execute()`.
4. The handler returns a `SlashResult`:
   - `exit: true` — causes the agent loop to `break` (clean shutdown).
   - All output is written via `ctx.send()`.
5. Unknown commands send an error message and suggest `/help` — they do **not** crash or reach the LLM.
6. Non-interactive contexts (tests, sub-agents) behave identically — there is no TTY requirement.

---

## Interfaces

```ts
interface SlashCommand {
  /** Command name without the leading /. */
  name: string;
  /** One-line description shown by /help. */
  description: string;
  execute(args: string[], ctx: SlashContext): Promise<SlashResult>;
}

interface SlashContext {
  /** Write output back to the user. */
  send(message: string): Promise<void>;
  /** Current session ID. */
  sessionId: string;
}

interface SlashResult {
  /** When true, the agent loop terminates after this command. */
  exit?: boolean;
}
```

---

## Registration

`createSlashCommandRegistry()` returns a registry pre-loaded with the built-in commands.

Additional commands can be added before `AgentCore.run()`:

```ts
const registry = createSlashCommandRegistry();
registry.register({
  name: 'status',
  description: 'Show agent status.',
  async execute(_args, ctx) {
    await ctx.send(`Session: ${ctx.sessionId}`);
    return {};
  },
});
```

The registry is passed to `AgentCore` as a constructor parameter. If omitted, a default registry with only the built-in commands is created.

---

## What Is NOT a Slash Command

- Regular user messages that happen to contain `/` in the middle (`what is /tmp?`) — only messages whose **first non-whitespace character** is `/` are treated as commands.
- Model-invoked tool calls — the model cannot trigger slash commands.
