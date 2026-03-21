import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Credential-like field name patterns — matched case-insensitively.
// Covers common names for API keys, tokens, secrets, passwords, and auth headers.
const CREDENTIAL_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
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

  return {
    async log(tool: string, input: unknown, result: unknown): Promise<void> {
      mkdirSync(dataDir, { recursive: true });

      const entry: AuditEntry = {
        ts: new Date().toISOString(),
        tool,
        input: scrub(input),
        result: scrub(result),
      };

      appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    },
  };
}
