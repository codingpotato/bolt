import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export interface WebFetchInput {
  url: string;
}

export interface WebFetchOutput {
  body: string;
  statusCode: number;
  contentType: string;
}

export const webFetchTool: Tool<WebFetchInput, WebFetchOutput> = {
  name: 'web_fetch',
  description: 'GET a URL and return the response body, status code, and content type.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
    },
    required: ['url'],
  },

  async execute(input: WebFetchInput, _ctx: ToolContext): Promise<WebFetchOutput> {
    let response: Response;
    try {
      response = await fetch(input.url);
    } catch (err) {
      throw new ToolError(
        `network error fetching ${input.url}: ${err instanceof Error ? err.message : String(err)}`,
        true /* retryable */,
      );
    }

    if (!response.ok) {
      throw new ToolError(
        `HTTP ${response.status} fetching ${input.url}`,
        false,
      );
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    return { body, statusCode: response.status, contentType };
  },
};
