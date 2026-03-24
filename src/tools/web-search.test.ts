import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWebSearchTool } from './web-search';
import { ToolError } from './tool';
import type { ToolContext } from './tool';
import type { SearchProvider, SearchResult } from '../search';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

function makeCtx(): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'Test Title',
    url: 'https://example.com',
    snippet: 'A useful snippet',
    ...overrides,
  };
}

function makeProvider(results: SearchResult[] = []): SearchProvider {
  return {
    search: vi.fn().mockResolvedValue(results),
    checkConnectivity: vi.fn().mockResolvedValue(true),
  };
}

describe('web_search tool', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  it('has name "web_search"', () => {
    const tool = createWebSearchTool(makeProvider(), 10);
    expect(tool.name).toBe('web_search');
  });

  it('has inputSchema with required query field', () => {
    const tool = createWebSearchTool(makeProvider(), 10);
    expect(tool.inputSchema.required).toContain('query');
  });

  it('returns results from the search provider', async () => {
    const results = [makeResult({ title: 'Trend 1' }), makeResult({ title: 'Trend 2' })];
    const tool = createWebSearchTool(makeProvider(results), 10);

    const output = await tool.execute({ query: 'AI trends' }, ctx);

    expect(output.results).toHaveLength(2);
    expect(output.results[0]?.title).toBe('Trend 1');
  });

  it('passes query to the provider', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, 10);

    await tool.execute({ query: 'typescript news' }, ctx);

    expect(provider.search).toHaveBeenCalledWith('typescript news', expect.any(Object));
  });

  it('uses defaultMaxResults when maxResults is not provided', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, 7);

    await tool.execute({ query: 'test' }, ctx);

    expect(provider.search).toHaveBeenCalledWith('test', expect.objectContaining({ maxResults: 7 }));
  });

  it('passes maxResults from input when provided', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, 10);

    await tool.execute({ query: 'test', maxResults: 3 }, ctx);

    expect(provider.search).toHaveBeenCalledWith('test', expect.objectContaining({ maxResults: 3 }));
  });

  it('passes timeRange to the provider', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, 10);

    await tool.execute({ query: 'test', timeRange: 'week' }, ctx);

    expect(provider.search).toHaveBeenCalledWith('test', expect.objectContaining({ timeRange: 'week' }));
  });

  it('passes category to the provider', async () => {
    const provider = makeProvider();
    const tool = createWebSearchTool(provider, 10);

    await tool.execute({ query: 'test', category: 'news' }, ctx);

    expect(provider.search).toHaveBeenCalledWith('test', expect.objectContaining({ category: 'news' }));
  });

  it('returns empty results array when provider returns no results', async () => {
    const tool = createWebSearchTool(makeProvider([]), 10);

    const output = await tool.execute({ query: 'obscure topic' }, ctx);

    expect(output.results).toEqual([]);
  });

  it('returns a retryable ToolError on provider network error', async () => {
    const provider: SearchProvider = {
      search: vi.fn().mockRejectedValue(new Error('network failure')),
      checkConnectivity: vi.fn().mockResolvedValue(false),
    };
    const tool = createWebSearchTool(provider, 10);

    await expect(tool.execute({ query: 'test' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.retryable === true,
    );
  });

  it('includes the provider error message in the ToolError', async () => {
    const provider: SearchProvider = {
      search: vi.fn().mockRejectedValue(new Error('SearXNG returned HTTP 503')),
      checkConnectivity: vi.fn().mockResolvedValue(false),
    };
    const tool = createWebSearchTool(provider, 10);

    await expect(tool.execute({ query: 'test' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.message.includes('SearXNG returned HTTP 503'),
    );
  });

  it('result shape includes title, url, snippet and optional date and source', async () => {
    const full = makeResult({ date: '2024-06-01', source: 'example.com' });
    const tool = createWebSearchTool(makeProvider([full]), 10);

    const output = await tool.execute({ query: 'test' }, ctx);

    expect(output.results[0]).toMatchObject({
      title: 'Test Title',
      url: 'https://example.com',
      snippet: 'A useful snippet',
      date: '2024-06-01',
      source: 'example.com',
    });
  });
});
