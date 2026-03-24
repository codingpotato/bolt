import type { SearchOptions, SearchProvider, SearchResult } from './search-provider';

const DEFAULT_ENDPOINT = 'https://api.search.brave.com';

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: { hostname?: string };
}

interface BraveResponse {
  web?: { results?: BraveWebResult[] };
}

function toBraveFreshness(tr: SearchOptions['timeRange']): string | undefined {
  // Brave freshness values: pd (past day), pw (past week), pm (past month), py (past year)
  const map: Record<string, string> = {
    day: 'pd',
    week: 'pw',
    month: 'pm',
    year: 'py',
  };
  return tr ? map[tr] : undefined;
}

export class BraveProvider implements SearchProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(apiKey: string, endpoint: string = DEFAULT_ENDPOINT) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const maxResults = options.maxResults ?? 10;
    const params = new URLSearchParams({
      q: query,
      count: String(maxResults),
    });

    const freshness = toBraveFreshness(options.timeRange);
    if (freshness !== undefined) {
      params.set('freshness', freshness);
    }

    const url = `${this.endpoint}/res/v1/web/search?${params.toString()}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          'X-Subscription-Token': this.apiKey,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new Error(
        `Brave Search network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new Error(`Brave Search returned HTTP ${response.status}`);
    }

    let data: BraveResponse;
    try {
      data = (await response.json()) as BraveResponse;
    } catch {
      throw new Error('Brave Search returned invalid JSON');
    }

    const results = data.web?.results ?? [];
    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description ?? '',
      date: r.age,
      source: r.meta_url?.hostname ?? (r.url ? new URL(r.url).hostname : undefined),
    }));
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/res/v1/web/search?q=test&count=1`, {
        headers: {
          'X-Subscription-Token': this.apiKey,
          Accept: 'application/json',
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
