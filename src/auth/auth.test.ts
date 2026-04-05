import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { resolveAuth, createAnthropicClient, AuthError } from './auth';

vi.mock('@anthropic-ai/sdk');

describe('resolveAuth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_SESSION_TOKEN'];
    delete process.env['BOLT_LOCAL_ENDPOINT'];
    delete process.env['BOLT_LOCAL_API_KEY'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('API key mode (S1-1)', () => {
    it('returns api-key mode when ANTHROPIC_API_KEY is set', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
      const auth = resolveAuth();
      expect(auth.mode).toBe('api-key');
      expect(auth.credential).toBe('sk-test-key');
      expect(auth.localEndpoint).toBeUndefined();
    });
  });

  describe('subscription mode (S1-2)', () => {
    it('returns subscription mode when only ANTHROPIC_SESSION_TOKEN is set', () => {
      process.env['ANTHROPIC_SESSION_TOKEN'] = 'sess-token-123';
      const auth = resolveAuth();
      expect(auth.mode).toBe('subscription');
      expect(auth.credential).toBe('sess-token-123');
      expect(auth.localEndpoint).toBeUndefined();
    });

    it('api-key takes precedence over subscription, with a warning', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
      process.env['ANTHROPIC_SESSION_TOKEN'] = 'sess-token-123';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const auth = resolveAuth();
      expect(auth.mode).toBe('api-key');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY'));
      stderrSpy.mockRestore();
    });

    it('error message does not contain credential values', () => {
      process.env['ANTHROPIC_API_KEY'] = 'secret-key-value';
      process.env['ANTHROPIC_SESSION_TOKEN'] = 'secret-token-value';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      resolveAuth();
      const warningOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(warningOutput).not.toContain('secret-key-value');
      expect(warningOutput).not.toContain('secret-token-value');
      stderrSpy.mockRestore();
    });
  });

  describe('local mode (S1-2b)', () => {
    it('returns local mode when only BOLT_LOCAL_ENDPOINT is set', () => {
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';
      const auth = resolveAuth();
      expect(auth.mode).toBe('local');
      expect(auth.localEndpoint).toBe('http://localhost:8080');
      expect(auth.credential).toBe('');
    });

    it('uses BOLT_LOCAL_API_KEY as credential when set', () => {
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';
      process.env['BOLT_LOCAL_API_KEY'] = 'local-api-key';
      const auth = resolveAuth();
      expect(auth.mode).toBe('local');
      expect(auth.credential).toBe('local-api-key');
    });

    it('api-key takes precedence over local, with a warning', () => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-test-key';
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const auth = resolveAuth();
      expect(auth.mode).toBe('api-key');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('BOLT_LOCAL_ENDPOINT'));
      stderrSpy.mockRestore();
    });

    it('subscription takes precedence over local, with a warning', () => {
      process.env['ANTHROPIC_SESSION_TOKEN'] = 'sess-token-123';
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const auth = resolveAuth();
      expect(auth.mode).toBe('subscription');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('BOLT_LOCAL_ENDPOINT'));
      stderrSpy.mockRestore();
    });

    it('localEndpoint is passed by value in returned AuthConfig', () => {
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://localhost:8080';
      const auth = resolveAuth();
      // Mutating env after resolveAuth does not affect the returned config
      process.env['BOLT_LOCAL_ENDPOINT'] = 'http://changed:9999';
      expect(auth.localEndpoint).toBe('http://localhost:8080');
    });
  });

  describe('no credentials', () => {
    it('throws AuthError when no credentials are set', () => {
      expect(() => resolveAuth()).toThrow(AuthError);
      expect(() => resolveAuth()).toThrow('Authentication required');
    });

    it('throws AuthError with message listing all three options', () => {
      let error: unknown;
      try {
        resolveAuth();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AuthError);
      const message = (error as AuthError).message;
      expect(message).toContain('ANTHROPIC_API_KEY');
      expect(message).toContain('ANTHROPIC_SESSION_TOKEN');
      expect(message).toContain('BOLT_LOCAL_ENDPOINT');
    });
  });
});

describe('createAnthropicClient', () => {
  beforeEach(() => {
    vi.mocked(Anthropic).mockClear();
  });

  it('constructs client with apiKey for api-key mode', () => {
    createAnthropicClient({ mode: 'api-key', credential: 'sk-test-key' });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test-key' }),
    );
  });

  it('constructs client with credential for subscription mode', () => {
    createAnthropicClient({ mode: 'subscription', credential: 'sess-token-123' });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sess-token-123' }),
    );
  });

  it('constructs client with baseURL for local mode', () => {
    createAnthropicClient({
      mode: 'local',
      credential: '',
      localEndpoint: 'http://localhost:8080',
    });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:8080' }),
    );
  });

  it('uses local credential as apiKey when set in local mode', () => {
    createAnthropicClient({
      mode: 'local',
      credential: 'local-key',
      localEndpoint: 'http://localhost:8080',
    });
    expect(vi.mocked(Anthropic)).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'local-key' }),
    );
  });

  it('uses placeholder apiKey when local mode credential is empty', () => {
    createAnthropicClient({
      mode: 'local',
      credential: '',
      localEndpoint: 'http://localhost:8080',
    });
    const callArg = vi.mocked(Anthropic).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof callArg?.['apiKey']).toBe('string');
    expect((callArg?.['apiKey'] as string).length).toBeGreaterThan(0);
  });

  it('throws AuthError when local mode is missing localEndpoint', () => {
    expect(() => createAnthropicClient({ mode: 'local', credential: '' })).toThrow(AuthError);
  });
});
