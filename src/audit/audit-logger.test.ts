import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { createAuditLogger } from './audit-logger';

vi.mock('node:fs');

describe('createAuditLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appends a JSON line to {dataDir}/tool-audit.jsonl', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('bash', { command: 'ls' }, { stdout: 'file.txt', exitCode: 0 });

    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledOnce();
    const [path, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    expect(path).toBe('.bolt/tool-audit.jsonl');
    expect(data).toMatch(/\n$/);
    const entry = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    expect(entry).toMatchObject({
      tool: 'bash',
      input: { command: 'ls' },
      result: { stdout: 'file.txt', exitCode: 0 },
    });
  });

  it('creates the data directory if it does not exist', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('bash', {}, {});
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith('.bolt', { recursive: true });
  });

  it('each entry has exactly ts, tool, input, result fields', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('file_read', { path: 'file.txt' }, { content: 'hello' });

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    expect(Object.keys(entry)).toEqual(['ts', 'tool', 'input', 'result']);
  });

  it('ts is a valid ISO 8601 timestamp', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('bash', {}, {});

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    expect(typeof entry.ts).toBe('string');
    expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
  });

  it('scrubs credential keys from input before logging', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('some_tool', { apiKey: 'sk-secret-123', command: 'ls' }, {});

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as { input: Record<string, unknown> };
    expect(entry.input['apiKey']).toBe('[REDACTED]');
    expect(entry.input['command']).toBe('ls');
  });

  it('scrubs credential keys from result before logging', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('some_tool', {}, { token: 'secret-token', status: 'ok' });

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as { result: Record<string, unknown> };
    expect(entry.result['token']).toBe('[REDACTED]');
    expect(entry.result['status']).toBe('ok');
  });

  it('scrubs nested credential fields', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log(
      'some_tool',
      { auth: { password: 'p@ss', username: 'admin' } },
      {}
    );

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as {
      input: { auth: Record<string, unknown> };
    };
    expect(entry.input.auth['password']).toBe('[REDACTED]');
    expect(entry.input.auth['username']).toBe('admin');
  });

  it('scrubs all known credential field name patterns', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log(
      'some_tool',
      {
        api_key: 'k1',
        secret: 'k2',
        password: 'k3',
        authorization: 'k4',
        credential: 'k5',
        safe_field: 'ok',
      },
      {}
    );

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as { input: Record<string, unknown> };
    expect(entry.input['api_key']).toBe('[REDACTED]');
    expect(entry.input['secret']).toBe('[REDACTED]');
    expect(entry.input['password']).toBe('[REDACTED]');
    expect(entry.input['authorization']).toBe('[REDACTED]');
    expect(entry.input['credential']).toBe('[REDACTED]');
    expect(entry.input['safe_field']).toBe('ok');
  });

  it('handles array values without scrubbing non-credential array items', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('some_tool', { items: ['a', 'b', 'c'] }, {});

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as { input: Record<string, unknown> };
    expect(entry.input['items']).toEqual(['a', 'b', 'c']);
  });

  it('handles non-object input and result', async () => {
    const logger = createAuditLogger('.bolt');
    await logger.log('some_tool', 'plain string input', 42);

    const [, data] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    const entry = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    expect(entry.input).toBe('plain string input');
    expect(entry.result).toBe(42);
  });

  it('uses a different dataDir correctly', async () => {
    const logger = createAuditLogger('/custom/data');
    await logger.log('bash', {}, {});

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith('/custom/data', { recursive: true });
    const [path] = vi.mocked(fs.appendFileSync).mock.calls[0] as [string, string];
    expect(path).toBe('/custom/data/tool-audit.jsonl');
  });
});
