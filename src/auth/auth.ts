import Anthropic from '@anthropic-ai/sdk';

export type AuthMode = 'api-key' | 'subscription' | 'local';

export interface AuthConfig {
  mode: AuthMode;
  /** Resolved credential — never logged. Empty string for local mode unless BOLT_LOCAL_API_KEY is set. */
  credential: string;
  /** Only set when mode is "local" — passed as baseURL to the Anthropic SDK. */
  localEndpoint?: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Resolves authentication configuration from environment variables.
 * Precedence: API Key > Subscription > Local.
 * Throws AuthError if no valid mode is configured.
 */
export function resolveAuth(): AuthConfig {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  const sessionToken = process.env['ANTHROPIC_SESSION_TOKEN'];
  const localEndpoint = process.env['BOLT_LOCAL_ENDPOINT'];
  const localApiKey = process.env['BOLT_LOCAL_API_KEY'];

  if (apiKey) {
    if (sessionToken) {
      process.stderr.write(
        'Warning: both ANTHROPIC_API_KEY and ANTHROPIC_SESSION_TOKEN are set; using ANTHROPIC_API_KEY\n'
      );
    }
    return { mode: 'api-key', credential: apiKey };
  }

  if (sessionToken) {
    return { mode: 'subscription', credential: sessionToken };
  }

  if (localEndpoint) {
    return { mode: 'local', credential: localApiKey ?? '', localEndpoint };
  }

  throw new AuthError(
    'Authentication required. Set ANTHROPIC_API_KEY for API key mode, ' +
      'ANTHROPIC_SESSION_TOKEN for subscription mode, or BOLT_LOCAL_ENDPOINT ' +
      'to point bolt at a local Anthropic-compatible server.'
  );
}

/**
 * Constructs an Anthropic SDK client from a resolved AuthConfig.
 * No network calls are made at construction time.
 */
export function createAnthropicClient(authConfig: AuthConfig): Anthropic {
  if (authConfig.mode === 'local') {
    return new Anthropic({
      baseURL: authConfig.localEndpoint,
      apiKey: authConfig.credential || 'local',
    });
  }

  return new Anthropic({ apiKey: authConfig.credential });
}
