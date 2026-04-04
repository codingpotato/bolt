import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

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
  workspace: {
    root: string;
  };
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
  comfyui: {
    servers: Array<{ url: string; weight: number }>;
    workflows: {
      text2img: string;
      img2video: string;
    };
    pollIntervalMs: number;
    timeoutMs: number;
    maxConcurrentPerServer: number;
  };
  ffmpeg: {
    /** Explicit path to ffmpeg binary. If omitted, resolved via system PATH. */
    path?: string;
    /** Default output video codec for re-encode operations. */
    videoCodec: string;
    /** Default CRF quality value (0–51; lower = better quality). */
    crf: number;
    /** Default encoding preset (ultrafast..veryslow). */
    preset: string;
    /** Default audio codec for operations that re-encode audio. */
    audioCodec: string;
    /** Default audio bitrate (e.g. "128k"). */
    audioBitrate: string;
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
      host?: string;
      mode: 'http' | 'websocket';
      token?: string;
    };
  };
}

const DEFAULTS: Config = {
  model: 'claude-opus-4-6',
  dataDir: '.bolt',
  logLevel: 'info',
  workspace: {
    root: process.cwd(),
  },
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
  comfyui: {
    servers: [],
    workflows: {
      text2img: 'image_z_image_turbo',
      img2video: 'video_ltx2_3_i2v',
    },
    pollIntervalMs: 2000,
    timeoutMs: 300000,
    maxConcurrentPerServer: 2,
  },
  ffmpeg: {
    videoCodec: 'libx264',
    crf: 23,
    preset: 'fast',
    audioCodec: 'aac',
    audioBitrate: '128k',
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
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'model',
  'dataDir',
  'logLevel',
  'workspace',
  'auth',
  'local',
  'search',
  'agentPrompt',
  'memory',
  'tasks',
  'tools',
  'comfyui',
  'ffmpeg',
  'codeWorkflows',
  'cli',
  'channels',
] satisfies (keyof Config)[]);

// Validation constants — defined once, not recreated on every call.
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const VALID_AUTH_MODES = ['api-key', 'subscription', 'local'] as const;
const VALID_SEARCH_BACKENDS = ['keyword', 'embedding'] as const;
const VALID_SEARCH_PROVIDERS = ['searxng', 'brave', 'serper'] as const;
const VALID_WEB_MODES = ['http', 'websocket'] as const;
const VALID_FFMPEG_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
] as const;

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
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
        overrideVal as Record<string, unknown>,
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
        `Credential field "${field}" must not be stored in ${filePath} — use environment variables instead`,
      );
    }
  }

  // #1: Warn about unknown keys and strip them so they never reach the merged Config.
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key)) {
      filtered[key] = parsed[key];
    } else {
      process.stderr.write(`Warning: unknown config key "${key}" in ${filePath} will be ignored\n`);
    }
  }

  return filtered;
}

function applyEnvOverrides(config: Config): Config {
  // #2: All nested objects are explicitly spread to avoid aliasing.
  const result: Config = {
    ...config,
    workspace: { ...config.workspace },
    auth: { ...config.auth },
    local: { ...config.local },
    search: { ...config.search },
    agentPrompt: { ...config.agentPrompt },
    memory: { ...config.memory },
    tasks: { ...config.tasks },
    tools: { ...config.tools, allowedTools: [...config.tools.allowedTools] },
    comfyui: {
      ...config.comfyui,
      servers: config.comfyui.servers.map((s) => ({ ...s })),
      workflows: { ...config.comfyui.workflows },
    },
    ffmpeg: { ...config.ffmpeg },
    codeWorkflows: { ...config.codeWorkflows },
    cli: { ...config.cli },
    channels: { web: { ...config.channels.web } },
  };

  // Workspace
  if (process.env['BOLT_WORKSPACE_ROOT']) {
    result.workspace.root = process.env['BOLT_WORKSPACE_ROOT'];
  }

  // Core
  if (process.env['BOLT_MODEL']) {
    result.model = process.env['BOLT_MODEL'];
  }
  if (process.env['BOLT_LOG_LEVEL']) {
    result.logLevel = process.env['BOLT_LOG_LEVEL'] as Config['logLevel'];
  }

  // Local inference
  if (process.env['BOLT_LOCAL_ENDPOINT']) {
    result.local.endpoint = process.env['BOLT_LOCAL_ENDPOINT'];
  }

  // Web search
  if (process.env['BOLT_SEARCH_PROVIDER']) {
    result.search.provider = process.env['BOLT_SEARCH_PROVIDER'] as Config['search']['provider'];
  }
  if (process.env['BOLT_SEARCH_ENDPOINT']) {
    result.search.endpoint = process.env['BOLT_SEARCH_ENDPOINT'];
  }
  if (process.env['BOLT_SEARCH_MAX_RESULTS']) {
    const parsed = parseInt(process.env['BOLT_SEARCH_MAX_RESULTS'], 10);
    if (!Number.isNaN(parsed)) {
      result.search.maxResults = parsed;
    }
  }

  // ComfyUI
  if (process.env['BOLT_COMFYUI_SERVERS']) {
    const urls = process.env['BOLT_COMFYUI_SERVERS']
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);
    result.comfyui.servers = urls.map((url) => ({ url, weight: 1 }));
  }
  if (process.env['BOLT_COMFYUI_TEXT2IMG_WORKFLOW']) {
    result.comfyui.workflows.text2img = process.env['BOLT_COMFYUI_TEXT2IMG_WORKFLOW'];
  }
  if (process.env['BOLT_COMFYUI_IMG2VIDEO_WORKFLOW']) {
    result.comfyui.workflows.img2video = process.env['BOLT_COMFYUI_IMG2VIDEO_WORKFLOW'];
  }
  if (process.env['BOLT_COMFYUI_POLL_INTERVAL_MS']) {
    const parsed = parseInt(process.env['BOLT_COMFYUI_POLL_INTERVAL_MS'], 10);
    if (!Number.isNaN(parsed)) {
      result.comfyui.pollIntervalMs = parsed;
    }
  }
  if (process.env['BOLT_COMFYUI_TIMEOUT_MS']) {
    const parsed = parseInt(process.env['BOLT_COMFYUI_TIMEOUT_MS'], 10);
    if (!Number.isNaN(parsed)) {
      result.comfyui.timeoutMs = parsed;
    }
  }
  if (process.env['BOLT_COMFYUI_MAX_CONCURRENT']) {
    const parsed = parseInt(process.env['BOLT_COMFYUI_MAX_CONCURRENT'], 10);
    if (!Number.isNaN(parsed)) {
      result.comfyui.maxConcurrentPerServer = parsed;
    }
  }

  // WebChannel
  if (process.env['BOLT_WEB_ENABLED']) {
    result.channels.web.enabled = process.env['BOLT_WEB_ENABLED'] === 'true';
  }
  if (process.env['BOLT_WEB_TOKEN']) {
    result.channels.web.token = process.env['BOLT_WEB_TOKEN'];
  }
  if (process.env['BOLT_WEB_HOST']) {
    result.channels.web.host = process.env['BOLT_WEB_HOST'];
  }
  if (process.env['BOLT_WEB_PORT']) {
    const parsed = parseInt(process.env['BOLT_WEB_PORT'], 10);
    if (!Number.isNaN(parsed)) {
      result.channels.web.port = parsed;
    }
  }
  if (process.env['BOLT_WEB_MODE']) {
    result.channels.web.mode = process.env['BOLT_WEB_MODE'] as Config['channels']['web']['mode'];
  }

  // FFmpeg
  if (process.env['BOLT_FFMPEG_PATH']) {
    result.ffmpeg.path = process.env['BOLT_FFMPEG_PATH'];
  }

  // Memory
  if (process.env['BOLT_MEMORY_COMPACT_THRESHOLD']) {
    const parsed = parseFloat(process.env['BOLT_MEMORY_COMPACT_THRESHOLD']);
    if (!Number.isNaN(parsed)) {
      result.memory.compactThreshold = parsed;
    }
  }
  if (process.env['BOLT_MEMORY_KEEP_RECENT']) {
    const parsed = parseInt(process.env['BOLT_MEMORY_KEEP_RECENT'], 10);
    if (!Number.isNaN(parsed)) {
      result.memory.keepRecentMessages = parsed;
    }
  }
  if (process.env['BOLT_MEMORY_SEARCH_BACKEND']) {
    result.memory.searchBackend = process.env[
      'BOLT_MEMORY_SEARCH_BACKEND'
    ] as Config['memory']['searchBackend'];
  }

  // Agent prompt
  if (process.env['BOLT_AGENT_PROJECT_FILE']) {
    result.agentPrompt.projectFile = process.env['BOLT_AGENT_PROJECT_FILE'];
  }
  if (process.env['BOLT_AGENT_USER_FILE']) {
    result.agentPrompt.userFile = process.env['BOLT_AGENT_USER_FILE'];
  }

  // Tasks & Tools
  if (process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH']) {
    const parsed = parseInt(process.env['BOLT_TASKS_MAX_SUBTASK_DEPTH'], 10);
    if (!Number.isNaN(parsed)) {
      result.tasks.maxSubtaskDepth = parsed;
    }
  }
  if (process.env['BOLT_TASKS_MAX_RETRIES']) {
    const parsed = parseInt(process.env['BOLT_TASKS_MAX_RETRIES'], 10);
    if (!Number.isNaN(parsed)) {
      result.tasks.maxRetries = parsed;
    }
  }
  if (process.env['BOLT_TOOLS_TIMEOUT_MS']) {
    const parsed = parseInt(process.env['BOLT_TOOLS_TIMEOUT_MS'], 10);
    if (!Number.isNaN(parsed)) {
      result.tools.timeoutMs = parsed;
    }
  }
  if (process.env['BOLT_TOOLS_ALLOWED']) {
    result.tools.allowedTools = process.env['BOLT_TOOLS_ALLOWED']
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Code workflows
  if (process.env['BOLT_CODE_TEST_FIX_RETRIES']) {
    const parsed = parseInt(process.env['BOLT_CODE_TEST_FIX_RETRIES'], 10);
    if (!Number.isNaN(parsed)) {
      result.codeWorkflows.testFixRetries = parsed;
    }
  }

  // CLI
  if (process.env['BOLT_CLI_PROGRESS']) {
    result.cli.progress = process.env['BOLT_CLI_PROGRESS'] === 'true';
  }
  if (process.env['BOLT_CLI_VERBOSE']) {
    result.cli.verbose = process.env['BOLT_CLI_VERBOSE'] === 'true';
  }

  return result;
}

function validatePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${field} must be a positive integer, got: ${value}`);
  }
}

function validate(config: Config): void {
  // Workspace root validation
  const workspaceRoot = config.workspace.root;
  if (!isAbsolute(workspaceRoot)) {
    throw new ConfigError(`config.workspace.root must be an absolute path, got: ${workspaceRoot}`);
  }
  if (!existsSync(workspaceRoot)) {
    throw new ConfigError(`config.workspace.root does not exist: ${workspaceRoot}`);
  }
  try {
    accessSync(workspaceRoot, constants.R_OK | constants.W_OK);
  } catch {
    throw new ConfigError(`config.workspace.root is not readable and writable: ${workspaceRoot}`);
  }

  const { compactThreshold } = config.memory;
  if (compactThreshold < 0 || compactThreshold > 1) {
    throw new ConfigError(
      `config.memory.compactThreshold must be between 0.0 and 1.0, got: ${compactThreshold}`,
    );
  }

  validatePositiveInteger(config.memory.keepRecentMessages, 'config.memory.keepRecentMessages');
  validatePositiveInteger(config.memory.taskHistoryMessages, 'config.memory.taskHistoryMessages');
  validatePositiveInteger(
    config.memory.taskHistoryTokenBudget,
    'config.memory.taskHistoryTokenBudget',
  );
  validatePositiveInteger(config.tasks.maxSubtaskDepth, 'config.tasks.maxSubtaskDepth');
  validatePositiveInteger(config.tasks.maxRetries, 'config.tasks.maxRetries');
  validatePositiveInteger(
    config.codeWorkflows.testFixRetries,
    'config.codeWorkflows.testFixRetries',
  );

  const { crf, preset } = config.ffmpeg;
  if (!Number.isInteger(crf) || crf < 0 || crf > 51) {
    throw new ConfigError(`config.ffmpeg.crf must be an integer between 0 and 51, got: ${crf}`);
  }
  if (!(VALID_FFMPEG_PRESETS as readonly string[]).includes(preset)) {
    throw new ConfigError(
      `config.ffmpeg.preset must be one of ${VALID_FFMPEG_PRESETS.join(', ')}, got: ${preset}`,
    );
  }

  if (!(VALID_LOG_LEVELS as readonly string[]).includes(config.logLevel)) {
    throw new ConfigError(
      `config.logLevel must be one of ${VALID_LOG_LEVELS.join(', ')}, got: ${config.logLevel}`,
    );
  }

  if (
    config.auth.mode !== undefined &&
    !(VALID_AUTH_MODES as readonly string[]).includes(config.auth.mode)
  ) {
    throw new ConfigError(
      `config.auth.mode must be one of ${VALID_AUTH_MODES.join(', ')}, got: ${config.auth.mode}`,
    );
  }

  if (!(VALID_SEARCH_BACKENDS as readonly string[]).includes(config.memory.searchBackend)) {
    throw new ConfigError(
      `config.memory.searchBackend must be one of ${VALID_SEARCH_BACKENDS.join(', ')}, got: ${config.memory.searchBackend}`,
    );
  }

  if (!(VALID_SEARCH_PROVIDERS as readonly string[]).includes(config.search.provider)) {
    throw new ConfigError(
      `config.search.provider must be one of ${VALID_SEARCH_PROVIDERS.join(', ')}, got: ${config.search.provider}`,
    );
  }

  if (!Number.isInteger(config.search.maxResults) || config.search.maxResults < 1) {
    throw new ConfigError(
      `config.search.maxResults must be a positive integer, got: ${config.search.maxResults}`,
    );
  }

  if (!(VALID_WEB_MODES as readonly string[]).includes(config.channels.web.mode)) {
    throw new ConfigError(
      `config.channels.web.mode must be one of ${VALID_WEB_MODES.join(', ')}, got: ${config.channels.web.mode}`,
    );
  }

  const { port } = config.channels.web;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `config.channels.web.port must be an integer between 1 and 65535, got: ${port}`,
    );
  }

  if (config.tools.timeoutMs < 0) {
    throw new ConfigError(`config.tools.timeoutMs must be >= 0, got: ${config.tools.timeoutMs}`);
  }

  config.comfyui.servers.forEach((server, i) => {
    if (!server.url) {
      throw new ConfigError(
        `config.comfyui.servers[${i}].url is required when ComfyUI servers are configured`,
      );
    }
    if (typeof server.weight !== 'number' || server.weight <= 0) {
      throw new ConfigError(
        `config.comfyui.servers[${i}].weight must be a positive number, got: ${server.weight}`,
      );
    }
  });

  if (config.comfyui.servers.length > 0) {
    validatePositiveInteger(config.comfyui.pollIntervalMs, 'config.comfyui.pollIntervalMs');
    validatePositiveInteger(config.comfyui.timeoutMs, 'config.comfyui.timeoutMs');
    validatePositiveInteger(
      config.comfyui.maxConcurrentPerServer,
      'config.comfyui.maxConcurrentPerServer',
    );
  }
}

export function resolveConfig(): Config {
  // #5: Resolve workspace root first (needed to resolve relative dataDir).
  // Order: BOLT_WORKSPACE_ROOT env var > process.cwd()
  // (config file workspace.root applied after loading)
  const envWorkspaceRoot = process.env['BOLT_WORKSPACE_ROOT'];
  let workspaceRoot = envWorkspaceRoot ?? process.cwd();

  // Resolve dataDir relative to workspace root (absolute paths used as-is).
  const rawDataDir = process.env['BOLT_DATA_DIR'] ?? '.bolt';
  let dataDir = isAbsolute(rawDataDir) ? rawDataDir : join(workspaceRoot, rawDataDir);

  const fileConfig = loadConfigFile(dataDir);

  // If config file specifies workspace.root, apply it and re-resolve dataDir
  // if it was relative (so dataDir stays relative to the final workspace root).
  if (
    typeof fileConfig.workspace === 'object' &&
    fileConfig.workspace !== null &&
    'root' in fileConfig.workspace &&
    typeof (fileConfig.workspace as Record<string, unknown>).root === 'string'
  ) {
    workspaceRoot = (fileConfig.workspace as Record<string, unknown>).root as string;
    if (!isAbsolute(rawDataDir) && !envWorkspaceRoot) {
      dataDir = join(workspaceRoot, rawDataDir);
    }
  }

  const merged = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    fileConfig,
  ) as unknown as Config;
  merged.dataDir = dataDir;
  merged.workspace.root = workspaceRoot;

  const withEnv = applyEnvOverrides(merged);
  validate(withEnv);
  return withEnv;
}
