import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:fs/promises');

import { loadSkills, parseSkillFile } from './skill-loader';

// ── parseSkillFile ────────────────────────────────────────────────────────────

describe('parseSkillFile', () => {
  it('parses a complete skill file', () => {
    const raw = `---
name: write-blog-post
description: Draft a long-form blog post
input:
  topic:
    type: string
    description: The subject to write about
  tone:
    type: string
    enum: [professional, casual, technical]
    default: professional
output:
  post:
    type: string
    description: The finished blog post in Markdown
allowedTools:
  - web_fetch
  - web_search
---

You are a skilled content writer.`;

    const skill = parseSkillFile('write-blog-post.skill.md', raw);
    expect(skill).toMatchObject({
      name: 'write-blog-post',
      description: 'Draft a long-form blog post',
      systemPrompt: 'You are a skilled content writer.',
      allowedTools: ['web_fetch', 'web_search'],
    });
  });

  it('converts input fields to a JSON Schema object', () => {
    const raw = `---
name: my-skill
description: test
input:
  query:
    type: string
    description: Search query
output:
  result:
    type: string
---
body`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.inputSchema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    });
  });

  it('converts output fields to a JSON Schema object', () => {
    const raw = `---
name: my-skill
description: test
input:
  q:
    type: string
output:
  answer:
    type: string
    description: The answer
---
body`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.outputSchema).toEqual({
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The answer' },
      },
      required: ['answer'],
    });
  });

  it('excludes fields with a default from required', () => {
    const raw = `---
name: my-skill
description: test
input:
  required_field:
    type: string
  optional_field:
    type: string
    default: hello
output:
  result:
    type: string
---
body`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.inputSchema.required).toEqual(['required_field']);
  });

  it('includes enum in property schema', () => {
    const raw = `---
name: my-skill
description: test
input:
  tone:
    type: string
    enum: [casual, formal]
output:
  text:
    type: string
---
body`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.inputSchema.properties?.['tone']).toMatchObject({
      type: 'string',
      enum: ['casual', 'formal'],
    });
  });

  it('sets allowedTools to undefined when not specified', () => {
    const raw = `---
name: my-skill
description: test
input:
  q:
    type: string
output:
  r:
    type: string
---
body`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.allowedTools).toBeUndefined();
  });

  it('trims leading/trailing whitespace from systemPrompt', () => {
    const raw = `---
name: my-skill
description: test
input:
  q:
    type: string
output:
  r:
    type: string
---

  You are a helper.
`;

    const skill = parseSkillFile('my-skill.skill.md', raw);
    expect(skill?.systemPrompt).toBe('You are a helper.');
  });

  it('returns null when name is missing', () => {
    const raw = `---
description: missing name
input:
  q:
    type: string
output:
  r:
    type: string
---
body`;

    const skill = parseSkillFile('bad.skill.md', raw);
    expect(skill).toBeNull();
  });

  it('returns null when description is missing', () => {
    const raw = `---
name: my-skill
input:
  q:
    type: string
output:
  r:
    type: string
---
body`;

    const skill = parseSkillFile('bad.skill.md', raw);
    expect(skill).toBeNull();
  });

  it('returns null when input is missing', () => {
    const raw = `---
name: my-skill
description: test
output:
  r:
    type: string
---
body`;

    const skill = parseSkillFile('bad.skill.md', raw);
    expect(skill).toBeNull();
  });

  it('returns null when output is missing', () => {
    const raw = `---
name: my-skill
description: test
input:
  q:
    type: string
---
body`;

    const skill = parseSkillFile('bad.skill.md', raw);
    expect(skill).toBeNull();
  });

  it('returns null when frontmatter is invalid YAML', () => {
    const raw = `---
: invalid: yaml: :::
---
body`;

    const skill = parseSkillFile('bad.skill.md', raw);
    expect(skill).toBeNull();
  });

  it('returns null when file has no frontmatter delimiters', () => {
    const skill = parseSkillFile('bad.skill.md', 'just a body, no frontmatter');
    expect(skill).toBeNull();
  });
});

// ── loadSkills ────────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  const projectSkillsDir = '/project/.bolt/skills';
  const userSkillsDir = '/home/user/.bolt/skills';

  const validSkillContent = `---
name: my-skill
description: A test skill
input:
  query:
    type: string
output:
  result:
    type: string
---
Do the thing.`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads skills from projectSkillsDir', async () => {
    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === projectSkillsDir) return ['my-skill.skill.md'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockResolvedValue(validSkillContent);

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('my-skill');
  });

  it('loads skills from userSkillsDir', async () => {
    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === userSkillsDir) return ['my-skill.skill.md'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockResolvedValue(validSkillContent);

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('my-skill');
  });

  it('projectSkillsDir wins on name collision', async () => {
    const projectContent = validSkillContent;
    const userContent = `---
name: my-skill
description: User version
input:
  query:
    type: string
output:
  result:
    type: string
---
User version prompt.`;

    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === projectSkillsDir) return ['my-skill.skill.md'] as never;
      if (dir === userSkillsDir) return ['my-skill.skill.md'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockImplementation(async (filePath: unknown) => {
      if (String(filePath).startsWith(projectSkillsDir)) return projectContent as never;
      return userContent as never;
    });

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe('A test skill');
  });

  it('ignores files that are not .skill.md', async () => {
    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === projectSkillsDir)
        return ['my-skill.skill.md', 'README.md', 'notes.txt'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockResolvedValue(validSkillContent);

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toHaveLength(1);
  });

  it('skips a skill file with invalid frontmatter and continues loading others', async () => {
    const invalidContent = `---
: bad yaml :::
---
body`;

    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === projectSkillsDir)
        return ['bad.skill.md', 'my-skill.skill.md'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockImplementation(async (filePath: unknown) => {
      if (String(filePath).includes('bad')) return invalidContent as never;
      return validSkillContent as never;
    });

    const warn = vi.fn();
    const skills = await loadSkills(projectSkillsDir, userSkillsDir, warn);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('my-skill');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad.skill.md'));
  });

  it('returns empty array when both directories are missing', async () => {
    vi.mocked(fsPromises.readdir).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toEqual([]);
  });

  it('returns empty array when both directories are empty', async () => {
    vi.mocked(fsPromises.readdir).mockResolvedValue([] as never);

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toEqual([]);
  });

  it('merges skills from both directories (non-colliding names)', async () => {
    const skill2Content = `---
name: other-skill
description: Another skill
input:
  x:
    type: string
output:
  y:
    type: string
---
Other prompt.`;

    vi.mocked(fsPromises.readdir).mockImplementation(async (dir) => {
      if (dir === projectSkillsDir) return ['my-skill.skill.md'] as never;
      if (dir === userSkillsDir) return ['other-skill.skill.md'] as never;
      return [] as never;
    });
    vi.mocked(fsPromises.readFile).mockImplementation(async (filePath: unknown) => {
      if (String(filePath).includes('other')) return skill2Content as never;
      return validSkillContent as never;
    });

    const skills = await loadSkills(projectSkillsDir, userSkillsDir);
    expect(skills).toHaveLength(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['my-skill', 'other-skill']);
  });
});
