import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { FfmpegRunner, FfmpegError } from './ffmpeg-runner';
import { ToolError } from '../tools/tool';
import type { Config } from '../config/config';

vi.mock('node:child_process');

const DEFAULT_CONFIG: Config['ffmpeg'] = {
  videoCodec: 'libx264',
  crf: 23,
  preset: 'fast',
  audioCodec: 'aac',
  audioBitrate: '128k',
};

// ---------- helpers ----------

type FakeChild = EventEmitter & {
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function makeFakeChild(
  exitCode: number | null = 0,
  signal: string | null = null,
  stderrLines: string[] = [],
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new PassThrough();
  child.kill = vi.fn();

  setImmediate(() => {
    for (const line of stderrLines) {
      child.stderr.push(line);
    }
    child.stderr.push(null);
    child.emit('close', exitCode, signal);
  });

  return child;
}

// ---------- FfmpegRunner.detect ----------

describe('FfmpegRunner.detect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FfmpegRunner.resetCache();
  });

  it('returns the provided configPath immediately without calling which', async () => {
    const path = await FfmpegRunner.detect('/usr/local/bin/ffmpeg');
    expect(path).toBe('/usr/local/bin/ffmpeg');
  });

  it('returns the cached value on subsequent calls without configPath', async () => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation((_cmd, _args, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '/usr/bin/ffmpeg\n', '');
      return {} as ChildProcess;
    });

    const first = await FfmpegRunner.detect();
    const second = await FfmpegRunner.detect();
    expect(first).toBe('/usr/bin/ffmpeg');
    expect(second).toBe('/usr/bin/ffmpeg');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns null and caches null when which fails', async () => {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation((_cmd, _args, cb) => {
      (cb as (err: Error, stdout: string, stderr: string) => void)(
        new Error('not found'),
        '',
        '',
      );
      return {} as ChildProcess;
    });

    const result = await FfmpegRunner.detect();
    expect(result).toBeNull();
    // Second call should return cached null without calling execFile again
    const second = await FfmpegRunner.detect();
    expect(second).toBeNull();
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it('resetCache clears the cache so detect re-runs', async () => {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockImplementation((_cmd, _args, cb) => {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '/usr/bin/ffmpeg\n', '');
      return {} as ChildProcess;
    });

    await FfmpegRunner.detect();
    FfmpegRunner.resetCache();
    await FfmpegRunner.detect();
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(2);
  });
});

// ---------- FfmpegRunner.assertWithinWorkspace ----------

describe('FfmpegRunner.assertWithinWorkspace', () => {
  const runner = new FfmpegRunner('/usr/bin/ffmpeg', DEFAULT_CONFIG, '/workspace');

  it('does not throw for a path inside the workspace', () => {
    expect(() => runner.assertWithinWorkspace('/workspace/clips/clip.mp4')).not.toThrow();
  });

  it('does not throw for a relative path inside the workspace', () => {
    expect(() => runner.assertWithinWorkspace('clips/clip.mp4')).not.toThrow();
  });

  it('throws ToolError (non-retryable) for a path outside the workspace', () => {
    expect(() => runner.assertWithinWorkspace('/etc/passwd')).toThrow(ToolError);
  });

  it('throws for path traversal attempts', () => {
    expect(() =>
      runner.assertWithinWorkspace('/workspace/../../../etc/shadow'),
    ).toThrow(ToolError);
  });

  it('ToolError from workspace violation is non-retryable', () => {
    try {
      runner.assertWithinWorkspace('/etc/passwd');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).retryable).toBe(false);
    }
  });
});

// ---------- FfmpegRunner.run ----------

describe('FfmpegRunner.run', () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
  });

  const runner = new FfmpegRunner('/usr/bin/ffmpeg', DEFAULT_CONFIG, '/workspace');

  it('spawns ffmpeg with -y prepended and returns FfmpegResult on exit 0', async () => {
    const child = makeFakeChild(0, null);
    spawnMock.mockReturnValue(child);

    const result = await runner.run(['-i', '/workspace/input.mp4', '/workspace/output.mp4']);

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-y', '-i', '/workspace/input.mp4', '/workspace/output.mp4'],
      { cwd: '/workspace' },
    );
    expect(result.outputPath).toBe('/workspace/output.mp4');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stderr).toBe('');
  });

  it('resolves outputPath as absolute path relative to cwd', async () => {
    const child = makeFakeChild(0, null);
    spawnMock.mockReturnValue(child);

    const result = await runner.run(['-i', '/workspace/input.mp4', 'output/final.mp4']);
    expect(result.outputPath).toBe('/workspace/output/final.mp4');
  });

  it('parses ffmpeg progress lines and calls onProgress', async () => {
    const progressLine =
      'frame=  120 fps= 24 q=28.0 size=    1024kB time=00:00:05.00 bitrate=1677.7kbits/s speed=2.5x\n';
    const child = makeFakeChild(0, null, [progressLine]);
    spawnMock.mockReturnValue(child);

    const progressEvents: { frame?: number; time?: string; speed?: string }[] = [];
    await runner.run(['/workspace/output.mp4'], {
      onProgress: (p) => progressEvents.push(p),
    });

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0]).toMatchObject({ frame: 120, time: '00:00:05.00', speed: '2.5x' });
  });

  it('collects stderr and includes it in FfmpegResult', async () => {
    const child = makeFakeChild(0, null, ['encoding started\n', 'encoding done\n']);
    spawnMock.mockReturnValue(child);

    const result = await runner.run(['/workspace/output.mp4']);
    expect(result.stderr).toContain('encoding started');
    expect(result.stderr).toContain('encoding done');
  });

  it('rejects with FfmpegError on non-zero exit code', async () => {
    const child = makeFakeChild(1, null, ['Error: codec not found\n']);
    spawnMock.mockReturnValue(child);

    await expect(runner.run(['/workspace/output.mp4'])).rejects.toBeInstanceOf(FfmpegError);
  });

  it('FfmpegError carries exitCode and stderr', async () => {
    const child = makeFakeChild(1, null, ['Error detail\n']);
    spawnMock.mockReturnValue(child);

    try {
      await runner.run(['/workspace/output.mp4']);
    } catch (err) {
      expect(err).toBeInstanceOf(FfmpegError);
      expect((err as FfmpegError).exitCode).toBe(1);
      expect((err as FfmpegError).stderr).toContain('Error detail');
    }
  });

  it('FfmpegError from encoding failure is non-retryable (retryable not set on ToolError)', async () => {
    const child = makeFakeChild(1, null);
    spawnMock.mockReturnValue(child);

    try {
      await runner.run(['/workspace/output.mp4']);
    } catch (err) {
      // FfmpegError is not a ToolError, so no retryable property — the tool layer decides
      expect(err).toBeInstanceOf(FfmpegError);
      expect(err).not.toBeInstanceOf(ToolError);
    }
  });

  it('rejects with retryable ToolError when process is killed by SIGTERM', async () => {
    const child = makeFakeChild(null, 'SIGTERM');
    spawnMock.mockReturnValue(child);

    try {
      await runner.run(['/workspace/output.mp4']);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).retryable).toBe(true);
    }
  });

  it('rejects with retryable ToolError when process is killed by SIGKILL', async () => {
    const child = makeFakeChild(null, 'SIGKILL');
    spawnMock.mockReturnValue(child);

    try {
      await runner.run(['/workspace/output.mp4']);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).retryable).toBe(true);
    }
  });

  it('rejects with retryable ToolError on timeout and kills the process', async () => {
    vi.useFakeTimers();
    // Child that never closes on its own
    const child = new EventEmitter() as FakeChild;
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    const promise = runner.run(['/workspace/output.mp4'], { timeoutMs: 5000 });
    vi.advanceTimersByTime(5001);
    vi.useRealTimers();

    await expect(promise).rejects.toMatchObject({ retryable: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects with non-retryable ToolError when spawn itself fails', async () => {
    // Simulate spawn emitting an 'error' event
    const child = new EventEmitter() as FakeChild;
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);

    setImmediate(() => {
      child.emit('error', new Error('ENOENT'));
    });

    try {
      await runner.run(['/workspace/output.mp4']);
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).retryable).toBe(false);
    }
  });
});

// ---------- FfmpegRunner config exposure ----------

describe('FfmpegRunner config', () => {
  it('exposes config for tools to build codec arguments', () => {
    const runner = new FfmpegRunner('/usr/bin/ffmpeg', DEFAULT_CONFIG, '/workspace');
    expect(runner.config.videoCodec).toBe('libx264');
    expect(runner.config.crf).toBe(23);
    expect(runner.config.preset).toBe('fast');
    expect(runner.config.audioCodec).toBe('aac');
    expect(runner.config.audioBitrate).toBe('128k');
  });
});
