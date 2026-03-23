import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SuggestionStore } from './suggestion-store';

export interface AgentMdPaths {
  project: string;
  user: string;
}

export async function handleSuggestionsCli(
  args: string[],
  store: SuggestionStore,
  paths: AgentMdPaths,
  write: (line: string) => void,
): Promise<void> {
  const [subcommand, id] = args;

  if (subcommand === 'show') {
    await cmdShow(id ?? '', store, write);
  } else if (subcommand === 'apply') {
    await cmdApply(id ?? '', store, paths, write);
  } else if (subcommand === 'reject') {
    await cmdReject(id ?? '', store, write);
  } else if (subcommand === undefined || subcommand === 'list') {
    await cmdList(store, write);
  } else {
    write('Usage: bolt suggestions [list|show <id>|apply <id>|reject <id>]');
  }
}

async function cmdList(store: SuggestionStore, write: (line: string) => void): Promise<void> {
  const all = await store.loadAll();
  const pending = all.filter((s) => s.status === 'pending');
  if (pending.length === 0) {
    write('No pending suggestions.');
    return;
  }
  for (const s of pending) {
    const firstLine = s.reason.split('\n')[0] ?? '';
    write(`${s.id}  ${s.createdAt}  [${s.scope}]  ${firstLine}`);
  }
}

async function cmdShow(
  id: string,
  store: SuggestionStore,
  write: (line: string) => void,
): Promise<void> {
  let suggestion;
  try {
    suggestion = await store.load(id);
  } catch {
    write(`Error: Suggestion not found: ${id}`);
    return;
  }
  write(`ID:        ${suggestion.id}`);
  write(`Created:   ${suggestion.createdAt}`);
  write(`Scope:     ${suggestion.scope}`);
  write(`Status:    ${suggestion.status}`);
  write(`Target:    ${suggestion.target}`);
  write('');
  write('--- Content ---');
  write(suggestion.content);
  write('');
  write('--- Reason ---');
  write(suggestion.reason);
}

async function cmdApply(
  id: string,
  store: SuggestionStore,
  paths: AgentMdPaths,
  write: (line: string) => void,
): Promise<void> {
  let suggestion;
  try {
    suggestion = await store.load(id);
  } catch {
    write(`Error: Suggestion not found: ${id}`);
    return;
  }

  const targetPath = suggestion.scope === 'user' ? paths.user : paths.project;

  let existing = '';
  try {
    existing = await readFile(targetPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : existing.length > 0 ? '\n' : '';
  const updated = existing + separator + suggestion.content;

  await store.updateStatus(id, 'applied');
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, updated, 'utf-8');
  write(`Applied suggestion ${id} to ${targetPath}`);
}

async function cmdReject(
  id: string,
  store: SuggestionStore,
  write: (line: string) => void,
): Promise<void> {
  try {
    await store.load(id);
  } catch {
    write(`Error: Suggestion not found: ${id}`);
    return;
  }
  await store.updateStatus(id, 'rejected');
  write(`Rejected suggestion ${id}`);
}
