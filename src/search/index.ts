import type { Config } from '../config/config';
import type { Logger } from '../logger/logger';
import type { SearchProvider } from './search-provider';
import { BraveProvider } from './brave-provider';
import { SearXNGProvider } from './searxng-provider';
import { SerperProvider } from './serper-provider';

export type { SearchOptions, SearchResult, SearchProvider } from './search-provider';

/**
 * Create the search provider selected by config.search.provider.
 * Reads BOLT_SEARCH_API_KEY from the environment for Brave and Serper.
 */
export function createSearchProvider(config: Config): SearchProvider {
  const { provider, endpoint } = config.search;

  switch (provider) {
    case 'searxng':
      return new SearXNGProvider(endpoint);
    case 'brave': {
      const apiKey = process.env['BOLT_SEARCH_API_KEY'] ?? '';
      return new BraveProvider(apiKey, endpoint);
    }
    case 'serper': {
      const apiKey = process.env['BOLT_SEARCH_API_KEY'] ?? '';
      return new SerperProvider(apiKey, endpoint);
    }
  }
}

/**
 * Validate that the search provider is reachable at startup.
 * Logs a warning if unreachable — does not throw.
 */
export async function validateSearchProvider(
  provider: SearchProvider,
  logger: Logger,
): Promise<void> {
  const ok = await provider.checkConnectivity();
  if (!ok) {
    logger.warn('Search provider is unreachable — web_search calls may fail', {});
  }
}
