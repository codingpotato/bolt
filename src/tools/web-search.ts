import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import type { SearchProvider, SearchResult } from '../search';

export interface WebSearchInput {
  query: string;
  maxResults?: number;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  category?: 'general' | 'news' | 'images' | 'videos';
}

export interface WebSearchOutput {
  results: SearchResult[];
}

export function createWebSearchTool(
  provider: SearchProvider,
  defaultMaxResults: number,
): Tool<WebSearchInput, WebSearchOutput> {
  return {
    name: 'web_search',
    description:
      'Search the web by keyword and return structured results. ' +
      'Use this for trend research, topic exploration, and gathering current information.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
        maxResults: {
          type: 'number',
          description: `Maximum number of results to return (default: ${defaultMaxResults}).`,
        },
        timeRange: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Filter results by recency.',
        },
        category: {
          type: 'string',
          enum: ['general', 'news', 'images', 'videos'],
          description: 'Search category (default: general).',
        },
      },
      required: ['query'],
    },

    async execute(input: WebSearchInput, _ctx: ToolContext): Promise<WebSearchOutput> {
      let results: SearchResult[];
      try {
        results = await provider.search(input.query, {
          maxResults: input.maxResults ?? defaultMaxResults,
          timeRange: input.timeRange,
          category: input.category,
        });
      } catch (err) {
        throw new ToolError(
          `web_search failed: ${err instanceof Error ? err.message : String(err)}`,
          true /* retryable */,
        );
      }
      return { results };
    },
  };
}
