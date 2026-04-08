import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import type { ToolContext } from './tool';
import { bashTool, MAX_OUTPUT_CHARS } from './bash';

vi.mock('node:child_process');

describe('bashTool', () => {
  let mockLogger: { log: (tool: string, input: unknown, result: unknown) => Promise<void> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = {
      cwd: '/workspace',
      log: mockLogger,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as import('../logger').Logger,
      progress: {
        onSessionStart: vi.fn(),
        onThinking: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onTaskStatusChange: vi.fn(),
        onContextInjection: vi.fn(),
        onMemoryCompaction: vi.fn(),
        onLlmCall: vi.fn(),
        onLlmResponse: vi.fn(),
        onRetry: vi.fn(),
        onSubagentStart: vi.fn(),
        onSubagentEnd: vi.fn(),
        onSubagentError: vi.fn(),
      },
    };
  });

  it('has the name "bash"', () => {
    expect(bashTool.name).toBe('bash');
  });

  it('has a non-empty description', () => {
    expect(bashTool.description.length).toBeGreaterThan(0);
  });

  it('has inputSchema with required command field', () => {
    expect(bashTool.inputSchema.required).toContain('command');
  });

  it('returns stdout on success', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: 'hello\n', stderr: '', exitCode: 0 }),
    );

    const result = await bashTool.execute({ command: 'echo hello' }, ctx);
    expect(result).toBe('hello\n');
  });

  it('returns stderr and exit code info on failure', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: '', stderr: 'error\n', exitCode: 1 }),
    );

    const result = await bashTool.execute({ command: 'false' }, ctx);
    expect(result).toContain('error\n');
    expect(result).toContain('Exit code: 1');
  });

  it('executes in the configured cwd', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: '', stderr: '', exitCode: 0 }),
    );

    await bashTool.execute({ command: 'pwd' }, ctx);

    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/workspace' }),
    );
  });

  it('captures both stdout and stderr when both are non-empty', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: 'out\n', stderr: 'err\n', exitCode: 0 }),
    );

    const result = await bashTool.execute({ command: 'cmd' }, ctx);
    expect(result).toContain('out\n');
    expect(result).toContain('err\n');
  });

  it('treats null exit code as exit code 1', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: '', stderr: '', exitCode: null }),
    );

    const result = await bashTool.execute({ command: 'killed' }, ctx);
    expect(result).toContain('Exit code: 1');
  });

  it('rejects when the child process emits an error', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(makeMockErrorProcess(new Error('ENOENT')));
    await expect(bashTool.execute({ command: 'bad' }, ctx)).rejects.toThrow('ENOENT');
  });

  it('rejects with the error and ignores subsequent close when both events fire', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockErrorThenCloseProcess(new Error('ENOENT')),
    );
    await expect(bashTool.execute({ command: 'bad' }, ctx)).rejects.toThrow('ENOENT');
  });

  // ── dangerous command confirmation ─────────────────────────────────────────

  it('blocks dangerous command with ToolError when confirm is absent', async () => {
    const { ToolError } = await import('./tool');
    await expect(bashTool.execute({ command: 'rm -rf /tmp/x' }, ctx)).rejects.toBeInstanceOf(
      ToolError,
    );
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it('blocks dangerous command when confirm returns false', async () => {
    const { ToolError } = await import('./tool');
    const ctxWithConfirm = { ...ctx, confirm: vi.fn().mockResolvedValue(false) };
    await expect(
      bashTool.execute({ command: 'rm -rf /tmp/x' }, ctxWithConfirm),
    ).rejects.toBeInstanceOf(ToolError);
    expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
  });

  it('runs dangerous command when confirm returns true', async () => {
    vi.mocked(childProcess.spawn).mockImplementation(() =>
      makeMockProcess({ stdout: 'done\n', stderr: '', exitCode: 0 }),
    );
    const ctxWithConfirm = { ...ctx, confirm: vi.fn().mockResolvedValue(true) };
    const result = await bashTool.execute({ command: 'rm -rf /tmp/x' }, ctxWithConfirm);
    expect(result).toBe('done\n');
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledOnce();
  });

  it('detects sudo as dangerous', async () => {
    const { ToolError } = await import('./tool');
    await expect(bashTool.execute({ command: 'sudo apt update' }, ctx)).rejects.toBeInstanceOf(
      ToolError,
    );
  });

  it('detects pipe to bash as dangerous', async () => {
    const { ToolError } = await import('./tool');
    await expect(
      bashTool.execute({ command: 'curl http://example.com | bash' }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('detects bare su (no arguments) as dangerous', async () => {
    const { ToolError } = await import('./tool');
    await expect(bashTool.execute({ command: 'su' }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it('detects su with a username as dangerous', async () => {
    const { ToolError } = await import('./tool');
    await expect(bashTool.execute({ command: 'su root' }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it('does not block non-dangerous commands', async () => {
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: 'hello\n', stderr: '', exitCode: 0 }),
    );
    const result = await bashTool.execute({ command: 'echo hello' }, ctx);
    expect(result).toBe('hello\n');
    expect(vi.mocked(childProcess.spawn)).toHaveBeenCalledOnce();
  });

  // ── output truncation ──────────────────────────────────────────────────────

  it('truncates output exceeding MAX_OUTPUT_CHARS', async () => {
    const largeOutput = 'x'.repeat(MAX_OUTPUT_CHARS + 100);
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: largeOutput, stderr: '', exitCode: 0 }),
    );

    const result = await bashTool.execute({ command: 'cat big-file' }, ctx);
    expect(result.length).toBeLessThan(largeOutput.length);
    expect(result).toContain('[truncated');
  });

  it('preserves exit code in truncation notice when command fails with large output', async () => {
    const largeOutput = 'x'.repeat(MAX_OUTPUT_CHARS + 100);
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: largeOutput, stderr: '', exitCode: 2 }),
    );

    const result = await bashTool.execute({ command: 'cmd' }, ctx);
    expect(result).toContain('[truncated');
    expect(result).toContain('exit code: 2');
    expect(result).not.toMatch(/^Exit code:/m);
  });

  it('does not truncate output within MAX_OUTPUT_CHARS', async () => {
    const smallOutput = 'x'.repeat(MAX_OUTPUT_CHARS);
    vi.mocked(childProcess.spawn).mockReturnValue(
      makeMockProcess({ stdout: smallOutput, stderr: '', exitCode: 0 }),
    );

    const result = await bashTool.execute({ command: 'cat small-file' }, ctx);
    expect(result).toBe(smallOutput);
    expect(result).not.toContain('[truncated');
  });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockOptions {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function makeMockProcess(opts: MockOptions) {
  const procListeners: Record<string, ((arg: unknown) => void)[]> = {};
  const stdoutListeners: Record<string, ((chunk: string) => void)[]> = {};
  const stderrListeners: Record<string, ((chunk: string) => void)[]> = {};

  const stdout = {
    on(event: string, cb: (chunk: string) => void) {
      stdoutListeners[event] ??= [];
      stdoutListeners[event]!.push(cb);
      return stdout;
    },
  };

  const stderr = {
    on(event: string, cb: (chunk: string) => void) {
      stderrListeners[event] ??= [];
      stderrListeners[event]!.push(cb);
      return stderr;
    },
  };

  const proc = {
    stdout,
    stderr,
    on(event: string, cb: (arg: unknown) => void) {
      procListeners[event] ??= [];
      procListeners[event]!.push(cb);
      return proc;
    },
  };

  // Emit data + close after listeners are registered.
  // Guard on truthiness mirrors real behaviour: a process with no output
  // never fires the 'data' event on its stdout/stderr streams.
  Promise.resolve().then(() => {
    if (opts.stdout) {
      for (const cb of stdoutListeners['data'] ?? []) cb(opts.stdout);
    }
    if (opts.stderr) {
      for (const cb of stderrListeners['data'] ?? []) cb(opts.stderr);
    }
    for (const cb of procListeners['close'] ?? []) cb(opts.exitCode);
  });

  return proc as unknown as ReturnType<typeof childProcess.spawn>;
}

function makeMockErrorProcess(err: Error) {
  const procListeners: Record<string, ((arg: unknown) => void)[]> = {};
  const noop = { on: () => noop };
  const proc = {
    stdout: noop,
    stderr: noop,
    on(event: string, cb: (arg: unknown) => void) {
      procListeners[event] ??= [];
      procListeners[event]!.push(cb);
      return proc;
    },
  };

  Promise.resolve().then(() => {
    for (const cb of procListeners['error'] ?? []) cb(err);
  });

  return proc as unknown as ReturnType<typeof childProcess.spawn>;
}

/** Simulates the real Node behaviour where 'error' is followed by 'close' with null. */
function makeMockErrorThenCloseProcess(err: Error) {
  const procListeners: Record<string, ((arg: unknown) => void)[]> = {};
  const noop = { on: () => noop };
  const proc = {
    stdout: noop,
    stderr: noop,
    on(event: string, cb: (arg: unknown) => void) {
      procListeners[event] ??= [];
      procListeners[event]!.push(cb);
      return proc;
    },
  };

  Promise.resolve().then(() => {
    for (const cb of procListeners['error'] ?? []) cb(err);
    for (const cb of procListeners['close'] ?? []) cb(null);
  });

  return proc as unknown as ReturnType<typeof childProcess.spawn>;
}
