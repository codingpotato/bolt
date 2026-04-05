import type { SearchOptions, SearchProvider, SearchResult } from './search-provider';

const DEFAULT_ENDPOINT = 'https://google.serper.dev';

interface SerperOrganicResult {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  displayLink?: string;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

function toSerperTbs(tr: SearchOptions['timeRange']): string | undefined {
  // Serper uses Google's tbs param: qdr:d, qdr:w, qdr:m, qdr:y
  const map: Record<string, string> = {
    day: 'qdr:d',
    week: 'qdr:w',
    month: 'qdr:m',
    year: 'qdr:y',
  };
  return tr ? map[tr] : undefined;
}

export class SerperProvider implements SearchProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(apiKey: string, endpoint: string = DEFAULT_ENDPOINT) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const maxResults = options.maxResults ?? 10;
    const body: Record<string, unknown> = {
      q: query,
      num: maxResults,
    };

    const tbs = toSerperTbs(options.timeRange);
    if (tbs !== undefined) {
      body['tbs'] = tbs;
    }

    const url = `${this.endpoint}/search`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Serper network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      throw new Error(`Serper returned HTTP ${response.status}`);
    }

    let data: SerperResponse;
    try {
      data = (await response.json()) as SerperResponse;
    } catch {
      throw new Error('Serper returned invalid JSON');
    }

    const results = data.organic ?? [];
    return results.map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet ?? '',
      date: r.date,
      source: r.displayLink ?? (r.link ? new URL(r.link).hostname : undefined),
    }));
  }

  async checkConnectivity(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/search`, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: 'test', num: 1 }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
