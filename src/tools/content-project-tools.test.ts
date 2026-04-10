import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContentProjectTools } from './content-project-tools';
import type { ToolContext } from './tool';
import type { ContentProject } from '../content/content-project';
import type { TaskRegistry } from '../tasks/task-registry';

describe('createContentProjectTools', () => {
  const testDir = join(__dirname, '.test-content-project-tools');
  let ctx: ToolContext;
  let tools: ReturnType<typeof createContentProjectTools>;
  let mockRegistry: TaskRegistry;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    mockRegistry = {
      registerProject: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskRegistry;
    tools = createContentProjectTools(mockRegistry);
    ctx = {
      cwd: testDir,
      log: { log: vi.fn().mockResolvedValue(undefined) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      progress: {
        onSessionStart: vi.fn(),
        onThinking: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onTaskStatusChange: vi.fn(),
        onContextInjection: vi.fn(),
        onMemoryCompaction: vi.fn(),
        onLlmCall: vi.fn(),
        onLlmResponse: vi.fn(),
        onRetry: vi.fn(),
        onSubagentStart: vi.fn(),
        onSubagentEnd: vi.fn(),
        onSubagentError: vi.fn(),
        onSubagentThinking: vi.fn(),
        onSubagentToolCall: vi.fn(),
        onSubagentToolResult: vi.fn(),
        onSubagentRetry: vi.fn(),
      },
    };
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns three tools with correct names', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('content_project_create');
    expect(names).toContain('content_project_read');
    expect(names).toContain('content_project_update_artifact');
  });

  it('content_project_create and content_project_update_artifact are sequential', () => {
    const create = tools.find((t) => t.name === 'content_project_create');
    const update = tools.find((t) => t.name === 'content_project_update_artifact');
    expect(create?.sequential).toBe(true);
    expect(update?.sequential).toBe(true);
  });

  describe('content_project_create', () => {
    it('creates a project directory and manifest, returns projectId, manifestPath, projectDir', async () => {
      const tool = tools.find((t) => t.name === 'content_project_create')!;
      const result = (await tool.execute({ topic: 'AI Coding Trends' }, ctx)) as {
        projectId: string;
        manifestPath: string;
        tasksPath: string;
        projectDir: string;
      };

      expect(result.projectId).toMatch(/^ai-coding-trends-\d{4}-\d{2}-\d{2}$/);
      expect(result.manifestPath).toBe(`projects/${result.projectId}/project.json`);
      expect(result.tasksPath).toBe(`projects/${result.projectId}/tasks.json`);
      expect(result.projectDir).toBe(join(testDir, 'projects', result.projectId));
      expect(mockRegistry.registerProject).toHaveBeenCalledWith(
        result.projectId,
        result.projectDir,
      );
    });

    it('uses title when provided', async () => {
      const tool = tools.find((t) => t.name === 'content_project_create')!;
      const result = (await tool.execute(
        { topic: 'AI Coding Trends', title: 'My Custom Title' },
        ctx,
      )) as { projectId: string };
      expect(result.projectId).toMatch(/^ai-coding-trends-\d{4}-\d{2}-\d{2}$/);
    });

    it('disambiguates duplicate project IDs with a suffix', async () => {
      const tool = tools.find((t) => t.name === 'content_project_create')!;
      const r1 = (await tool.execute({ topic: 'Test Topic' }, ctx)) as { projectId: string };
      const r2 = (await tool.execute({ topic: 'Test Topic' }, ctx)) as { projectId: string };
      expect(r1.projectId).not.toBe(r2.projectId);
      expect(r2.projectId).toMatch(/-2$/);
    });
  });

  describe('content_project_read', () => {
    it('returns the manifest for an existing project', async () => {
      const createTool = tools.find((t) => t.name === 'content_project_create')!;
      const readTool = tools.find((t) => t.name === 'content_project_read')!;

      const { projectId } = (await createTool.execute({ topic: 'Read Test' }, ctx)) as {
        projectId: string;
      };
      const manifest = (await readTool.execute({ projectId }, ctx)) as ContentProject;

      expect(manifest.id).toBe(projectId);
      expect(manifest.topic).toBe('Read Test');
      expect(manifest.artifacts.scenes).toEqual([]);
    });

    it('throws a non-retryable ToolError when project does not exist', async () => {
      const tool = tools.find((t) => t.name === 'content_project_read')!;
      await expect(tool.execute({ projectId: 'nonexistent-project' }, ctx)).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
        retryable: false,
      });
    });
  });

  describe('content_project_update_artifact', () => {
    it('returns { updated: false } when artifact does not exist in manifest', async () => {
      const createTool = tools.find((t) => t.name === 'content_project_create')!;
      const updateTool = tools.find((t) => t.name === 'content_project_update_artifact')!;

      const { projectId } = (await createTool.execute({ topic: 'Update Test' }, ctx)) as {
        projectId: string;
      };
      const result = (await updateTool.execute(
        { projectId, artifactPath: '01-trend-report.md', status: 'draft' },
        ctx,
      )) as { updated: boolean };
      expect(result.updated).toBe(false);
    });

    it('updates an artifact status and returns { updated: true }', async () => {
      const createTool = tools.find((t) => t.name === 'content_project_create')!;
      const readTool = tools.find((t) => t.name === 'content_project_read')!;
      const updateTool = tools.find((t) => t.name === 'content_project_update_artifact')!;

      const { projectId } = (await createTool.execute({ topic: 'Update Test' }, ctx)) as {
        projectId: string;
      };

      // Manually add an artifact to the manifest so we can update it
      const manifest = (await readTool.execute({ projectId }, ctx)) as ContentProject;
      manifest.artifacts.trendReport = { path: '01-trend-report.md', status: 'pending' };
      await writeFile(
        join(testDir, 'projects', projectId, 'project.json'),
        JSON.stringify(manifest, null, 2),
      );

      const result = (await updateTool.execute(
        { projectId, artifactPath: '01-trend-report.md', status: 'approved' },
        ctx,
      )) as { updated: boolean };
      expect(result.updated).toBe(true);

      // Verify the manifest was updated on disk
      const updated = (await readTool.execute({ projectId }, ctx)) as ContentProject;
      expect(updated.artifacts.trendReport?.status).toBe('approved');
      expect(updated.artifacts.trendReport?.approvedAt).toBeDefined();
    });

    it('throws a non-retryable ToolError when project does not exist', async () => {
      const tool = tools.find((t) => t.name === 'content_project_update_artifact')!;
      await expect(
        tool.execute(
          { projectId: 'no-such-project', artifactPath: 'foo.md', status: 'draft' },
          ctx,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('not found'),
        retryable: false,
      });
    });
  });
});
