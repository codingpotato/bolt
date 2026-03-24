import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  model: string;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  auth: {
    mode?: 'api-key' | 'subscription' | 'local';
  };
  local: {
    endpoint?: string;
  };
  search: {
    provider: 'searxng' | 'brave' | 'serper';
    endpoint?: string;
    maxResults: number;
  };
  agentPrompt: {
    projectFile: string;
    userFile: string;
    suggestionsPath: string;
  };
  memory: {
    compactThreshold: number;
    keepRecentMessages: number;
    storePath: string;
    sessionPath: string;
    taskHistoryMessages: number;
    taskHistoryTokenBudget: number;
    injectRecentChat: boolean;
    searchBackend: 'keyword' | 'embedding';
  };
  tasks: {
    maxSubtaskDepth: number;
    maxRetries: number;
  };
  tools: {
    timeoutMs: number;
    allowedTools: string[];
  };
  codeWorkflows: {
    testFixRetries: number;
  };
  cli: {
    /** Show progress events in TTY mode (default: true). */
    progress: boolean;
    /** Show progress events even in non-TTY mode (default: false). */
    verbose: boolean;
  };
  channels: {
    web: {
      enabled: boolean;
      port: number;
      mode: 'http' | 'websocket';
      token?: string;
    };
  };
}

const DEFAULTS: Config = {
  model: 'claude-opus-4-6',
  dataDir: '.bolt',
  logLevel: 'info',
  auth: {},
  local: {},
  search: {
    provider: 'searxng',
    maxResults: 10,
  },
  agentPrompt: {
    projectFile: '.bolt/AGENT.md',
    userFile: '~/.bolt/AGENT.md',
    suggestionsPath: '.bolt/suggestions',
  },
  memory: {
    compactThreshold: 0.8,
    keepRecentMessages: 10,
    storePath: 'memory',
    sessionPath: 'sessions',
    taskHistoryMessages: 20,
    taskHistoryTokenBudget: 20000,
    injectRecentChat: true,
    searchBackend: 'keyword',
  },
  tasks: {
    maxSubtaskDepth: 5,
    maxRetries: 3,
  },
  tools: {
    timeoutMs: 30000,
    allowedTools: [],
  },
  codeWorkflows: {
    testFixRetries: 3,
  },
  cli: {
    progress: true,
    verbose: false,
  },
  channels: {
    web: {
      enabled: false,
      port: 3000,
      mode: 'websocket',
    },
  },
};

const CREDENTIAL_FIELDS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_SESSION_TOKEN',
  'DISCORD_BOT_TOKEN',
  'BOLT_LOCAL_API_KEY',
] as const;

// #3: Typed against Config so the compiler catches removed or misspelled keys.
// ReadonlySet<string> lets .has() accept any string at the call site.
// Intentionally excludes `logLevel` (env-var only: BOLT_LOG_LEVEL) and
// `dataDir` (computed from BOLT_DATA_DIR, used to locate the file itself).
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  ['model', 'auth', 'local', 'search', 'agentPrompt', 'memory', 'tasks', 'tools', 'codeWorkflows', 'cli', 'channels'] satisfies (keyof Config)[]
);

// Validation constants — defined once, not recreated on every call.
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const VALID_AUTH_MODES = ['api-key', 'subscription', 'local'] as const;
const VALID_SEARCH_BACKENDS = ['keyword', 'embedding'] as const;
const VALID_SEARCH_PROVIDERS = ['searxng', 'brave', 'serper'] as const;
const VALID_WEB_MODES = ['http', 'websocket'] as const;

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== undefined &&
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === 'object' &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>
      );
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

function loadConfigFile(dataDir: string): Record<string, unknown> {
  const filePath = join(dataDir, 'config.json');
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ConfigError(`Failed to parse ${filePath}: invalid JSON`);
  }

  for (const field of CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      throw new ConfigError(
        `Credential field "${field}" must not be stored in ${filePath} — use environment variables instead`
      );
    }
  }

  // #1: Warn about unknown keys and strip them so they never reach the merged Config.
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) {
      filtered[key] = parsed[key];
    } else {
      process.stderr.write(
        `Warning: unknown config key "${key}" in ${filePath} will be ignored\n`
      );
    }
  }

  return filtered;
}

function applyEnvOverrides(config: Config): Config {
  // #2: All nested objects are explicitly spread to avoid aliasing.
  const result: Config = {
    ...config,
    auth: { ...config.auth },
    local: { ...config.local },
    search: { ...config.search },
    agentPrompt: { ...config.agentPrompt },
    memory: { ...config.memory },
    tasks: { ...config.tasks },
    tools: { ...config.tools, allowedTools: [...config.tools.allowedTools] },
    codeWorkflows: { ...config.codeWorkflows },
    cli: { ...config.cli },
    channels: { web: { ...config.channels.web } },
  };

  if (process.env['BOLT_MODEL']) {
    result.model = process.env['BOLT_MODEL'];
  }
  if (process.env['BOLT_LOG_LEVEL']) {
    result.logLevel = process.env['BOLT_LOG_LEVEL'] as Config['logLevel'];
  }
  if (process.env['BOLT_LOCAL_ENDPOINT']) {
    result.local.endpoint = process.env['BOLT_LOCAL_ENDPOINT'];
  }
  if (process.env['BOLT_WEB_TOKEN']) {
    result.channels.web.token = process.env['BOLT_WEB_TOKEN'];
  }

  return result;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${field} must be a positive integer, got: ${value}`);
  }
}

function validate(config: Config): void {
  const { compactThreshold } = config.memory;
  if (compactThreshold < 0 || compactThreshold > 1) {
    throw new ConfigError(
      `config.memory.compactThreshold must be between 0.0 and 1.0, got: ${compactThreshold}`
    );
  }

  validatePositiveInteger(config.memory.keepRecentMessages, 'config.memory.keepRecentMessages');
  validatePositiveInteger(config.memory.taskHistoryMessages, 'config.memory.taskHistoryMessages');
  validatePositiveInteger(config.memory.taskHistoryTokenBudget, 'config.memory.taskHistoryTokenBudget');
  validatePositiveInteger(config.tasks.maxSubtaskDepth, 'config.tasks.maxSubtaskDepth');
  validatePositiveInteger(config.tasks.maxRetries, 'config.tasks.maxRetries');
  validatePositiveInteger(config.codeWorkflows.testFixRetries, 'config.codeWorkflows.testFixRetries');

  if (!(VALID_LOG_LEVELS as readonly string[]).includes(config.logLevel)) {
    throw new ConfigError(
      `config.logLevel must be one of ${VALID_LOG_LEVELS.join(', ')}, got: ${config.logLevel}`
    );
  }

  if (config.auth.mode !== undefined && !(VALID_AUTH_MODES as readonly string[]).includes(config.auth.mode)) {
    throw new ConfigError(
      `config.auth.mode must be one of ${VALID_AUTH_MODES.join(', ')}, got: ${config.auth.mode}`
    );
  }

  if (!(VALID_SEARCH_BACKENDS as readonly string[]).includes(config.memory.searchBackend)) {
    throw new ConfigError(
      `config.memory.searchBackend must be one of ${VALID_SEARCH_BACKENDS.join(', ')}, got: ${config.memory.searchBackend}`
    );
  }

  if (!(VALID_SEARCH_PROVIDERS as readonly string[]).includes(config.search.provider)) {
    throw new ConfigError(
      `config.search.provider must be one of ${VALID_SEARCH_PROVIDERS.join(', ')}, got: ${config.search.provider}`
    );
  }

  if (!Number.isInteger(config.search.maxResults) || config.search.maxResults < 1) {
    throw new ConfigError(
      `config.search.maxResults must be a positive integer, got: ${config.search.maxResults}`
    );
  }

  if (!(VALID_WEB_MODES as readonly string[]).includes(config.channels.web.mode)) {
    throw new ConfigError(
      `config.channels.web.mode must be one of ${VALID_WEB_MODES.join(', ')}, got: ${config.channels.web.mode}`
    );
  }

  const { port } = config.channels.web;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `config.channels.web.port must be an integer between 1 and 65535, got: ${port}`
    );
  }

  if (config.tools.timeoutMs < 0) {
    throw new ConfigError(
      `config.tools.timeoutMs must be >= 0, got: ${config.tools.timeoutMs}`
    );
  }
}

export function resolveConfig(): Config {
  // #5: dataDir resolved once here — used for both file loading and the returned value.
  const dataDir = process.env['BOLT_DATA_DIR'] ?? '.bolt';
  const fileConfig = loadConfigFile(dataDir);
  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileConfig
  ) as unknown as Config;
  // Stamp the resolved dataDir directly; applyEnvOverrides does not re-read BOLT_DATA_DIR.
  merged.dataDir = dataDir;
  const withEnv = applyEnvOverrides(merged);
  validate(withEnv);
  return withEnv;
}
