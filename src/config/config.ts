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
  local: {
    endpoint?: string;
  };
  memory: {
    compactThreshold: number;
    keepRecentMessages: number;
    storePath: string;
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
  channels: {
    web: {
      enabled: boolean;
      port: number;
      mode: 'http' | 'websocket';
    };
  };
}

const DEFAULTS: Config = {
  model: 'claude-opus-4-6',
  dataDir: '.bolt',
  logLevel: 'info',
  local: {},
  memory: {
    compactThreshold: 0.8,
    keepRecentMessages: 10,
    storePath: 'memory',
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

// Top-level keys recognized in .bolt/config.json
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'model',
  'local',
  'memory',
  'tasks',
  'tools',
  'codeWorkflows',
  'channels',
]);

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
    throw new ConfigError(
      `Failed to parse ${filePath}: invalid JSON`
    );
  }

  for (const field of CREDENTIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(parsed, field)) {
      throw new ConfigError(
        `Credential field "${field}" must not be stored in ${filePath} — use environment variables instead`
      );
    }
  }

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      process.stderr.write(
        `Warning: unknown config key "${key}" in ${filePath} will be ignored\n`
      );
    }
  }

  return parsed;
}

function applyEnvOverrides(config: Config): Config {
  const result: Config = {
    ...config,
    local: { ...config.local },
    memory: { ...config.memory },
    tasks: { ...config.tasks },
    tools: { ...config.tools, allowedTools: [...config.tools.allowedTools] },
    codeWorkflows: { ...config.codeWorkflows },
    channels: { web: { ...config.channels.web } },
  };

  if (process.env['BOLT_MODEL']) {
    result.model = process.env['BOLT_MODEL'];
  }
  if (process.env['BOLT_DATA_DIR']) {
    result.dataDir = process.env['BOLT_DATA_DIR'];
  }
  if (process.env['BOLT_LOG_LEVEL']) {
    result.logLevel = process.env['BOLT_LOG_LEVEL'] as Config['logLevel'];
  }
  if (process.env['BOLT_LOCAL_ENDPOINT']) {
    result.local.endpoint = process.env['BOLT_LOCAL_ENDPOINT'];
  }

  return result;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(
      `${field} must be a positive integer, got: ${value}`
    );
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
  validatePositiveInteger(config.tasks.maxSubtaskDepth, 'config.tasks.maxSubtaskDepth');
  validatePositiveInteger(config.tasks.maxRetries, 'config.tasks.maxRetries');
  validatePositiveInteger(config.codeWorkflows.testFixRetries, 'config.codeWorkflows.testFixRetries');

  const validLogLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLogLevels.includes(config.logLevel)) {
    throw new ConfigError(
      `config.logLevel must be one of ${validLogLevels.join(', ')}, got: ${config.logLevel}`
    );
  }

  const validSearchBackends = ['keyword', 'embedding'];
  if (!validSearchBackends.includes(config.memory.searchBackend)) {
    throw new ConfigError(
      `config.memory.searchBackend must be one of ${validSearchBackends.join(', ')}, got: ${config.memory.searchBackend}`
    );
  }

  const validWebModes = ['http', 'websocket'];
  if (!validWebModes.includes(config.channels.web.mode)) {
    throw new ConfigError(
      `config.channels.web.mode must be one of ${validWebModes.join(', ')}, got: ${config.channels.web.mode}`
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
  // #1: Resolve dataDir from env first so config file is read from the right place
  const dataDir = process.env['BOLT_DATA_DIR'] ?? '.bolt';
  const fileConfig = loadConfigFile(dataDir);
  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileConfig
  ) as unknown as Config;
  const withEnv = applyEnvOverrides(merged);
  validate(withEnv);
  return withEnv;
}
