import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSubagent } from './subagent-runner';
import type { SubagentPayload } from './subagent-runner';
import type { AuthConfig } from '../auth/auth';
import { NoopProgressReporter } from '../progress';

vi.mock('node:child_process');

const AUTH: AuthConfig = { mode: 'api-key', credential: 'test-key' };

function makePayload(overrides: Partial<SubagentPayload> = {}): SubagentPayload {
  return {
    prompt: 'Do something',
    authConfig: AUTH,
    model: 'claude-opus-4-6',
    workspaceRoot: '/workspace',
    ...overrides,
  };
}

/** Build a minimal EventEmitter-like mock for child_process streams. */
function makeStream() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(cb);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
    write: vi.fn(),
    end: vi.fn(),
  };
}

function makeChildProcess(exitCode = 0) {
  const stdin = makeStream();
  const stdout = makeStream();
  const stderr = makeStream();
  const closeHandlers: Array<(...args: unknown[]) => void> = [];
  const proc = {
    stdin,
    stdout,
    stderr,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'close') {
        closeHandlers.push(cb);
        // Schedule close after any already-queued data events
        setTimeout(() => {
          for (const h of closeHandlers) h(exitCode);
        }, 0);
      }
      return proc;
    },
  };
  return proc;
}

describe('runSubagent()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the payload to child stdin and closes it', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const result = JSON.stringify({ output: 'task done' });
    setTimeout(() => child.stdout.emit('data', Buffer.from(result)), 0);

    await runSubagent(makePayload(), '/path/to/subagent.js');

    expect(child.stdin.write).toHaveBeenCalledOnce();
    const written = JSON.parse(child.stdin.write.mock.calls[0]?.[0] as string) as SubagentPayload;
    expect(written.prompt).toBe('Do something');
    expect(written.authConfig).toEqual(AUTH);
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('spawns child with node and the script path', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    setTimeout(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' }))), 0);

    await runSubagent(makePayload(), '/path/to/subagent.js');

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/path/to/subagent.js'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  });

  it('returns the output from child stdout', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    setTimeout(
      () => child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'result text' }))),
      0,
    );

    const result = await runSubagent(makePayload(), '/path/to/subagent.js');
    expect(result.output).toBe('result text');
  });

  it('handles chunked stdout by concatenating before parsing', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const full = JSON.stringify({ output: 'chunked result' });
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from(full.slice(0, 10)));
      child.stdout.emit('data', Buffer.from(full.slice(10)));
    }, 0);

    const result = await runSubagent(makePayload(), '/path/to/subagent.js');
    expect(result.output).toBe('chunked result');
  });

  it('throws with stderr on non-zero exit code', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(1);
    vi.mocked(spawn).mockReturnValue(child as never);

    setTimeout(() => {
      child.stderr.emit('data', Buffer.from('Something went wrong'));
    }, 0);

    await expect(runSubagent(makePayload(), '/path/to/subagent.js')).rejects.toThrow(
      'Something went wrong',
    );
  });

  it('throws when child exits 0 but stdout is invalid JSON', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    setTimeout(() => child.stdout.emit('data', Buffer.from('not valid json')), 0);

    await expect(runSubagent(makePayload(), '/path/to/subagent.js')).rejects.toThrow(
      'invalid JSON output',
    );
  });

  it('passes allowedTools in the payload when provided', async () => {
    const { spawn } = await import('node:child_process');
    const child = makeChildProcess(0);
    vi.mocked(spawn).mockReturnValue(child as never);

    setTimeout(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' }))), 0);

    await runSubagent(makePayload({ allowedTools: ['bash', 'file_read'] }), '/path/to/subagent.js');

    const written = JSON.parse(child.stdin.write.mock.calls[0]?.[0] as string) as SubagentPayload;
    expect(written.allowedTools).toEqual(['bash', 'file_read']);
  });

  it('rejects when spawn itself throws', async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    await expect(runSubagent(makePayload(), '/bad/path')).rejects.toThrow(
      'Failed to spawn sub-agent: spawn ENOENT',
    );
  });

  it('rejects with stringified error when spawn throws a non-Error', async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockImplementation(() => {
      throw 'spawn failed string' as never;
    });

    await expect(runSubagent(makePayload(), '/bad/path')).rejects.toThrow(
      'Failed to spawn sub-agent: spawn failed string',
    );
  });

  describe('PROGRESS: line forwarding', () => {
    it('forwards onThinking to progress.onSubagentThinking', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const thinkingSpy = vi.spyOn(progress, 'onSubagentThinking');

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onThinking"}\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(thinkingSpy).toHaveBeenCalledWith('my-skill');
    });

    it('forwards onToolCall to progress.onSubagentToolCall', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const toolCallSpy = vi.spyOn(progress, 'onSubagentToolCall');

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onToolCall","name":"bash","input":{"command":"ls"}}\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(toolCallSpy).toHaveBeenCalledWith('my-skill', 'bash', { command: 'ls' });
    });

    it('forwards onToolResult to progress.onSubagentToolResult', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const toolResultSpy = vi.spyOn(progress, 'onSubagentToolResult');

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onToolResult","name":"bash","success":true,"summary":"exit 0"}\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(toolResultSpy).toHaveBeenCalledWith('my-skill', 'bash', true, 'exit 0');
    });

    it('forwards onRetry to progress.onSubagentRetry', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const retrySpy = vi.spyOn(progress, 'onSubagentRetry');

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onRetry","attempt":1,"maxAttempts":3,"reason":"ECONNREFUSED"}\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(retrySpy).toHaveBeenCalledWith('my-skill', 1, 3, 'ECONNREFUSED');
    });

    it('does not forward non-PROGRESS stderr lines to progress', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const thinkingSpy = vi.spyOn(progress, 'onSubagentThinking');

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('some log message\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(thinkingSpy).not.toHaveBeenCalled();
    });

    it('includes non-PROGRESS stderr in the error message on non-zero exit', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(1);
      vi.mocked(spawn).mockReturnValue(child as never);

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onThinking"}\n'));
        child.stderr.emit('data', Buffer.from('Fatal error occurred\n'));
      }, 0);

      await expect(
        runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, new NoopProgressReporter(), 'my-skill'),
      ).rejects.toThrow('Fatal error occurred');
    });

    it('skips malformed PROGRESS lines without throwing', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();

      setTimeout(() => {
        child.stderr.emit('data', Buffer.from('PROGRESS:not valid json\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await expect(
        runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill'),
      ).resolves.toEqual({ output: 'ok' });
    });

    it('handles stderr chunks that contain multiple lines', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const thinkingSpy = vi.spyOn(progress, 'onSubagentThinking');
      const toolCallSpy = vi.spyOn(progress, 'onSubagentToolCall');

      setTimeout(() => {
        // Two PROGRESS lines in a single data event
        child.stderr.emit('data', Buffer.from(
          'PROGRESS:{"event":"onThinking"}\nPROGRESS:{"event":"onToolCall","name":"bash","input":{}}\n',
        ));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(thinkingSpy).toHaveBeenCalledOnce();
      expect(toolCallSpy).toHaveBeenCalledOnce();
    });

    it('flushes a partial stderr line that has no trailing newline', async () => {
      const { spawn } = await import('node:child_process');
      const child = makeChildProcess(0);
      vi.mocked(spawn).mockReturnValue(child as never);

      const progress = new NoopProgressReporter();
      const thinkingSpy = vi.spyOn(progress, 'onSubagentThinking');

      setTimeout(() => {
        // No trailing newline — flushed on process close
        child.stderr.emit('data', Buffer.from('PROGRESS:{"event":"onThinking"}'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ output: 'ok' })));
      }, 0);

      await runSubagent(makePayload(), '/path/to/subagent.js', process.execPath, progress, 'my-skill');
      expect(thinkingSpy).toHaveBeenCalledWith('my-skill');
    });
  });

  it('rejects when the child process emits an error event', async () => {
    const { spawn } = await import('node:child_process');
    const stdin = makeStream();
    const stdout = makeStream();
    const stderr = makeStream();
    const errorHandlers: Array<(...args: unknown[]) => void> = [];
    const proc = {
      stdin,
      stdout,
      stderr,
      pid: 123,
      on(event: string, cb: (...args: unknown[]) => void) {
        if (event === 'error') errorHandlers.push(cb);
        // never fire 'close' so error fires first
        return proc;
      },
    };
    vi.mocked(spawn).mockReturnValue(proc as never);

    const promise = runSubagent(makePayload(), '/path/to/subagent.js');
    setTimeout(() => {
      for (const h of errorHandlers) h(new Error('EPERM'));
    }, 0);

    await expect(promise).rejects.toThrow('Sub-agent process error: EPERM');
  });
});
