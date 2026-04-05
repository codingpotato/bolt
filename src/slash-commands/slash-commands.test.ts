import { describe, it, expect, vi } from 'vitest';
import { SlashCommandRegistry, createSlashCommandRegistry } from './slash-commands';
import type { SlashContext } from './slash-commands';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionId = 'test-session-id'): {
  ctx: SlashContext;
  sendSpy: ReturnType<typeof vi.fn>;
} {
  const sendSpy = vi.fn().mockResolvedValue(undefined);
  return { ctx: { send: sendSpy, sessionId }, sendSpy };
}

// ---------------------------------------------------------------------------
// SlashCommandRegistry
// ---------------------------------------------------------------------------

describe('SlashCommandRegistry', () => {
  it('isSlashCommand returns true for messages starting with /', () => {
    const r = new SlashCommandRegistry();
    expect(r.isSlashCommand('/exit')).toBe(true);
    expect(r.isSlashCommand('/help me')).toBe(true);
  });

  it('isSlashCommand returns true when leading whitespace precedes /', () => {
    const r = new SlashCommandRegistry();
    expect(r.isSlashCommand('  /exit')).toBe(true);
  });

  it('isSlashCommand returns false for normal messages', () => {
    const r = new SlashCommandRegistry();
    expect(r.isSlashCommand('hello')).toBe(false);
    expect(r.isSlashCommand('what is /tmp?')).toBe(false);
    expect(r.isSlashCommand('')).toBe(false);
  });

  it('dispatches a registered command', async () => {
    const r = new SlashCommandRegistry();
    const handler = vi.fn().mockResolvedValue({ exit: false });
    r.register({ name: 'ping', description: 'Ping.', execute: handler });

    const { ctx } = makeCtx();
    await r.dispatch('/ping', ctx);

    expect(handler).toHaveBeenCalledWith([], ctx);
  });

  it('passes args to the command handler', async () => {
    const r = new SlashCommandRegistry();
    const handler = vi.fn().mockResolvedValue({});
    r.register({ name: 'go', description: 'Go somewhere.', execute: handler });

    const { ctx } = makeCtx();
    await r.dispatch('/go fast far', ctx);

    expect(handler).toHaveBeenCalledWith(['fast', 'far'], ctx);
  });

  it('command lookup is case-insensitive', async () => {
    const r = new SlashCommandRegistry();
    const handler = vi.fn().mockResolvedValue({});
    r.register({ name: 'ping', description: 'Ping.', execute: handler });

    const { ctx } = makeCtx();
    await r.dispatch('/PING', ctx);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('sends an error and lists commands for unknown command', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'ping', description: 'Ping.', execute: vi.fn().mockResolvedValue({}) });

    const { ctx, sendSpy } = makeCtx();
    const result = await r.dispatch('/unknown', ctx);

    expect(result).toEqual({});
    expect(sendSpy).toHaveBeenCalledOnce();
    const msg = (sendSpy.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Unknown command: /unknown');
    expect(msg).toContain('/ping');
  });

  it('list() returns all registered commands', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'a', description: 'A.', execute: vi.fn().mockResolvedValue({}) });
    r.register({ name: 'b', description: 'B.', execute: vi.fn().mockResolvedValue({}) });

    expect(r.list().map((c) => c.name)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// createSlashCommandRegistry — built-in commands
// ---------------------------------------------------------------------------

describe('createSlashCommandRegistry', () => {
  it('registers /help, /exit, and /session', () => {
    const r = createSlashCommandRegistry();
    const names = r.list().map((c) => c.name);
    expect(names).toContain('help');
    expect(names).toContain('exit');
    expect(names).toContain('session');
  });

  describe('/help', () => {
    it('sends a list of available commands', async () => {
      const r = createSlashCommandRegistry();
      const { ctx, sendSpy } = makeCtx();
      await r.dispatch('/help', ctx);

      expect(sendSpy).toHaveBeenCalledOnce();
      const msg = (sendSpy.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('/help');
      expect(msg).toContain('/exit');
      expect(msg).toContain('/session');
    });

    it('does not signal exit', async () => {
      const r = createSlashCommandRegistry();
      const { ctx } = makeCtx();
      const result = await r.dispatch('/help', ctx);
      expect(result.exit).toBeFalsy();
    });
  });

  describe('/exit', () => {
    it('returns exit: true', async () => {
      const r = createSlashCommandRegistry();
      const { ctx } = makeCtx();
      const result = await r.dispatch('/exit', ctx);
      expect(result.exit).toBe(true);
    });

    it('does not send any output', async () => {
      const r = createSlashCommandRegistry();
      const { ctx, sendSpy } = makeCtx();
      await r.dispatch('/exit', ctx);
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  describe('/session', () => {
    it('sends the current session ID', async () => {
      const r = createSlashCommandRegistry();
      const { ctx, sendSpy } = makeCtx('abc-123');
      await r.dispatch('/session', ctx);

      expect(sendSpy).toHaveBeenCalledOnce();
      expect((sendSpy.mock.calls[0] as unknown[])[0]).toContain('abc-123');
    });

    it('does not signal exit', async () => {
      const r = createSlashCommandRegistry();
      const { ctx } = makeCtx();
      const result = await r.dispatch('/session', ctx);
      expect(result.exit).toBeFalsy();
    });
  });
});
