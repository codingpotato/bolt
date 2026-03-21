import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveConfig, ConfigError } from './config';

vi.mock('node:fs');

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Remove all bolt-related env vars for a clean slate
    delete process.env['BOLT_MODEL'];
    delete process.env['BOLT_DATA_DIR'];
    delete process.env['BOLT_LOG_LEVEL'];
    delete process.env['BOLT_LOCAL_ENDPOINT'];
    delete process.env['BOLT_LOCAL_API_KEY'];
    delete process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_CHANNEL_ID'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('defaults', () => {
    it('returns defaults when no config file and no env vars', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const config = resolveConfig();

      expect(config.model).toBe('claude-opus-4-6');
      expect(config.dataDir).toBe('.bolt');
      expect(config.logLevel).toBe('info');
      expect(config.memory.compactThreshold).toBe(0.8);
      expect(config.memory.keepRecentMessages).toBe(10);
      expect(config.memory.storePath).toBe('memory');
      expect(config.memory.searchBackend).toBe('keyword');
      expect(config.tasks.maxSubtaskDepth).toBe(5);
      expect(config.tasks.maxRetries).toBe(3);
      expect(config.tools.timeoutMs).toBe(30000);
      expect(config.tools.allowedTools).toEqual([]);
      expect(config.codeWorkflows.testFixRetries).toBe(3);
      expect(config.channels.web.enabled).toBe(false);
      expect(config.channels.web.port).toBe(3000);
      expect(config.channels.web.mode).toBe('websocket');
    });
  });

  describe('config file merging', () => {
    it('overrides defaults with config file values', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          memory: { compactThreshold: 0.9, keepRecentMessages: 20 },
        })
      );

      const config = resolveConfig();

      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.memory.compactThreshold).toBe(0.9);
      expect(config.memory.keepRecentMessages).toBe(20);
      // Unset fields still get defaults
      expect(config.memory.storePath).toBe('memory');
      expect(config.tasks.maxRetries).toBe(3);
    });

    it('missing config file is not an error', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      expect(() => resolveConfig()).not.toThrow();
    });

    it('rejects config file that contains credential fields', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ ANTHROPIC_API_KEY: 'sk-test' })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with ANTHROPIC_SESSION_TOKEN', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ ANTHROPIC_SESSION_TOKEN: 'tok' })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with DISCORD_BOT_TOKEN', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ DISCORD_BOT_TOKEN: 'token' })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with BOLT_LOCAL_API_KEY', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ BOLT_LOCAL_API_KEY: 'key' })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });
  });

  describe('environment variable overrides', () => {
    it('BOLT_MODEL overrides config file model', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ model: 'claude-haiku-4-5-20251001' })
      );
      process.env['BOLT_MODEL'] = 'claude-sonnet-4-6';

      const config = resolveConfig();

      expect(config.model).toBe('claude-sonnet-4-6');
    });

    it('BOLT_DATA_DIR overrides default dataDir', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      process.env['BOLT_DATA_DIR'] = '/tmp/mydata';

      const config = resolveConfig();

      expect(config.dataDir).toBe('/tmp/mydata');
    });

    it('BOLT_LOG_LEVEL overrides default logLevel', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      process.env['BOLT_LOG_LEVEL'] = 'debug';

      const config = resolveConfig();

      expect(config.logLevel).toBe('debug');
    });

    it('BOLT_LOCAL_ENDPOINT overrides local.endpoint', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ local: { endpoint: 'http://localhost:9000' } })
      );
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';

      const config = resolveConfig();

      expect(config.local.endpoint).toBe('http://localhost:8080');
    });
  });

  describe('validation', () => {
    it('throws ConfigError with descriptive message for invalid compactThreshold', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ memory: { compactThreshold: 1.5 } })
      );

      expect(() => resolveConfig()).toThrow(
        'config.memory.compactThreshold must be between 0.0 and 1.0, got: 1.5'
      );
    });

    it('throws ConfigError for compactThreshold below 0', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ memory: { compactThreshold: -0.1 } })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid logLevel', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      process.env['BOLT_LOG_LEVEL'] = 'verbose';

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid searchBackend', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ memory: { searchBackend: 'neural' } })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid web channel mode', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ channels: { web: { mode: 'grpc' } } })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer port', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ channels: { web: { port: 3.5 } } })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for negative timeoutMs', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ tools: { timeoutMs: -1 } })
      );

      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid JSON in config file', async () => {
      const { readFileSync } = await import('node:fs');
      vi.mocked(readFileSync).mockReturnValue('{not valid json}');

      expect(() => resolveConfig()).toThrow(ConfigError);
    });
  });
});
