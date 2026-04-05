import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, createNoopLogger } from './logger';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/test-bolt.log';
const LOG_DIR = '/tmp';

/** Flush the microtask queue so fire-and-forget promises settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Parse the first JSON line passed to appendFile. */
function lastEntry(): Record<string, unknown> {
  const calls = vi.mocked(fsPromises.appendFile).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('appendFile was not called');
  return JSON.parse(last[1] as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  beforeEach(() => {
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.appendFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── entry format ──────────────────────────────────────────────────────────

  describe('log entry format', () => {
    it('writes a JSON line ending with \\n to the configured file path', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('hello');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
      const [path, content] = vi.mocked(fsPromises.appendFile).mock.calls[0]!;
      expect(path).toBe(LOG_PATH);
      expect((content as string).endsWith('\n')).toBe(true);
    });

    it('entry is valid JSON', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('hello');
      await flush();

      const [, content] = vi.mocked(fsPromises.appendFile).mock.calls[0]!;
      expect(() => JSON.parse(content as string)).not.toThrow();
    });

    it('entry contains ts, level, and message fields', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('something happened');
      await flush();

      const entry = lastEntry();
      expect(entry).toHaveProperty('ts');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('message');
    });

    it('ts is a valid ISO 8601 timestamp', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('time check');
      await flush();

      const entry = lastEntry();
      const ts = entry['ts'] as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('level field matches the method called', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('test warn');
      await flush();

      expect(lastEntry()['level']).toBe('warn');
    });

    it('message field contains the supplied message', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('my message');
      await flush();

      expect(lastEntry()['message']).toBe('my message');
    });

    it('meta fields are spread into the entry at the top level', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('request sent', { requestId: 'abc-123', model: 'claude-test' });
      await flush();

      const entry = lastEntry();
      expect(entry['requestId']).toBe('abc-123');
      expect(entry['model']).toBe('claude-test');
    });

    it('entry without meta has only ts, level, and message', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('bare message');
      await flush();

      const entry = lastEntry();
      expect(Object.keys(entry).sort()).toEqual(['level', 'message', 'ts'].sort());
    });
  });

  // ── level filtering ───────────────────────────────────────────────────────

  describe('level filtering', () => {
    it('drops entries below the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.debug('too low');
      logger.info('also too low');
      await flush();

      expect(fsPromises.appendFile).not.toHaveBeenCalled();
    });

    it('writes entries at the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.warn('exactly at threshold');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
    });

    it('writes entries above the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.error('above threshold');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
    });

    it('debug logger writes all four levels', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledTimes(4);
    });

    it('error logger only writes error entries', async () => {
      const logger = createLogger('error', LOG_PATH);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledTimes(1);
      expect(lastEntry()['level']).toBe('error');
    });

    it('each level method writes the correct level string', async () => {
      const logger = createLogger('debug', LOG_PATH);
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.mocked(fsPromises.appendFile).mockClear();
        logger[level](`${level} message`);
        await flush();
        expect(lastEntry()['level']).toBe(level);
      }
    });
  });

  // ── stderr routing ────────────────────────────────────────────────────────

  describe('stderr routing', () => {
    let stderrSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true) as unknown as typeof stderrSpy;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('error-level entries write to stderr', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.error('something broke');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('something broke');
    });

    it('stderr output includes the [bolt] ERROR prefix in production mode', async () => {
      const logger = createLogger('info', LOG_PATH);
      logger.error('boom');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('[bolt] ERROR:');
    });

    it('debug entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('quiet');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('DBG');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('quiet');
    });

    it('info entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('informational');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('INF');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('informational');
    });

    it('warn entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('warning');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('WRN');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('warning');
    });

    it('production mode only writes error to stderr', async () => {
      const logger = createLogger('info', LOG_PATH);
      logger.debug('quiet');
      logger.info('informational');
      logger.warn('warning');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ── directory creation ────────────────────────────────────────────────────

  describe('directory creation', () => {
    it('creates the log directory on the first write', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('first write');
      await flush();

      expect(fsPromises.mkdir).toHaveBeenCalledOnce();
      expect(fsPromises.mkdir).toHaveBeenCalledWith(LOG_DIR, { recursive: true });
    });

    it('creates the directory only once across multiple writes', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('a');
      logger.info('b');
      logger.info('c');
      await flush();

      expect(fsPromises.mkdir).toHaveBeenCalledOnce();
    });

    it('does not create the directory when all entries are filtered out', async () => {
      const logger = createLogger('error', LOG_PATH);
      logger.debug('filtered');
      await flush();

      expect(fsPromises.mkdir).not.toHaveBeenCalled();
    });
  });

  // ── error resilience ──────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('swallows file write errors without throwing to the caller', async () => {
      vi.mocked(fsPromises.appendFile).mockRejectedValue(new Error('disk full'));
      const logger = createLogger('debug', LOG_PATH);

      // Should not throw — fire-and-forget
      expect(() => logger.info('test')).not.toThrow();
      await flush(); // let the promise settle
    });

    it('swallows mkdir errors without throwing to the caller', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('permission denied'));
      const logger = createLogger('debug', LOG_PATH);

      expect(() => logger.info('test')).not.toThrow();
      await flush();
    });
  });
});

// ---------------------------------------------------------------------------

describe('createNoopLogger', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never calls appendFile', async () => {
    const logger = createNoopLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await flush();

    expect(fsPromises.appendFile).not.toHaveBeenCalled();
  });

  it('all four methods are callable without throwing', () => {
    const logger = createNoopLogger();
    expect(() => {
      logger.debug('d', { x: 1 });
      logger.info('i', { x: 1 });
      logger.warn('w', { x: 1 });
      logger.error('e', { x: 1 });
    }).not.toThrow();
  });
});
