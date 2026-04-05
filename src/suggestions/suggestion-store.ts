import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';

export interface Suggestion {
  id: string;
  createdAt: string;
  sessionId: string;
  taskId?: string;
  target: 'AGENT.md';
  content: string;
  reason: string;
  status: 'pending' | 'applied' | 'rejected';
}

export class SuggestionStore {
  constructor(
    private readonly storeDir: string,
    private readonly logger: Logger,
  ) {}

  async write(entry: Omit<Suggestion, 'id' | 'createdAt'>): Promise<string> {
    const id = randomUUID();
    const suggestion: Suggestion = {
      ...entry,
      id,
      createdAt: new Date().toISOString(),
    };
    await mkdir(this.storeDir, { recursive: true });
    await writeFile(
      join(this.storeDir, `${id}.json`),
      JSON.stringify(suggestion, null, 2),
      'utf-8',
    );
    return id;
  }

  async load(id: string): Promise<Suggestion> {
    const filePath = join(this.storeDir, `${id}.json`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(`Suggestion not found: ${id} (${String(err)})`);
    }
    return JSON.parse(raw) as Suggestion;
  }

  async loadAll(): Promise<Suggestion[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.storeDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const suggestions: Suggestion[] = [];
    for (const name of fileNames) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.storeDir, name), 'utf-8');
        suggestions.push(JSON.parse(raw) as Suggestion);
      } catch {
        this.logger.warn('Skipping unreadable or corrupt suggestion file', { file: name });
      }
    }
    return suggestions;
  }

  async updateStatus(id: string, status: 'applied' | 'rejected'): Promise<void> {
    const suggestion = await this.load(id);
    suggestion.status = status;
    await writeFile(
      join(this.storeDir, `${id}.json`),
      JSON.stringify(suggestion, null, 2),
      'utf-8',
    );
  }
}
