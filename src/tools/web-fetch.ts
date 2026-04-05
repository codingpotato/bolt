import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export const MAX_BODY_CHARS = 20_000;

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
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch {
        // ignore read failure for error body
      }
      throw new ToolError(`HTTP ${response.status} fetching ${input.url}: ${errorBody}`, false);
    }

    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      throw new ToolError(
        `failed to read response body from ${input.url}: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    const truncated = body.length > MAX_BODY_CHARS;
    if (truncated) {
      body =
        body.slice(0, MAX_BODY_CHARS) +
        `\n\n[truncated — response exceeded ${MAX_BODY_CHARS} characters]`;
    }
    return { body, statusCode: response.status, contentType };
  },
};
