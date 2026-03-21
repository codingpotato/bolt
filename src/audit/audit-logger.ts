import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Credential-like field name patterns — matched case-insensitively.
// The token pattern is intentionally narrow: only compound credential tokens
// (session, bot, auth, access, refresh, bearer, id) and the bare key "token"
// are redacted. Pagination fields like nextPageToken are preserved.
const CREDENTIAL_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /(?:session|bot|auth|access|refresh|bearer|id)[_-]?token/i,
  /^token$/i,
  /authorization/i,
  /credential/i,
];

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key));
}

function scrub(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = isCredentialKey(k) ? '[REDACTED]' : scrub(v);
  }
  return result;
}

export interface AuditEntry {
  ts: string;
  tool: string;
  input: unknown;
  result: unknown;
}

export interface ToolLogger {
  log(tool: string, input: unknown, result: unknown): Promise<void>;
}

export function createAuditLogger(dataDir: string): ToolLogger {
  const auditPath = join(dataDir, 'tool-audit.jsonl');

  // Lazy init: create the directory once on the first log call.
  // Shared promise ensures concurrent first calls don't race.
  let initPromise: Promise<void> | null = null;
  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(dataDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  return {
    async log(tool: string, input: unknown, result: unknown): Promise<void> {
      await ensureDir();

      const entry: AuditEntry = {
        ts: new Date().toISOString(),
        tool,
        input: scrub(input),
        result: scrub(result),
      };

      await appendFile(auditPath, JSON.stringify(entry) + '\n');
    },
  };
}
