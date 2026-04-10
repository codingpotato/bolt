import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import type {
  readFileSync as ReadFileSyncFn,
  existsSync as ExistsSyncFn,
  accessSync as AccessSyncFn,
} from 'node:fs';
import { join } from 'node:path';
import { resolveConfig, ConfigError } from './config';

vi.mock('node:fs');

describe('resolveConfig', () => {
  const originalEnv = process.env;
  // #4: Typed as a proper MockInstance so mockReturnValue is type-checked.
  let readFileSync: MockInstance<typeof ReadFileSyncFn>;
  let existsSync: MockInstance<typeof ExistsSyncFn>;
  let accessSync: MockInstance<typeof AccessSyncFn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Remove all bolt-related env vars for a clean slate
    delete process.env['BOLT_MODEL'];
    delete process.env['BOLT_DATA_DIR'];
    delete process.env['BOLT_LOG_LEVEL'];
    delete process.env['BOLT_LOCAL_ENDPOINT'];
    delete process.env['BOLT_LOCAL_API_KEY'];
    delete process.env['BOLT_SEARCH_ENDPOINT'];
    delete process.env['BOLT_WEB_TOKEN'];
    delete process.env['BOLT_WEB_HOST'];
    delete process.env['BOLT_WEB_PORT'];
    delete process.env['DISCORD_BOT_TOKEN'];
    delete process.env['DISCORD_CHANNEL_ID'];
    delete process.env['BOLT_WORKSPACE_ROOT'];

    // Default: no config file present
    const fs = await import('node:fs');
    readFileSync = vi.mocked(fs.readFileSync);
    existsSync = vi.mocked(fs.existsSync);
    accessSync = vi.mocked(fs.accessSync);
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    existsSync.mockReturnValue(true);
    accessSync.mockReturnValue(undefined);
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
      expect(config.dataDir).toBe(join(process.cwd(), '.bolt'));
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

    it('rethrows non-ENOENT errors from reading config file', () => {
      readFileSync.mockImplementation(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });
      expect(() => resolveConfig()).toThrow('EACCES');
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

      expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining('/custom/dir'), 'utf8');
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

    it('BOLT_WEB_HOST overrides channels.web.host', () => {
      process.env['BOLT_WEB_HOST'] = '0.0.0.0';

      const config = resolveConfig();

      expect(config.channels.web.host).toBe('0.0.0.0');
    });

    it('BOLT_WEB_PORT overrides channels.web.port', () => {
      process.env['BOLT_WEB_PORT'] = '9090';

      const config = resolveConfig();

      expect(config.channels.web.port).toBe(9090);
    });

    it('BOLT_WEB_PORT is ignored when not a valid number', () => {
      process.env['BOLT_WEB_PORT'] = 'abc';

      const config = resolveConfig();

      expect(config.channels.web.port).toBe(3000);
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
        'config.memory.compactThreshold must be between 0.0 and 1.0, got: 1.5',
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
        'config.search.provider must be one of searxng, brave, serper, got: google',
      );
    });

    it('throws ConfigError for non-positive search.maxResults', () => {
      mockConfigFile({ search: { maxResults: 0 } });
      expect(() => resolveConfig()).toThrow(
        'config.search.maxResults must be a positive integer, got: 0',
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

    it('parses BOLT_SEARCH_MAX_RESULTS env var', () => {
      process.env['BOLT_SEARCH_MAX_RESULTS'] = '20';
      const config = resolveConfig();
      expect(config.search.maxResults).toBe(20);
      delete process.env['BOLT_SEARCH_MAX_RESULTS'];
    });

    it('ignores BOLT_SEARCH_MAX_RESULTS when not a valid number', () => {
      process.env['BOLT_SEARCH_MAX_RESULTS'] = 'abc';
      const config = resolveConfig();
      expect(config.search.maxResults).toBe(10);
      delete process.env['BOLT_SEARCH_MAX_RESULTS'];
    });
  });

  describe('comfyui config', () => {
    it('returns comfyui defaults when not set', () => {
      const config = resolveConfig();
      expect(config.comfyui.servers).toEqual([]);
      expect(config.comfyui.workflows.text2img).toBe('image_z_image_turbo');
      expect(config.comfyui.workflows.img2video).toBe('video_ltx2_3_i2v');
      expect(config.comfyui.pollIntervalMs).toBe(2000);
      expect(config.comfyui.timeoutMs).toBe(300000);
      expect(config.comfyui.maxConcurrentPerServer).toBe(2);
    });

    it('merges comfyui servers from config file', () => {
      mockConfigFile({
        comfyui: { servers: [{ url: 'http://gpu1:8188', weight: 2 }] },
      });
      const config = resolveConfig();
      expect(config.comfyui.servers).toEqual([{ url: 'http://gpu1:8188', weight: 2 }]);
    });

    it('throws ConfigError when server url is missing', () => {
      mockConfigFile({ comfyui: { servers: [{ url: '', weight: 1 }] } });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('url is required');
    });

    it('throws ConfigError when server weight is non-positive', () => {
      mockConfigFile({ comfyui: { servers: [{ url: 'http://gpu1:8188', weight: 0 }] } });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('weight must be a positive number');
    });

    it('throws ConfigError when pollIntervalMs is zero', () => {
      mockConfigFile({
        comfyui: { servers: [{ url: 'http://gpu1:8188', weight: 1 }], pollIntervalMs: 0 },
      });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('pollIntervalMs');
    });
  });

  describe('ffmpeg config', () => {
    it('returns ffmpeg defaults when not set', () => {
      const config = resolveConfig();
      expect(config.ffmpeg.path).toBeUndefined();
      expect(config.ffmpeg.videoCodec).toBe('libx264');
      expect(config.ffmpeg.crf).toBe(23);
      expect(config.ffmpeg.preset).toBe('fast');
      expect(config.ffmpeg.audioCodec).toBe('aac');
      expect(config.ffmpeg.audioBitrate).toBe('128k');
    });

    it('merges ffmpeg config from file', () => {
      mockConfigFile({ ffmpeg: { crf: 18, preset: 'slow', path: '/usr/local/bin/ffmpeg' } });
      const config = resolveConfig();
      expect(config.ffmpeg.crf).toBe(18);
      expect(config.ffmpeg.preset).toBe('slow');
      expect(config.ffmpeg.path).toBe('/usr/local/bin/ffmpeg');
      // unset fields still get defaults
      expect(config.ffmpeg.videoCodec).toBe('libx264');
    });

    it('applies BOLT_FFMPEG_PATH env override', () => {
      process.env['BOLT_FFMPEG_PATH'] = '/opt/ffmpeg/bin/ffmpeg';
      const config = resolveConfig();
      expect(config.ffmpeg.path).toBe('/opt/ffmpeg/bin/ffmpeg');
      delete process.env['BOLT_FFMPEG_PATH'];
    });

    it('throws ConfigError for crf below 0', () => {
      mockConfigFile({ ffmpeg: { crf: -1 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('config.ffmpeg.crf');
    });

    it('throws ConfigError for crf above 51', () => {
      mockConfigFile({ ffmpeg: { crf: 52 } });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('config.ffmpeg.crf');
    });

    it('throws ConfigError for invalid preset', () => {
      mockConfigFile({ ffmpeg: { preset: 'turbo' } });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('config.ffmpeg.preset');
    });
  });

  describe('workspace', () => {
    it('defaults to process.cwd()', () => {
      const config = resolveConfig();
      expect(config.workspace.root).toBe(process.cwd());
    });

    it('accepts BOLT_WORKSPACE_ROOT env var', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/test-workspace';
      const config = resolveConfig();
      expect(config.workspace.root).toBe('/tmp/test-workspace');
      delete process.env['BOLT_WORKSPACE_ROOT'];
    });

    it('accepts workspace.root from config file', () => {
      mockConfigFile({ workspace: { root: '/tmp/config-workspace' } });
      const config = resolveConfig();
      expect(config.workspace.root).toBe('/tmp/config-workspace');
    });

    it('env var overrides config file', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/env-workspace';
      mockConfigFile({ workspace: { root: '/tmp/config-workspace' } });
      const config = resolveConfig();
      expect(config.workspace.root).toBe('/tmp/env-workspace');
      delete process.env['BOLT_WORKSPACE_ROOT'];
    });

    it('throws ConfigError for relative path', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = 'relative/path';
      existsSync.mockReturnValue(true);
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('absolute path');
      delete process.env['BOLT_WORKSPACE_ROOT'];
    });

    it('throws ConfigError for non-existent path', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/nonexistent-workspace';
      existsSync.mockReturnValue(false);
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('does not exist');
      delete process.env['BOLT_WORKSPACE_ROOT'];
    });

    it('throws ConfigError for non-readable workspace', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/readonly-workspace';
      existsSync.mockReturnValue(true);
      accessSync.mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      });
      expect(() => resolveConfig()).toThrow(ConfigError);
      expect(() => resolveConfig()).toThrow('not readable and writable');
      delete process.env['BOLT_WORKSPACE_ROOT'];
    });
  });

  describe('dataDir and workspace root interaction', () => {
    it('resolves relative BOLT_DATA_DIR against workspace root', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/ws';
      process.env['BOLT_DATA_DIR'] = '.bolt';
      const config = resolveConfig();
      expect(config.dataDir).toBe('/tmp/ws/.bolt');
      expect(config.workspace.root).toBe('/tmp/ws');
      delete process.env['BOLT_WORKSPACE_ROOT'];
      delete process.env['BOLT_DATA_DIR'];
    });

    it('resolves relative BOLT_DATA_DIR against config file workspace root', () => {
      mockConfigFile({ workspace: { root: '/tmp/ws-config' } });
      process.env['BOLT_DATA_DIR'] = 'data';
      const config = resolveConfig();
      expect(config.dataDir).toBe('/tmp/ws-config/data');
      expect(config.workspace.root).toBe('/tmp/ws-config');
      delete process.env['BOLT_DATA_DIR'];
    });

    it('env var workspace root overrides config file for dataDir resolution', () => {
      mockConfigFile({ workspace: { root: '/tmp/ws-config' } });
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/ws-env';
      process.env['BOLT_DATA_DIR'] = 'data';
      const config = resolveConfig();
      expect(config.dataDir).toBe('/tmp/ws-env/data');
      expect(config.workspace.root).toBe('/tmp/ws-env');
      delete process.env['BOLT_WORKSPACE_ROOT'];
      delete process.env['BOLT_DATA_DIR'];
    });

    it('uses absolute BOLT_DATA_DIR as-is regardless of workspace root', () => {
      process.env['BOLT_WORKSPACE_ROOT'] = '/tmp/ws';
      process.env['BOLT_DATA_DIR'] = '/absolute/data';
      const config = resolveConfig();
      expect(config.dataDir).toBe('/absolute/data');
      expect(config.workspace.root).toBe('/tmp/ws');
      delete process.env['BOLT_WORKSPACE_ROOT'];
      delete process.env['BOLT_DATA_DIR'];
    });
  });

  describe('ComfyUI env vars', () => {
    it('parses BOLT_COMFYUI_SERVERS as comma-separated URLs', () => {
      process.env['BOLT_COMFYUI_SERVERS'] = 'http://gpu1:8188,http://gpu2:8188';
      const config = resolveConfig();
      expect(config.comfyui.servers).toEqual([
        { url: 'http://gpu1:8188', weight: 1 },
        { url: 'http://gpu2:8188', weight: 1 },
      ]);
      delete process.env['BOLT_COMFYUI_SERVERS'];
    });

    it('parses BOLT_COMFYUI_TEXT2IMG_WORKFLOW', () => {
      process.env['BOLT_COMFYUI_TEXT2IMG_WORKFLOW'] = 'custom_workflow';
      const config = resolveConfig();
      expect(config.comfyui.workflows.text2img).toBe('custom_workflow');
      delete process.env['BOLT_COMFYUI_TEXT2IMG_WORKFLOW'];
    });

    it('parses BOLT_COMFYUI_POLL_INTERVAL_MS', () => {
      process.env['BOLT_COMFYUI_POLL_INTERVAL_MS'] = '5000';
      const config = resolveConfig();
      expect(config.comfyui.pollIntervalMs).toBe(5000);
      delete process.env['BOLT_COMFYUI_POLL_INTERVAL_MS'];
    });

    it('ignores BOLT_COMFYUI_POLL_INTERVAL_MS when not a valid number', () => {
      process.env['BOLT_COMFYUI_POLL_INTERVAL_MS'] = 'abc';
      const config = resolveConfig();
      expect(config.comfyui.pollIntervalMs).toBe(2000);
      delete process.env['BOLT_COMFYUI_POLL_INTERVAL_MS'];
    });

    it('parses BOLT_COMFYUI_TIMEOUT_MS', () => {
      process.env['BOLT_COMFYUI_TIMEOUT_MS'] = '120000';
      const config = resolveConfig();
      expect(config.comfyui.timeoutMs).toBe(120000);
      delete process.env['BOLT_COMFYUI_TIMEOUT_MS'];
    });

    it('ignores BOLT_COMFYUI_TIMEOUT_MS when not a valid number', () => {
      process.env['BOLT_COMFYUI_TIMEOUT_MS'] = 'abc';
      const config = resolveConfig();
      expect(config.comfyui.timeoutMs).toBe(300000);
      delete process.env['BOLT_COMFYUI_TIMEOUT_MS'];
    });

    it('parses BOLT_COMFYUI_MAX_CONCURRENT', () => {
      process.env['BOLT_COMFYUI_MAX_CONCURRENT'] = '4';
      const config = resolveConfig();
      expect(config.comfyui.maxConcurrentPerServer).toBe(4);
      delete process.env['BOLT_COMFYUI_MAX_CONCURRENT'];
    });

    it('ignores BOLT_COMFYUI_MAX_CONCURRENT when not a valid number', () => {
      process.env['BOLT_COMFYUI_MAX_CONCURRENT'] = 'abc';
      const config = resolveConfig();
      expect(config.comfyui.maxConcurrentPerServer).toBe(2);
      delete process.env['BOLT_COMFYUI_MAX_CONCURRENT'];
    });
  });

  describe('WebChannel env vars', () => {
    it('parses BOLT_WEB_ENABLED', () => {
      process.env['BOLT_WEB_ENABLED'] = 'true';
      const config = resolveConfig();
      expect(config.channels.web.enabled).toBe(true);
      delete process.env['BOLT_WEB_ENABLED'];
    });

    it('parses BOLT_WEB_MODE', () => {
      process.env['BOLT_WEB_MODE'] = 'http';
      const config = resolveConfig();
      expect(config.channels.web.mode).toBe('http');
      delete process.env['BOLT_WEB_MODE'];
    });
  });

  describe('Tools env vars', () => {
    it('parses BOLT_TOOLS_ALLOWED as comma-separated list', () => {
      process.env['BOLT_TOOLS_ALLOWED'] = 'bash,file_read,file_write';
      const config = resolveConfig();
      expect(config.tools.allowedTools).toEqual(['bash', 'file_read', 'file_write']);
      delete process.env['BOLT_TOOLS_ALLOWED'];
    });

    it('ignores BOLT_TOOLS_TIMEOUT_MS when not a valid number', () => {
      process.env['BOLT_TOOLS_TIMEOUT_MS'] = 'abc';
      const config = resolveConfig();
      expect(config.tools.timeoutMs).toBe(30000);
      delete process.env['BOLT_TOOLS_TIMEOUT_MS'];
    });

    it('parses BOLT_TOOLS_TIMEOUT_MS', () => {
      process.env['BOLT_TOOLS_TIMEOUT_MS'] = '60000';
      const config = resolveConfig();
      expect(config.tools.timeoutMs).toBe(60000);
      delete process.env['BOLT_TOOLS_TIMEOUT_MS'];
    });
  });

  describe('Code workflows env vars', () => {
    it('parses BOLT_CODE_TEST_FIX_RETRIES', () => {
      process.env['BOLT_CODE_TEST_FIX_RETRIES'] = '5';
      const config = resolveConfig();
      expect(config.codeWorkflows.testFixRetries).toBe(5);
      delete process.env['BOLT_CODE_TEST_FIX_RETRIES'];
    });

    it('ignores BOLT_CODE_TEST_FIX_RETRIES when not a valid number', () => {
      process.env['BOLT_CODE_TEST_FIX_RETRIES'] = 'abc';
      const config = resolveConfig();
      expect(config.codeWorkflows.testFixRetries).toBe(3);
      delete process.env['BOLT_CODE_TEST_FIX_RETRIES'];
    });
  });

  describe('Memory env vars', () => {
    it('parses BOLT_MEMORY_COMPACT_THRESHOLD', () => {
      process.env['BOLT_MEMORY_COMPACT_THRESHOLD'] = '0.7';
      const config = resolveConfig();
      expect(config.memory.compactThreshold).toBe(0.7);
      delete process.env['BOLT_MEMORY_COMPACT_THRESHOLD'];
    });

    it('ignores BOLT_MEMORY_COMPACT_THRESHOLD when not a valid number', () => {
      process.env['BOLT_MEMORY_COMPACT_THRESHOLD'] = 'abc';
      const config = resolveConfig();
      expect(config.memory.compactThreshold).toBe(0.8);
      delete process.env['BOLT_MEMORY_COMPACT_THRESHOLD'];
    });

    it('parses BOLT_MEMORY_KEEP_RECENT', () => {
      process.env['BOLT_MEMORY_KEEP_RECENT'] = '20';
      const config = resolveConfig();
      expect(config.memory.keepRecentMessages).toBe(20);
      delete process.env['BOLT_MEMORY_KEEP_RECENT'];
    });

    it('ignores BOLT_MEMORY_KEEP_RECENT when not a valid number', () => {
      process.env['BOLT_MEMORY_KEEP_RECENT'] = 'abc';
      const config = resolveConfig();
      expect(config.memory.keepRecentMessages).toBe(10);
      delete process.env['BOLT_MEMORY_KEEP_RECENT'];
    });

    it('parses BOLT_MEMORY_SEARCH_BACKEND', () => {
      process.env['BOLT_MEMORY_SEARCH_BACKEND'] = 'embedding';
      const config = resolveConfig();
      expect(config.memory.searchBackend).toBe('embedding');
      delete process.env['BOLT_MEMORY_SEARCH_BACKEND'];
    });
  });

  describe('Agent prompt env vars', () => {
    it('parses BOLT_AGENT_PROJECT_FILE', () => {
      process.env['BOLT_AGENT_PROJECT_FILE'] = '/custom/AGENT.md';
      const config = resolveConfig();
      expect(config.agentPrompt.projectFile).toBe('/custom/AGENT.md');
      delete process.env['BOLT_AGENT_PROJECT_FILE'];
    });

    it('parses BOLT_AGENT_MAX_TOKENS', () => {
      process.env['BOLT_AGENT_MAX_TOKENS'] = '10000';
      const config = resolveConfig();
      expect(config.agentPrompt.maxTokens).toBe(10000);
      delete process.env['BOLT_AGENT_MAX_TOKENS'];
    });

    it('ignores BOLT_AGENT_MAX_TOKENS when not a valid number', () => {
      process.env['BOLT_AGENT_MAX_TOKENS'] = 'abc';
      const config = resolveConfig();
      expect(config.agentPrompt.maxTokens).toBe(8000);
      delete process.env['BOLT_AGENT_MAX_TOKENS'];
    });

    it('parses BOLT_AGENT_WATCH_CHANGES', () => {
      process.env['BOLT_AGENT_WATCH_CHANGES'] = 'false';
      const config = resolveConfig();
      expect(config.agentPrompt.watchForChanges).toBe(false);
      delete process.env['BOLT_AGENT_WATCH_CHANGES'];
    });
  });

  describe('Tasks env vars', () => {
    it('parses BOLT_TASKS_MAX_SUBTASK_DEPTH', () => {
      process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH'] = '10';
      const config = resolveConfig();
      expect(config.tasks.maxSubtaskDepth).toBe(10);
      delete process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH'];
    });

    it('ignores BOLT_TASKS_MAX_SUBTASK_DEPTH when not a valid number', () => {
      process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH'] = 'abc';
      const config = resolveConfig();
      expect(config.tasks.maxSubtaskDepth).toBe(5);
      delete process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH'];
    });

    it('parses BOLT_TASKS_MAX_RETRIES', () => {
      process.env['BOLT_TASKS_MAX_RETRIES'] = '7';
      const config = resolveConfig();
      expect(config.tasks.maxRetries).toBe(7);
      delete process.env['BOLT_TASKS_MAX_RETRIES'];
    });

    it('ignores BOLT_TASKS_MAX_RETRIES when not a valid number', () => {
      process.env['BOLT_TASKS_MAX_RETRIES'] = 'abc';
      const config = resolveConfig();
      expect(config.tasks.maxRetries).toBe(3);
      delete process.env['BOLT_TASKS_MAX_RETRIES'];
    });
  });

  describe('CLI env vars', () => {
    it('parses BOLT_CLI_PROGRESS', () => {
      process.env['BOLT_CLI_PROGRESS'] = 'false';
      const config = resolveConfig();
      expect(config.cli.progress).toBe(false);
      delete process.env['BOLT_CLI_PROGRESS'];
    });

    it('parses BOLT_CLI_VERBOSE', () => {
      process.env['BOLT_CLI_VERBOSE'] = 'true';
      const config = resolveConfig();
      expect(config.cli.verbose).toBe(true);
      delete process.env['BOLT_CLI_VERBOSE'];
    });
  });
});
