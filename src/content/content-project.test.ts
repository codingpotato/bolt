import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generateProjectId,
  ContentProjectManager,
  type ContentProject,
  type Storyboard,
} from './content-project';

describe('generateProjectId', () => {
  it('generates a slug from topic with date suffix', () => {
    const id = generateProjectId('AI Coding Trends');
    expect(id).toMatch(/^ai-coding-trends-\d{4}-\d{2}-\d{2}$/);
  });

  it('handles special characters', () => {
    const id = generateProjectId('Hello, World! @#$% Testing');
    expect(id).toMatch(/^hello-world-testing-\d{4}-\d{2}-\d{2}$/);
  });

  it('truncates long topics', () => {
    const longTopic = 'a'.repeat(100);
    const id = generateProjectId(longTopic);
    expect(id.length).toBeLessThanOrEqual(61); // 50 chars + date suffix
  });

  it('handles empty topic', () => {
    const id = generateProjectId('');
    expect(id).toMatch(/^-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ContentProjectManager', () => {
  const testDir = join(__dirname, '.test-content-project');
  let manager: ContentProjectManager;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    manager = new ContentProjectManager(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createProject', () => {
    it('creates a project directory with manifest', async () => {
      const project = await manager.createProject('AI Coding Trends');

      expect(project.id).toMatch(/^ai-coding-trends-\d{4}-\d{2}-\d{2}$/);
      expect(project.title).toBe('AI Coding Trends');
      expect(project.topic).toBe('AI Coding Trends');
      expect(project.dir).toBe(join(testDir, 'projects', project.id));
      expect(project.artifacts.scenes).toEqual([]);
    });

    it('creates a tasks.json file with empty tasks and counter 0', async () => {
      const project = await manager.createProject('Task File Test');
      const tasksPath = join(project.dir, 'tasks.json');
      const raw = await readFile(tasksPath, 'utf-8');
      const parsed = JSON.parse(raw) as { tasks: unknown[]; counter: number };
      expect(parsed.tasks).toEqual([]);
      expect(parsed.counter).toBe(0);
    });

    it('creates scenes and final subdirectories', async () => {
      const project = await manager.createProject('Test Topic');
      const scenesDir = join(project.dir, 'scenes');
      const finalDir = join(project.dir, 'final');

      // Should not throw when trying to access these dirs
      const stat = await import('node:fs/promises').then((fs) => fs.stat);
      await expect(stat(scenesDir)).resolves.toBeDefined();
      await expect(stat(finalDir)).resolves.toBeDefined();
    });

    it('uses custom title when provided', async () => {
      const project = await manager.createProject('test topic', 'Custom Title');
      expect(project.title).toBe('Custom Title');
      expect(project.topic).toBe('test topic');
    });

    it('disambiguates project ID when creating same topic on same day', async () => {
      // Create first project
      const project1 = await manager.createProject('Duplicate Topic');
      expect(project1.id).toMatch(/^duplicate-topic-\d{4}-\d{2}-\d{2}$/);

      // Create second project with same topic
      const project2 = await manager.createProject('Duplicate Topic');
      expect(project2.id).toMatch(/^duplicate-topic-\d{4}-\d{2}-\d{2}-2$/);

      // Create third project
      const project3 = await manager.createProject('Duplicate Topic');
      expect(project3.id).toMatch(/^duplicate-topic-\d{4}-\d{2}-\d{2}-3$/);

      // All should have different IDs and directories
      expect(project1.id).not.toBe(project2.id);
      expect(project2.id).not.toBe(project3.id);
      expect(project1.dir).not.toBe(project2.dir);
    });

    it('preserves existing project data when creating duplicate', async () => {
      // Create first project and add some data
      const project1 = await manager.createProject('Test Data');
      project1.title = 'Modified Title';
      await manager.writeManifest(project1);

      // Create second project with same topic
      const project2 = await manager.createProject('Test Data');

      // First project should be unchanged
      const readProject1 = await manager.readProject(project1.id);
      expect(readProject1?.title).toBe('Modified Title');

      // Second project should be separate
      expect(project2.id).not.toBe(project1.id);
      const readProject2 = await manager.readProject(project2.id);
      expect(readProject2?.title).toBe('Test Data');
    });
  });

  describe('readProject', () => {
    it('returns undefined for non-existent project', async () => {
      const project = await manager.readProject('non-existent');
      expect(project).toBeUndefined();
    });

    it('reads an existing project manifest', async () => {
      const created = await manager.createProject('Test Topic');
      const read = await manager.readProject(created.id);

      expect(read).toBeDefined();
      expect(read?.id).toBe(created.id);
      expect(read?.title).toBe('Test Topic');
      expect(read?.topic).toBe('Test Topic');
    });
  });

  describe('writeManifest', () => {
    it('persists changes to the manifest', async () => {
      const project = await manager.createProject('Test Topic');
      project.title = 'Updated Title';
      await manager.writeManifest(project);

      const read = await manager.readProject(project.id);
      expect(read?.title).toBe('Updated Title');
    });

    it('updates updatedAt timestamp', async () => {
      const project = await manager.createProject('Test Topic');
      const originalUpdatedAt = project.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));
      await manager.writeManifest(project);

      expect(project.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  describe('updateArtifactStatus', () => {
    let project: ContentProject;

    beforeEach(async () => {
      project = await manager.createProject('Test Topic');
    });

    it('updates trendReport status', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'draft',
      };
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, '01-trend-report.md', 'approved');

      expect(project.artifacts.trendReport?.status).toBe('approved');
      expect(project.artifacts.trendReport?.approvedAt).toBeDefined();
    });

    it('updates scene image status', async () => {
      project.artifacts.scenes = [
        {
          sceneNumber: 1,
          image: { path: 'scenes/scene-01/image.png', status: 'draft' },
        },
      ];
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, 'scenes/scene-01/image.png', 'approved');

      const scene = project.artifacts.scenes[0];
      expect(scene).toBeDefined();
      expect(scene?.image?.status).toBe('approved');
    });

    it('updates scene clip status', async () => {
      project.artifacts.scenes = [
        {
          sceneNumber: 1,
          clip: { path: 'scenes/scene-01/clip.mp4', status: 'draft' },
        },
      ];
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, 'scenes/scene-01/clip.mp4', 'failed');

      const scene = project.artifacts.scenes[0];
      expect(scene).toBeDefined();
      expect(scene?.clip?.status).toBe('failed');
    });

    it('updates post-production rawVideo status', async () => {
      project.artifacts.postProduction = {
        rawVideo: { path: 'final/raw.mp4', status: 'draft' },
      };
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');

      expect(project.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    });

    it('clears approvedAt when status changes from approved to draft', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'approved',
        approvedAt: '2026-04-01T12:00:00Z',
      };
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, '01-trend-report.md', 'draft');

      expect(project.artifacts.trendReport?.status).toBe('draft');
      expect(project.artifacts.trendReport?.approvedAt).toBeUndefined();
    });

    it('clears approvedAt when status changes from approved to failed', async () => {
      project.artifacts.scenes = [
        {
          sceneNumber: 1,
          image: {
            path: 'scenes/scene-01/image.png',
            status: 'approved',
            approvedAt: '2026-04-01T12:00:00Z',
          },
        },
      ];
      await manager.writeManifest(project);

      await manager.updateArtifactStatus(project, 'scenes/scene-01/image.png', 'failed');

      const scene = project.artifacts.scenes[0];
      expect(scene?.image?.status).toBe('failed');
      expect(scene?.image?.approvedAt).toBeUndefined();
    });

    it('returns true when artifact is found and updated', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'draft',
      };
      await manager.writeManifest(project);

      const result = await manager.updateArtifactStatus(project, '01-trend-report.md', 'approved');

      expect(result).toBe(true);
    });

    it('returns false when artifact is not found', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'draft',
      };
      await manager.writeManifest(project);

      const result = await manager.updateArtifactStatus(project, 'non-existent.md', 'approved');

      expect(result).toBe(false);
    });
  });

  describe('initializeScenes', () => {
    it('creates SceneArtifacts from storyboard', async () => {
      const project = await manager.createProject('Test Topic');
      const storyboard: Storyboard = {
        title: 'Test Video',
        summary: 'A test video',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [
          {
            sceneNumber: 1,
            description: 'Scene 1',
            camera: 'wide shot',
            duration: '5s',
            imagePromptHint: 'test hint',
          },
          {
            sceneNumber: 2,
            description: 'Scene 2',
            camera: 'close-up',
            duration: '5s',
            imagePromptHint: 'test hint 2',
          },
        ],
      };

      await manager.initializeScenes(project, storyboard);

      expect(project.artifacts.scenes).toHaveLength(2);
      const scene0 = project.artifacts.scenes[0];
      const scene1 = project.artifacts.scenes[1];
      expect(scene0).toBeDefined();
      expect(scene1).toBeDefined();
      expect(scene0!.sceneNumber).toBe(1);
      expect(scene1!.sceneNumber).toBe(2);
    });
  });

  describe('getProjectFilePath', () => {
    it('returns the absolute path for a project file', () => {
      const path = manager.getProjectFilePath('my-project', 'scenes/scene-01/image.png');
      expect(path).toBe(join(testDir, 'projects', 'my-project', 'scenes', 'scene-01', 'image.png'));
    });

    it('throws error for path traversal attempt with ../', () => {
      expect(() => manager.getProjectFilePath('my-project', '../secrets.txt')).toThrow(
        'Path traversal attempt detected',
      );
    });

    it('throws error for path traversal attempt with multiple ../', () => {
      expect(() => manager.getProjectFilePath('my-project', '../../etc/passwd')).toThrow(
        'Path traversal attempt detected',
      );
    });

    it('throws error for path traversal attempt with mixed path', () => {
      expect(() => manager.getProjectFilePath('my-project', 'scenes/../../../secrets.txt')).toThrow(
        'Path traversal attempt detected',
      );
    });

    it('accepts valid paths with dots in filename', () => {
      const path = manager.getProjectFilePath('my-project', 'file.backup.txt');
      expect(path).toBe(join(testDir, 'projects', 'my-project', 'file.backup.txt'));
    });

    it('normalizes path with ./ prefix', () => {
      const path = manager.getProjectFilePath('my-project', './scenes/image.png');
      expect(path).toBe(join(testDir, 'projects', 'my-project', 'scenes', 'image.png'));
    });
  });
});
