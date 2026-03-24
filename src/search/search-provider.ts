export interface SearchOptions {
  maxResults?: number;
  timeRange?: 'day' | 'week' | 'month' | 'year';
  category?: 'general' | 'news' | 'images' | 'videos';
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  source?: string;
}

export interface SearchProvider {
  /**
   * Search the web and return structured results.
   */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /**
   * Check that the provider endpoint is reachable.
   * Returns true if reachable, false otherwise.
   */
  checkConnectivity(): Promise<boolean>;
}
