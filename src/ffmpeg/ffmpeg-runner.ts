import { execFile, spawn } from 'node:child_process';
import { resolve as resolvePath, sep } from 'node:path';
import { ToolError } from '../tools/tool';
import type { Config } from '../config/config';

export interface FfmpegProgress {
  /** Frames processed so far */
  frame?: number;
  /** Current processing speed (e.g. "2.5x") */
  speed?: string;
  /** Elapsed time string from ffmpeg output */
  time?: string;
}

export interface FfmpegResult {
  /** Absolute path to the output file */
  outputPath: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** FFmpeg stderr output (includes encoding summary) */
  stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

// Matches FFmpeg progress lines:
// frame=  120 fps= 24 q=28.0 size=    1024kB time=00:00:05.00 bitrate=1677.7kbits/s speed=2.5x
const PROGRESS_REGEX = /frame=\s*(\d+).*?time=(\S+).*?speed=(\S+)/;

let cachedBinaryPath: string | null | undefined = undefined;

export class FfmpegRunner {
  constructor(
    private readonly binaryPath: string,
    public readonly config: Config['ffmpeg'],
    private readonly cwd: string,
  ) {}

  /**
   * Resolves the ffmpeg binary path.
   * Priority: explicit configPath → system PATH → null.
   * Result is cached after the first successful resolution.
   */
  static async detect(configPath?: string): Promise<string | null> {
    if (cachedBinaryPath !== undefined) {
      return cachedBinaryPath;
    }
    if (configPath) {
      cachedBinaryPath = configPath;
      return cachedBinaryPath;
    }
    return new Promise((resolve) => {
      execFile('which', ['ffmpeg'], (err, stdout) => {
        if (err) {
          cachedBinaryPath = null;
          resolve(null);
        } else {
          cachedBinaryPath = stdout.trim();
          resolve(cachedBinaryPath);
        }
      });
    });
  }

  /** Reset the detection cache. Used in tests to ensure isolation. */
  static resetCache(): void {
    cachedBinaryPath = undefined;
  }

  /**
   * Assert that filePath is within the workspace root (cwd).
   * Throws a non-retryable ToolError if the path escapes.
   */
  assertWithinWorkspace(filePath: string): void {
    const abs = resolvePath(this.cwd, filePath);
    const boundary = this.cwd.endsWith(sep) ? this.cwd : this.cwd + sep;
    if (!abs.startsWith(boundary)) {
      throw new ToolError(`path "${filePath}" is outside the workspace (${this.cwd})`, false);
    }
  }

  /**
   * Execute an ffmpeg command with the given argument array.
   * The output file path is always the last element of args (FFmpeg convention).
   * Streams stderr progress events to opts.onProgress when provided.
   * Rejects with FfmpegError on non-zero exit, or ToolError on signal/timeout.
   */
  async run(
    args: string[],
    opts: {
      onProgress?: (p: FfmpegProgress) => void;
      timeoutMs?: number;
    } = {},
  ): Promise<FfmpegResult> {
    const startTime = Date.now();
    const stderrChunks: string[] = [];

    return new Promise((resolve, reject) => {
      // -y: overwrite output files without asking
      const child = spawn(this.binaryPath, ['-y', ...args], { cwd: this.cwd });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new ToolError('ffmpeg timed out', true));
        }, opts.timeoutMs);
      }

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrChunks.push(text);
        if (opts.onProgress) {
          const match = PROGRESS_REGEX.exec(text);
          if (match) {
            opts.onProgress({
              frame: match[1] !== undefined ? parseInt(match[1], 10) : undefined,
              time: match[2],
              speed: match[3],
            });
          }
        }
      });

      child.on('error', (err) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        reject(new ToolError(`ffmpeg failed to start: ${err.message}`, false));
      });

      child.on('close', (code, signal) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        const stderr = stderrChunks.join('');

        if (signal !== null) {
          reject(new ToolError(`ffmpeg killed by signal ${signal}`, true));
          return;
        }
        if (code === 0) {
          const outputPath = resolvePath(this.cwd, args.at(-1) ?? '');
          resolve({ outputPath, durationMs: Date.now() - startTime, stderr });
        } else {
          reject(new FfmpegError(`ffmpeg exited with code ${code ?? -1}`, stderr, code ?? -1));
        }
      });
    });
  }
}
