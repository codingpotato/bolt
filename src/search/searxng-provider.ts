import type { SearchOptions, SearchProvider, SearchResult } from './search-provider';

const DEFAULT_ENDPOINT = 'http://localhost:8080';

interface SearXNGResult {
  title: string;
  url: string;
  content?: string;
  publishedDate?: string;
  engine?: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

function toTimeRange(tr: SearchOptions['timeRange']): string | undefined {
  // SearXNG uses: day, week, month, year
  return tr;
}

function toCategory(cat: SearchOptions['category']): string {
  if (!cat || cat === 'general') return 'general';
  return cat;
}

export class SearXNGProvider implements SearchProvider {
  private readonly endpoint: string;

  constructor(endpoint: string = DEFAULT_ENDPOINT) {
    this.endpoint = endpoint.replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: toCategory(options.category),
    });

    if (options.maxResults !== undefined) {
      params.set('pageno', '1');
    }

    const timeRange = toTimeRange(options.timeRange);
    if (timeRange !== undefined) {
      params.set('time_range', timeRange);
    }

    const url = `${this.endpoint}/search?${params.toString()}`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(
        `SearXNG network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new Error(`SearXNG returned HTTP ${response.status}`);
    }

    let data: SearXNGResponse;
    try {
      data = (await response.json()) as SearXNGResponse;
    } catch {
      throw new Error('SearXNG returned invalid JSON');
    }

    const maxResults = options.maxResults ?? 10;
    return data.results.slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? '',
      date: r.publishedDate,
      source: r.url ? new URL(r.url).hostname : undefined,
    }));
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/search?q=test&format=json`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
