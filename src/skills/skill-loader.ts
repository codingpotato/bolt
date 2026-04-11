import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import type { JSONSchema } from '../tools/tool';

export interface Skill {
  name: string;
  description: string;
  systemPrompt: string;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  allowedTools?: string[];
}

/**
 * Shape of a validated frontmatter block. All fields typed loosely to handle
 * arbitrary YAML before we validate structure.
 */
interface RawFrontmatter {
  name: unknown;
  description: unknown;
  input: unknown;
  output: unknown;
  allowedTools?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a map of field definitions (from the skill file `input` / `output`
 * section) into a JSON Schema `{ type: 'object', properties: {...}, required: [...] }`.
 *
 * A field is required when it has no `default` key.
 */
function fieldMapToJsonSchema(fields: Record<string, unknown>): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const [key, def] of Object.entries(fields)) {
    if (!isRecord(def)) continue;

    const prop: JSONSchema = {};
    if (typeof def['type'] === 'string') prop['type'] = def['type'];
    if (typeof def['description'] === 'string') prop['description'] = def['description'];
    if (Array.isArray(def['enum'])) prop['enum'] = def['enum'];

    properties[key] = prop;

    if (!('default' in def)) {
      required.push(key);
    }
  }

  const schema: JSONSchema = { type: 'object', properties };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

/**
 * Parse a raw `.skill.md` file string into a `Skill` object.
 *
 * Returns `null` (and emits no exception) if the file is structurally invalid
 * so the loader can skip bad files and continue.
 */
export function parseSkillFile(_filename: string, raw: string): Skill | null {
  // Split on frontmatter delimiters: must start with '---' on the first line.
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const [, yamlBlock, body] = match;

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBlock ?? '');
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const fm = parsed as unknown as RawFrontmatter;

  if (typeof fm.name !== 'string' || fm.name.trim() === '') return null;
  if (typeof fm.description !== 'string' || fm.description.trim() === '') return null;
  if (!isRecord(fm.input)) return null;
  if (!isRecord(fm.output)) return null;

  const allowedTools =
    Array.isArray(fm.allowedTools) && fm.allowedTools.every((t) => typeof t === 'string')
      ? (fm.allowedTools as string[])
      : fm.allowedTools === undefined
        ? undefined
        : null;

  // allowedTools must be string[] or absent — anything else is invalid
  if (allowedTools === null) return null;

  return {
    name: fm.name.trim(),
    description: fm.description.trim(),
    systemPrompt: (body ?? '').trim(),
    inputSchema: fieldMapToJsonSchema(fm.input),
    outputSchema: fieldMapToJsonSchema(fm.output),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  };
}

/**
 * Discover and load all `.skill.md` files from a single directory.
 * Files that fail to parse are skipped with a warning.
 * Returns an empty array if the directory does not exist.
 */
export async function loadSkillsFromDir(
  dir: string,
  warn: (msg: string) => void = () => {},
): Promise<Skill[]> {
  let files: string[];
  try {
    files = (await readdir(dir)) as string[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const skills: Skill[] = [];
  for (const file of files) {
    if (!file.endsWith('.skill.md')) continue;

    const filePath = join(dir, file);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      warn(`skills: failed to read ${filePath}`);
      continue;
    }

    const skill = parseSkillFile(file, content);
    if (!skill) {
      warn(`skills: invalid frontmatter in ${filePath} — skipping`);
      continue;
    }

    skills.push(skill);
  }
  return skills;
}
