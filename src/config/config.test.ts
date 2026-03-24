import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type { readFileSync as ReadFileSyncFn } from 'node:fs';
import { resolveConfig, ConfigError } from './config';

vi.mock('node:fs');

describe('resolveConfig', () => {
  const originalEnv = process.env;
  // #4: Typed as a proper MockInstance so mockReturnValue is type-checked.
  let readFileSync: MockInstance<typeof ReadFileSyncFn>;

  beforeEach(async () => {
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

    // Default: no config file present
    const fs = await import('node:fs');
    readFileSync = vi.mocked(fs.readFileSync);
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function mockConfigFile(contents: unknown): void {
    readFileSync.mockReturnValue(JSON.stringify(contents));
  }

  describe('defaults', () => {
    it('returns defaults when no config file and no env vars', () => {
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
      expect(config.auth.mode).toBeUndefined();
    });
  });

  describe('config file merging', () => {
    it('overrides defaults with config file values', () => {
      mockConfigFile({
        model: 'claude-haiku-4-5-20251001',
        memory: { compactThreshold: 0.9, keepRecentMessages: 20 },
      });

      const config = resolveConfig();

      expect(config.model).toBe('claude-haiku-4-5-20251001');
      expect(config.memory.compactThreshold).toBe(0.9);
      expect(config.memory.keepRecentMessages).toBe(20);
      // Unset fields still get defaults
      expect(config.memory.storePath).toBe('memory');
      expect(config.tasks.maxRetries).toBe(3);
    });

    it('missing config file is not an error', () => {
      expect(() => resolveConfig()).not.toThrow();
    });

    it('rejects config file that contains ANTHROPIC_API_KEY', () => {
      mockConfigFile({ ANTHROPIC_API_KEY: 'sk-test' });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with ANTHROPIC_SESSION_TOKEN', () => {
      mockConfigFile({ ANTHROPIC_SESSION_TOKEN: 'tok' });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with DISCORD_BOT_TOKEN', () => {
      mockConfigFile({ DISCORD_BOT_TOKEN: 'token' });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('rejects config file with BOLT_LOCAL_API_KEY', () => {
      mockConfigFile({ BOLT_LOCAL_API_KEY: 'key' });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('warns about unknown top-level keys but does not throw', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockConfigFile({ mmodel: 'typo', model: 'claude-opus-4-6' });

      expect(() => resolveConfig()).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('"mmodel"'));

      stderrSpy.mockRestore();
    });

    it('strips unknown top-level keys from the returned config', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockConfigFile({ mmodel: 'typo', model: 'claude-opus-4-6' });

      const config = resolveConfig() as unknown as Record<string, unknown>;

      expect(config['mmodel']).toBeUndefined();

      stderrSpy.mockRestore();
    });

    it('sets auth.mode from config file', () => {
      mockConfigFile({ auth: { mode: 'subscription' } });

      const config = resolveConfig();

      expect(config.auth.mode).toBe('subscription');
    });

    it('does not warn for known top-level keys', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      mockConfigFile({ model: 'claude-opus-4-6', memory: { compactThreshold: 0.7 } });

      resolveConfig();
      expect(stderrSpy).not.toHaveBeenCalled();

      stderrSpy.mockRestore();
    });
  });

  describe('environment variable overrides', () => {
    it('BOLT_MODEL overrides config file model', () => {
      mockConfigFile({ model: 'claude-haiku-4-5-20251001' });
      process.env['BOLT_MODEL'] = 'claude-sonnet-4-6';

      const config = resolveConfig();

      expect(config.model).toBe('claude-sonnet-4-6');
    });

    it('BOLT_DATA_DIR determines which config file is read', () => {
      process.env['BOLT_DATA_DIR'] = '/custom/dir';

      resolveConfig();

      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('/custom/dir'),
        'utf8'
      );
    });

    it('BOLT_DATA_DIR is reflected in returned dataDir', () => {
      process.env['BOLT_DATA_DIR'] = '/tmp/mydata';

      const config = resolveConfig();

      expect(config.dataDir).toBe('/tmp/mydata');
    });

    it('BOLT_LOG_LEVEL overrides default logLevel', () => {
      process.env['BOLT_LOG_LEVEL'] = 'debug';

      const config = resolveConfig();

      expect(config.logLevel).toBe('debug');
    });

    it('BOLT_LOCAL_ENDPOINT overrides local.endpoint from config file', () => {
      mockConfigFile({ local: { endpoint: 'http://localhost:9000' } });
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';

      const config = resolveConfig();

      expect(config.local.endpoint).toBe('http://localhost:8080');
    });

    it('mutating returned config does not affect subsequent calls', () => {
      const config = resolveConfig();
      config.memory.compactThreshold = 0.99;
      config.tools.allowedTools.push('bash');

      const config2 = resolveConfig();
      expect(config2.memory.compactThreshold).toBe(0.8);
      expect(config2.tools.allowedTools).toEqual([]);
    });
  });

  describe('validation', () => {
    it('throws ConfigError with descriptive message for invalid compactThreshold', () => {
      mockConfigFile({ memory: { compactThreshold: 1.5 } });

      expect(() => resolveConfig()).toThrow(
        'config.memory.compactThreshold must be between 0.0 and 1.0, got: 1.5'
      );
    });

    it('throws ConfigError for compactThreshold below 0', () => {
      mockConfigFile({ memory: { compactThreshold: -0.1 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid logLevel', () => {
      process.env['BOLT_LOG_LEVEL'] = 'verbose';
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid searchBackend', () => {
      mockConfigFile({ memory: { searchBackend: 'neural' } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid web channel mode', () => {
      mockConfigFile({ channels: { web: { mode: 'grpc' } } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer port', () => {
      mockConfigFile({ channels: { web: { port: 3.5 } } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for negative timeoutMs', () => {
      mockConfigFile({ tools: { timeoutMs: -1 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid JSON in config file', () => {
      readFileSync.mockReturnValue('{not valid json}');
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer keepRecentMessages', () => {
      mockConfigFile({ memory: { keepRecentMessages: 5.5 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for zero keepRecentMessages', () => {
      mockConfigFile({ memory: { keepRecentMessages: 0 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer taskHistoryMessages', () => {
      mockConfigFile({ memory: { taskHistoryMessages: 5.5 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for zero taskHistoryMessages', () => {
      mockConfigFile({ memory: { taskHistoryMessages: 0 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer taskHistoryTokenBudget', () => {
      mockConfigFile({ memory: { taskHistoryTokenBudget: 1000.5 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for zero taskHistoryTokenBudget', () => {
      mockConfigFile({ memory: { taskHistoryTokenBudget: 0 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer maxSubtaskDepth', () => {
      mockConfigFile({ tasks: { maxSubtaskDepth: 1.5 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-positive maxRetries', () => {
      mockConfigFile({ tasks: { maxRetries: -1 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for non-integer testFixRetries', () => {
      mockConfigFile({ codeWorkflows: { testFixRetries: 0 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('throws ConfigError for invalid auth.mode', () => {
      mockConfigFile({ auth: { mode: 'oauth' } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });

    it('does not throw for omitted auth.mode', () => {
      mockConfigFile({ auth: {} });
      expect(() => resolveConfig()).not.toThrow();
    });

    it('throws ConfigError for invalid search.provider', () => {
      mockConfigFile({ search: { provider: 'google' } });
      expect(() => resolveConfig()).toThrow(
        'config.search.provider must be one of searxng, brave, serper, got: google'
      );
    });

    it('throws ConfigError for non-positive search.maxResults', () => {
      mockConfigFile({ search: { maxResults: 0 } });
      expect(() => resolveConfig()).toThrow(
        'config.search.maxResults must be a positive integer, got: 0'
      );
    });

    it('throws ConfigError for non-integer search.maxResults', () => {
      mockConfigFile({ search: { maxResults: 2.5 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
    });
  });

  describe('search config defaults', () => {
    it('returns default search config when not set', () => {
      const config = resolveConfig();
      expect(config.search.provider).toBe('searxng');
      expect(config.search.maxResults).toBe(10);
      expect(config.search.endpoint).toBeUndefined();
    });

    it('merges search config from file', () => {
      mockConfigFile({ search: { provider: 'brave', maxResults: 5 } });
      const config = resolveConfig();
      expect(config.search.provider).toBe('brave');
      expect(config.search.maxResults).toBe(5);
    });
  });
});
