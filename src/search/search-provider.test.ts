import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearXNGProvider } from './searxng-provider';
import { BraveProvider } from './brave-provider';
import { SerperProvider } from './serper-provider';
import { createSearchProvider, validateSearchProvider } from './index';
import type { Config } from '../config/config';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeOkResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

function makeErrorResponse(status: number) {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

// ---------------------------------------------------------------------------
// SearXNGProvider
// ---------------------------------------------------------------------------

describe('SearXNGProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls the SearXNG JSON API with the query', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ results: [] }));
    const provider = new SearXNGProvider('http://localhost:8080');
    await provider.search('typescript trends');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('q=typescript+trends'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          'User-Agent': expect.stringContaining('bolt-agent'),
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('format=json'),
      expect.any(Object),
    );
  });

  it('maps results to SearchResult shape', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        results: [
          {
            title: 'TS 5.0',
            url: 'https://example.com/ts5',
            content: 'TypeScript 5.0 released',
            publishedDate: '2024-01-01',
            engine: 'google',
          },
        ],
      }),
    );
    const provider = new SearXNGProvider();
    const results = await provider.search('typescript');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'TS 5.0',
      url: 'https://example.com/ts5',
      snippet: 'TypeScript 5.0 released',
      date: '2024-01-01',
      source: 'example.com',
    });
  });

  it('respects maxResults option', async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => ({
      title: `Result ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet ${i}`,
    }));
    fetchMock.mockResolvedValue(makeOkResponse({ results: manyResults }));
    const provider = new SearXNGProvider();
    const results = await provider.search('test', { maxResults: 3 });
    expect(results).toHaveLength(3);
  });

  it('passes time_range when timeRange option is set', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ results: [] }));
    const provider = new SearXNGProvider();
    await provider.search('test', { timeRange: 'week' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('time_range=week'), expect.any(Object));
  });

  it('passes categories when category option is set', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ results: [] }));
    const provider = new SearXNGProvider();
    await provider.search('test', { category: 'news' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('categories=news'), expect.any(Object));
  });

  it('throws on HTTP error response', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(500));
    const provider = new SearXNGProvider();
    await expect(provider.search('test')).rejects.toThrow('500');
  });

  it('throws on network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const provider = new SearXNGProvider();
    await expect(provider.search('test')).rejects.toThrow('network error');
  });

  it('throws on invalid JSON response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('invalid json')),
    });
    const provider = new SearXNGProvider();
    await expect(provider.search('test')).rejects.toThrow('invalid JSON');
  });

  describe('checkConnectivity', () => {
    it('returns true when endpoint responds ok', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      const provider = new SearXNGProvider();
      expect(await provider.checkConnectivity()).toBe(true);
    });

    it('returns false on network error', async () => {
      fetchMock.mockRejectedValue(new Error('connection refused'));
      const provider = new SearXNGProvider();
      expect(await provider.checkConnectivity()).toBe(false);
    });

    it('returns false when endpoint returns non-ok', async () => {
      fetchMock.mockResolvedValue({ ok: false });
      const provider = new SearXNGProvider();
      expect(await provider.checkConnectivity()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// BraveProvider
// ---------------------------------------------------------------------------

describe('BraveProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends X-Subscription-Token header', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ web: { results: [] } }));
    const provider = new BraveProvider('my-key');
    await provider.search('test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Subscription-Token': 'my-key' }),
      }),
    );
  });

  it('maps results to SearchResult shape', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        web: {
          results: [
            {
              title: 'Brave result',
              url: 'https://brave.com/page',
              description: 'A brave snippet',
              age: '2024-06-01',
              meta_url: { hostname: 'brave.com' },
            },
          ],
        },
      }),
    );
    const provider = new BraveProvider('key');
    const results = await provider.search('brave');
    expect(results[0]).toMatchObject({
      title: 'Brave result',
      url: 'https://brave.com/page',
      snippet: 'A brave snippet',
      date: '2024-06-01',
      source: 'brave.com',
    });
  });

  it('passes freshness param when timeRange is set', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ web: { results: [] } }));
    const provider = new BraveProvider('key');
    await provider.search('test', { timeRange: 'day' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('freshness=pd'),
      expect.any(Object),
    );
  });

  it('passes count param', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ web: { results: [] } }));
    const provider = new BraveProvider('key');
    await provider.search('test', { maxResults: 5 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('count=5'),
      expect.any(Object),
    );
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(401));
    const provider = new BraveProvider('bad-key');
    await expect(provider.search('test')).rejects.toThrow('401');
  });

  it('throws on network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('network fail'));
    const provider = new BraveProvider('key');
    await expect(provider.search('test')).rejects.toThrow('network error');
  });

  it('handles missing web.results gracefully', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({}));
    const provider = new BraveProvider('key');
    const results = await provider.search('test');
    expect(results).toEqual([]);
  });

  describe('checkConnectivity', () => {
    it('returns true when ok', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      expect(await new BraveProvider('key').checkConnectivity()).toBe(true);
    });

    it('returns false on error', async () => {
      fetchMock.mockRejectedValue(new Error('fail'));
      expect(await new BraveProvider('key').checkConnectivity()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// SerperProvider
// ---------------------------------------------------------------------------

describe('SerperProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends X-API-KEY header and POSTs JSON body', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ organic: [] }));
    const provider = new SerperProvider('serper-key');
    await provider.search('test query');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-API-KEY': 'serper-key' }),
        body: expect.stringContaining('"q":"test query"'),
      }),
    );
  });

  it('maps organic results to SearchResult shape', async () => {
    fetchMock.mockResolvedValue(
      makeOkResponse({
        organic: [
          {
            title: 'Serper hit',
            link: 'https://serper.dev/page',
            snippet: 'Serper snippet',
            date: '2024-03-01',
            displayLink: 'serper.dev',
          },
        ],
      }),
    );
    const provider = new SerperProvider('key');
    const results = await provider.search('serper');
    expect(results[0]).toMatchObject({
      title: 'Serper hit',
      url: 'https://serper.dev/page',
      snippet: 'Serper snippet',
      date: '2024-03-01',
      source: 'serper.dev',
    });
  });

  it('includes tbs param when timeRange is set', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ organic: [] }));
    const provider = new SerperProvider('key');
    await provider.search('test', { timeRange: 'month' });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"tbs":"qdr:m"'),
      }),
    );
  });

  it('passes num param', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ organic: [] }));
    const provider = new SerperProvider('key');
    await provider.search('test', { maxResults: 7 });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('"num":7') }),
    );
  });

  it('throws on HTTP error', async () => {
    fetchMock.mockResolvedValue(makeErrorResponse(403));
    const provider = new SerperProvider('bad-key');
    await expect(provider.search('test')).rejects.toThrow('403');
  });

  it('throws on network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('network fail'));
    const provider = new SerperProvider('key');
    await expect(provider.search('test')).rejects.toThrow('network error');
  });

  it('handles missing organic field gracefully', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({}));
    const provider = new SerperProvider('key');
    expect(await provider.search('test')).toEqual([]);
  });

  describe('checkConnectivity', () => {
    it('returns true when ok', async () => {
      fetchMock.mockResolvedValue({ ok: true });
      expect(await new SerperProvider('key').checkConnectivity()).toBe(true);
    });

    it('returns false on error', async () => {
      fetchMock.mockRejectedValue(new Error('fail'));
      expect(await new SerperProvider('key').checkConnectivity()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createSearchProvider factory
// ---------------------------------------------------------------------------

describe('createSearchProvider', () => {
  const baseConfig: Config = {
    model: 'claude-opus-4-6',
    dataDir: '.bolt',
    logLevel: 'info',
    auth: {},
    local: {},
    search: { provider: 'searxng', maxResults: 10 },
    agentPrompt: { projectFile: '.bolt/AGENT.md', userFile: '~/.bolt/AGENT.md', suggestionsPath: '.bolt/suggestions' },
    memory: {
      compactThreshold: 0.8, keepRecentMessages: 10, storePath: 'memory',
      sessionPath: 'sessions', taskHistoryMessages: 20, taskHistoryTokenBudget: 20000,
      injectRecentChat: true, searchBackend: 'keyword',
    },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    comfyui: { servers: [], workflows: { text2img: 'image_z_image_turbo', img2video: 'video_ltx2_3_i2v' }, pollIntervalMs: 2000, timeoutMs: 300000, maxConcurrentPerServer: 2 },
    ffmpeg: { videoCodec: 'libx264', crf: 23, preset: 'fast', audioCodec: 'aac', audioBitrate: '128k' },
    codeWorkflows: { testFixRetries: 3 },
    cli: { progress: true, verbose: false },
    channels: { web: { enabled: false, port: 3000, mode: 'websocket' } },
  };

  it('returns SearXNGProvider for provider=searxng', () => {
    const provider = createSearchProvider(baseConfig);
    expect(provider).toBeInstanceOf(SearXNGProvider);
  });

  it('returns BraveProvider for provider=brave', () => {
    const provider = createSearchProvider({ ...baseConfig, search: { provider: 'brave', maxResults: 10 } });
    expect(provider).toBeInstanceOf(BraveProvider);
  });

  it('returns SerperProvider for provider=serper', () => {
    const provider = createSearchProvider({ ...baseConfig, search: { provider: 'serper', maxResults: 10 } });
    expect(provider).toBeInstanceOf(SerperProvider);
  });

  it('passes custom endpoint to SearXNG provider', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ results: [] }));
    const provider = createSearchProvider({
      ...baseConfig,
      search: { provider: 'searxng', endpoint: 'http://custom:9999', maxResults: 10 },
    });
    await provider.search('test');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('http://custom:9999'), expect.any(Object));
  });

  it('passes custom endpoint to Brave provider', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ web: { results: [] } }));
    const provider = createSearchProvider({
      ...baseConfig,
      search: { provider: 'brave', endpoint: 'http://brave-proxy:8080', maxResults: 10 },
    });
    await provider.search('test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://brave-proxy:8080'),
      expect.any(Object),
    );
  });

  it('passes custom endpoint to Serper provider', async () => {
    fetchMock.mockResolvedValue(makeOkResponse({ organic: [] }));
    const provider = createSearchProvider({
      ...baseConfig,
      search: { provider: 'serper', endpoint: 'http://serper-proxy:7070', maxResults: 10 },
    });
    await provider.search('test');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://serper-proxy:7070'),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// validateSearchProvider
// ---------------------------------------------------------------------------

describe('validateSearchProvider', () => {
  it('logs a warning when connectivity check fails', async () => {
    fetchMock.mockRejectedValue(new Error('unreachable'));
    const provider = new SearXNGProvider();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await validateSearchProvider(provider, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unreachable'), expect.any(Object));
  });

  it('does not log a warning when connectivity check passes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const provider = new SearXNGProvider();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await validateSearchProvider(provider, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
