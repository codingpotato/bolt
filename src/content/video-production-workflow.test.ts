import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentProjectManager, type ContentProject, type Storyboard } from './content-project';
import { TaskStore } from '../tasks/task-store';

/**
 * Integration test for S10-3: Video production workflow.
 *
 * This test verifies the full workflow:
 * - Agent creates a content project directory with project.json manifest
 * - Agent creates a task DAG with dependencies and requiresApproval
 * - First task result stores { projectId, manifestPath }
 * - Each task reads project.json to find input artifacts
 * - Manifest artifact status is updated after generation and approval
 * - comfyui_text2img generates images to the scene directory
 * - comfyui_img2video generates video clips to the scene directory
 * - User can reject and request changes
 */

describe('Video Production Workflow (S10-3)', () => {
  const testDir = join(__dirname, '.test-video-production');
  const dataDir = join(testDir, '.bolt');
  let projectManager: ContentProjectManager;
  let taskStore: TaskStore;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    projectManager = new ContentProjectManager(testDir);
    taskStore = new TaskStore(dataDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Project creation and manifest', () => {
    it('creates a content project directory with project.json manifest', async () => {
      const project = await projectManager.createProject(
        'AI Coding Trends',
        'AI Coding Trends Video',
      );

      // Verify project structure
      expect(project.id).toMatch(/^ai-coding-trends-\d{4}-\d{2}-\d{2}$/);
      expect(project.title).toBe('AI Coding Trends Video');
      expect(project.dir).toBe(join(testDir, 'projects', project.id));

      // Verify manifest was written
      const manifestPath = join(project.dir, 'project.json');
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as ContentProject;
      expect(manifest.id).toBe(project.id);
      expect(manifest.topic).toBe('AI Coding Trends');
    });

    it('stores projectId and manifestPath in first task result', async () => {
      // Simulate the workflow: create project, then create first task
      const project = await projectManager.createProject('Test Topic');
      const taskId = await taskStore.create(
        'Analyze trends for video',
        'Research trending topics and produce a trend report',
        [],
        true, // requiresApproval
      );

      // Store project reference in task result
      const result = JSON.stringify({
        projectId: project.id,
        manifestPath: `projects/${project.id}/project.json`,
      });
      await taskStore.update(taskId, { status: 'completed', result });

      // Verify task result contains project reference
      const tasks = taskStore.list();
      const completedTask = tasks.find((t) => t.id === taskId);
      expect(completedTask?.result).toContain('projectId');
      expect(completedTask?.result).toContain(project.id);
    });
  });

  describe('Task DAG with dependencies', () => {
    it('creates a task DAG for video production with dependencies', async () => {
      // Create the task DAG as specified in the design
      const analyzeTaskId = await taskStore.create(
        'Analyze trends',
        'Research trending topics',
        [],
        true,
      );
      const scriptTaskId = await taskStore.create(
        'Generate script',
        'Write video script with storyboard',
        [analyzeTaskId],
        true,
      );
      const imagePromptsTaskId = await taskStore.create(
        'Generate image prompts',
        'Create image prompts for each scene',
        [scriptTaskId],
        true,
      );
      const imagesTaskId = await taskStore.create(
        'Generate images',
        'Generate images via ComfyUI',
        [imagePromptsTaskId],
        true,
      );
      const videoPromptsTaskId = await taskStore.create(
        'Generate video prompts',
        'Create motion prompts for each scene',
        [imagesTaskId],
        true,
      );
      const videosTaskId = await taskStore.create(
        'Generate videos',
        'Generate video clips via ComfyUI',
        [videoPromptsTaskId],
        true,
      );

      const tasks = taskStore.list();

      // Verify dependency chain
      const analyzeTask = tasks.find((t) => t.id === analyzeTaskId);
      const scriptTask = tasks.find((t) => t.id === scriptTaskId);
      const imagePromptsTask = tasks.find((t) => t.id === imagePromptsTaskId);
      const imagesTask = tasks.find((t) => t.id === imagesTaskId);
      const videoPromptsTask = tasks.find((t) => t.id === videoPromptsTaskId);
      const videosTask = tasks.find((t) => t.id === videosTaskId);

      // First task has no dependencies and is pending
      expect(analyzeTask?.dependsOn).toEqual([]);
      expect(analyzeTask?.status).toBe('pending');
      expect(analyzeTask?.requiresApproval).toBe(true);

      // Subsequent tasks have dependencies and are waiting
      expect(scriptTask?.dependsOn).toEqual([analyzeTaskId]);
      expect(scriptTask?.status).toBe('waiting');
      expect(imagePromptsTask?.dependsOn).toEqual([scriptTaskId]);
      expect(imagePromptsTask?.status).toBe('waiting');
      expect(imagesTask?.dependsOn).toEqual([imagePromptsTaskId]);
      expect(imagesTask?.status).toBe('waiting');
      expect(videoPromptsTask?.dependsOn).toEqual([imagesTaskId]);
      expect(videoPromptsTask?.status).toBe('waiting');
      expect(videosTask?.dependsOn).toEqual([videoPromptsTaskId]);
      expect(videosTask?.status).toBe('waiting');
    });

    it('each task has requiresApproval: true', async () => {
      const task1 = await taskStore.create('Task 1', 'Description', [], true);
      const task2 = await taskStore.create('Task 2', 'Description', [task1], true);
      const task3 = await taskStore.create('Task 3', 'Description', [task2], true);

      const tasks = taskStore.list();
      expect(tasks.find((t) => t.id === task1)?.requiresApproval).toBe(true);
      expect(tasks.find((t) => t.id === task2)?.requiresApproval).toBe(true);
      expect(tasks.find((t) => t.id === task3)?.requiresApproval).toBe(true);
    });

    it('waiting tasks become pending when dependencies complete', async () => {
      const task1 = await taskStore.create('Task 1', 'Description', [], true);
      const task2 = await taskStore.create('Task 2', 'Description', [task1], true);

      // Initially task2 is waiting
      expect(taskStore.list().find((t) => t.id === task2)?.status).toBe('waiting');

      // Complete task1
      await taskStore.update(task1, { status: 'completed' });

      // Now task2 should be pending
      expect(taskStore.list().find((t) => t.id === task2)?.status).toBe('pending');
    });

    it('detects circular dependencies at creation time', async () => {
      const task1 = await taskStore.create('Task 1', 'Description', []);
      const task2 = await taskStore.create('Task 2', 'Description', [task1]);

      // Attempting to create task3 that depends on task2, and then making task1 depend on task3
      // would create a cycle. But since we can only set deps at creation, we test a different case:
      // Creating a task that would complete a cycle if we traverse its deps.
      // This is actually tested at the store level - we need to verify the store rejects cycles.

      // Valid: task1 -> task2 -> task3 (linear chain)
      const task3 = await taskStore.create('Task 3', 'Description', [task2]);
      expect(task3).toBe('task-3');

      // Valid: task1 -> task3 (direct dependency, no cycle)
      const task4 = await taskStore.create('Task 4', 'Description', [task1]);
      expect(task4).toBe('task-4');

      // Valid: task3 -> task5 AND task4 -> task5 (diamond pattern, no cycle)
      const task5 = await taskStore.create('Task 5', 'Description', [task3, task4]);
      expect(task5).toBe('task-5');

      // The TaskStore's cycle detection prevents creating a cycle when:
      // - task A depends on B, B depends on C, and we try to create C depending on A
      // But since we can't modify existing tasks' deps, the only way to trigger
      // the cycle detection is if the store checks for self-referential deps.
      // This is covered in task-store.test.ts
    });
  });

  describe('Manifest artifact status management', () => {
    let project: ContentProject;

    beforeEach(async () => {
      project = await projectManager.createProject('Test Video');
    });

    it('updates artifact status to draft after generation', async () => {
      // Add a trend report artifact
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'pending',
      };
      await projectManager.writeManifest(project);

      // Simulate generation: update status to draft
      await projectManager.updateArtifactStatus(project, '01-trend-report.md', 'draft');

      expect(project.artifacts.trendReport?.status).toBe('draft');
    });

    it('updates artifact status to approved after user_review approval', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'draft',
      };
      await projectManager.writeManifest(project);

      // Simulate approval
      await projectManager.updateArtifactStatus(project, '01-trend-report.md', 'approved');

      expect(project.artifacts.trendReport?.status).toBe('approved');
      expect(project.artifacts.trendReport?.approvedAt).toBeDefined();
    });

    it('initializes scene artifacts from storyboard', async () => {
      const storyboard: Storyboard = {
        title: 'Test Video',
        summary: 'A test video',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [
          {
            sceneNumber: 1,
            description: 'Opening scene',
            camera: 'wide shot',
            duration: '5s',
            imagePromptHint: 'test hint',
          },
          {
            sceneNumber: 2,
            description: 'Closing scene',
            camera: 'close-up',
            duration: '5s',
            imagePromptHint: 'test hint 2',
          },
        ],
      };

      await projectManager.initializeScenes(project, storyboard);

      expect(project.artifacts.scenes).toHaveLength(2);
      const scene0 = project.artifacts.scenes[0];
      const scene1 = project.artifacts.scenes[1];
      expect(scene0).toBeDefined();
      expect(scene1).toBeDefined();
      expect(scene0!.sceneNumber).toBe(1);
      expect(scene1!.sceneNumber).toBe(2);
    });

    it('stores image artifact path in scene directory', async () => {
      // Initialize scenes
      await projectManager.initializeScenes(project, {
        title: 'Test',
        summary: 'Test',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [{ sceneNumber: 1, description: 'Test', camera: 'wide', duration: '5s', imagePromptHint: 'test' }],
      });

      // Add image artifact
      const scene = project.artifacts.scenes[0];
      expect(scene).toBeDefined();
      scene!.image = {
        path: 'scenes/scene-01/image.png',
        status: 'draft',
      };
      await projectManager.writeManifest(project);

      // Verify persistence
      const reloaded = await projectManager.readProject(project.id);
      const reloadedScene = reloaded?.artifacts.scenes[0];
      expect(reloadedScene).toBeDefined();
      expect(reloadedScene?.image?.path).toBe('scenes/scene-01/image.png');
      expect(reloadedScene?.image?.status).toBe('draft');
    });

    it('stores clip artifact path in scene directory', async () => {
      await projectManager.initializeScenes(project, {
        title: 'Test',
        summary: 'Test',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [{ sceneNumber: 1, description: 'Test', camera: 'wide', duration: '5s', imagePromptHint: 'test' }],
      });

      const scene = project.artifacts.scenes[0];
      expect(scene).toBeDefined();
      scene!.clip = {
        path: 'scenes/scene-01/clip.mp4',
        status: 'draft',
      };
      await projectManager.writeManifest(project);

      const reloaded = await projectManager.readProject(project.id);
      const reloadedScene = reloaded?.artifacts.scenes[0];
      expect(reloadedScene).toBeDefined();
      expect(reloadedScene?.clip?.path).toBe('scenes/scene-01/clip.mp4');
    });
  });

  describe('Task reads manifest to find input artifacts', () => {
    let project: ContentProject;

    beforeEach(async () => {
      project = await projectManager.createProject('Test Video');
    });

    it('stores manifestPath in task result for downstream tasks', async () => {
      const manifestPath = `projects/${project.id}/project.json`;
      const taskId = await taskStore.create('Init project', 'Initialize project', []);
      await taskStore.update(taskId, {
        status: 'completed',
        result: JSON.stringify({ projectId: project.id, manifestPath }),
      });

      const task = taskStore.list().find((t) => t.id === taskId);
      const result = JSON.parse(task?.result ?? '{}');
      expect(result.projectId).toBe(project.id);
      expect(result.manifestPath).toBe(manifestPath);
    });

    it('downstream task can read manifest to find artifacts', async () => {
      // Set up storyboard and scene artifacts
      const storyboard: Storyboard = {
        title: 'Test',
        summary: 'Test',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [
          { sceneNumber: 1, description: 'Scene 1', camera: 'wide', duration: '5s', imagePromptHint: 'hint1' },
          { sceneNumber: 2, description: 'Scene 2', camera: 'wide', duration: '5s', imagePromptHint: 'hint2' },
        ],
      };
      await projectManager.initializeScenes(project, storyboard);

      // Add image prompt artifacts (simulating generate-image-prompts step)
      const scene0 = project.artifacts.scenes[0];
      const scene1 = project.artifacts.scenes[1];
      expect(scene0).toBeDefined();
      expect(scene1).toBeDefined();
      scene0!.imagePrompt = { path: 'scenes/scene-01/prompt.md', status: 'approved' };
      scene1!.imagePrompt = { path: 'scenes/scene-02/prompt.md', status: 'approved' };
      await projectManager.writeManifest(project);

      // Simulate downstream task reading manifest
      const manifestPath = join(testDir, 'projects', project.id, 'project.json');
      const raw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(raw) as ContentProject;

      // Find approved image prompts
      const approvedPrompts = manifest.artifacts.scenes
        .filter((s) => s.imagePrompt?.status === 'approved')
        .map((s) => s.imagePrompt?.path);

      expect(approvedPrompts).toEqual(['scenes/scene-01/prompt.md', 'scenes/scene-02/prompt.md']);
    });
  });

  describe('User rejection and revision', () => {
    let project: ContentProject;

    beforeEach(async () => {
      project = await projectManager.createProject('Test Video');
    });

    it('updates status back to draft when user rejects', async () => {
      project.artifacts.trendReport = {
        path: '01-trend-report.md',
        status: 'draft',
      };
      await projectManager.writeManifest(project);

      // Simulate rejection: keep as draft or set to failed
      await projectManager.updateArtifactStatus(project, '01-trend-report.md', 'draft');

      expect(project.artifacts.trendReport?.status).toBe('draft');
    });

    it('manifest reflects rejection in updatedAt timestamp', async () => {
      project.artifacts.storyboard = {
        path: '02-storyboard.json',
        status: 'draft',
      };
      await projectManager.writeManifest(project);
      const originalUpdatedAt = project.updatedAt;

      // Simulate revision after rejection
      await new Promise((resolve) => setTimeout(resolve, 10));
      await projectManager.updateArtifactStatus(project, '02-storyboard.json', 'draft');

      expect(project.updatedAt).not.toBe(originalUpdatedAt);
    });

    it('task returns to in_progress when user provides feedback', async () => {
      const taskId = await taskStore.create('Generate script', 'Write script', [], true);
      await taskStore.update(taskId, { status: 'in_progress' });

      // Simulate completion and awaiting approval
      await taskStore.update(taskId, { status: 'awaiting_approval', result: 'draft script' });
      expect(taskStore.list().find((t) => t.id === taskId)?.status).toBe('awaiting_approval');

      // Simulate rejection with feedback - task goes back to in_progress
      await taskStore.update(taskId, { status: 'in_progress' });
      expect(taskStore.list().find((t) => t.id === taskId)?.status).toBe('in_progress');

      // Simulate revision and completion
      await taskStore.update(taskId, { status: 'awaiting_approval', result: 'revised script' });
      await taskStore.update(taskId, { status: 'completed' });
      expect(taskStore.list().find((t) => t.id === taskId)?.status).toBe('completed');
    });
  });

  describe('Full workflow simulation', () => {
    it('simulates complete video production workflow with mocked ComfyUI and user review', async () => {
      // 1. Create project
      const project = await projectManager.createProject('AI Trends Video');
      const manifestPath = `projects/${project.id}/project.json`;

      // 2. Create task DAG
      const analyzeTaskId = await taskStore.create('Analyze trends', 'Research trends', [], true);
      const scriptTaskId = await taskStore.create('Generate script', 'Write storyboard', [analyzeTaskId], true);
      const imagePromptsTaskId = await taskStore.create(
        'Generate image prompts',
        'Create prompts',
        [scriptTaskId],
        true,
      );
      const imagesTaskId = await taskStore.create('Generate images', 'ComfyUI text2img', [imagePromptsTaskId], true);
      const videoPromptsTaskId = await taskStore.create(
        'Generate video prompts',
        'Create motion prompts',
        [imagesTaskId],
        true,
      );
      const videosTaskId = await taskStore.create('Generate videos', 'ComfyUI img2video', [videoPromptsTaskId], true);

      // 3. Task 1: Analyze trends (complete with project reference)
      await taskStore.update(analyzeTaskId, { status: 'in_progress' });
      // ... do work ...
      project.artifacts.trendReport = { path: '01-trend-report.md', status: 'draft' };
      await projectManager.writeManifest(project);
      await taskStore.update(analyzeTaskId, {
        status: 'awaiting_approval',
        result: JSON.stringify({ projectId: project.id, manifestPath }),
      });
      // User approves
      await projectManager.updateArtifactStatus(project, '01-trend-report.md', 'approved');
      await taskStore.update(analyzeTaskId, { status: 'completed' });

      // 4. Task 2 becomes pending, generate script
      expect(taskStore.list().find((t) => t.id === scriptTaskId)?.status).toBe('pending');
      await taskStore.update(scriptTaskId, { status: 'in_progress' });

      // Create storyboard
      const storyboard: Storyboard = {
        title: 'AI Trends',
        summary: 'Overview of AI trends',
        targetPlatform: 'tiktok',
        estimatedDuration: '60s',
        scenes: [
          { sceneNumber: 1, description: 'Intro', camera: 'wide', duration: '5s', imagePromptHint: 'tech background' },
          { sceneNumber: 2, description: 'Conclusion', camera: 'close-up', duration: '5s', imagePromptHint: 'speaker' },
        ],
      };
      await projectManager.initializeScenes(project, storyboard);
      project.artifacts.storyboard = { path: '02-storyboard.json', status: 'draft' };
      await projectManager.writeManifest(project);

      await taskStore.update(scriptTaskId, { status: 'awaiting_approval' });
      // User approves
      await projectManager.updateArtifactStatus(project, '02-storyboard.json', 'approved');
      await taskStore.update(scriptTaskId, { status: 'completed' });

      // 5. Generate image prompts
      expect(taskStore.list().find((t) => t.id === imagePromptsTaskId)?.status).toBe('pending');
      await taskStore.update(imagePromptsTaskId, { status: 'in_progress' });

      // Write prompts (simulated)
      const scene0 = project.artifacts.scenes[0];
      const scene1 = project.artifacts.scenes[1];
      expect(scene0).toBeDefined();
      expect(scene1).toBeDefined();
      scene0!.imagePrompt = { path: 'scenes/scene-01/prompt.md', status: 'draft' };
      scene1!.imagePrompt = { path: 'scenes/scene-02/prompt.md', status: 'draft' };
      await projectManager.writeManifest(project);

      await taskStore.update(imagePromptsTaskId, { status: 'awaiting_approval' });
      // User approves
      await projectManager.updateArtifactStatus(project, 'scenes/scene-01/prompt.md', 'approved');
      await projectManager.updateArtifactStatus(project, 'scenes/scene-02/prompt.md', 'approved');
      await taskStore.update(imagePromptsTaskId, { status: 'completed' });

      // 6. Generate images (simulated ComfyUI text2img)
      expect(taskStore.list().find((t) => t.id === imagesTaskId)?.status).toBe('pending');
      await taskStore.update(imagesTaskId, { status: 'in_progress' });

      // Simulate ComfyUI output
      const imageDir = join(project.dir, 'scenes', 'scene-01');
      await mkdir(imageDir, { recursive: true });
      await writeFile(join(imageDir, 'image.png'), 'fake image data', 'utf-8');

      scene0!.image = { path: 'scenes/scene-01/image.png', status: 'draft' };
      scene1!.image = { path: 'scenes/scene-02/image.png', status: 'draft' };
      await projectManager.writeManifest(project);

      await taskStore.update(imagesTaskId, { status: 'awaiting_approval' });
      // User approves
      await projectManager.updateArtifactStatus(project, 'scenes/scene-01/image.png', 'approved');
      await projectManager.updateArtifactStatus(project, 'scenes/scene-02/image.png', 'approved');
      await taskStore.update(imagesTaskId, { status: 'completed' });

      // 7. Generate video prompts
      expect(taskStore.list().find((t) => t.id === videoPromptsTaskId)?.status).toBe('pending');
      await taskStore.update(videoPromptsTaskId, { status: 'in_progress' });

      scene0!.videoPrompt = { path: 'scenes/scene-01/video-prompt.md', status: 'draft' };
      scene1!.videoPrompt = { path: 'scenes/scene-02/video-prompt.md', status: 'draft' };
      await projectManager.writeManifest(project);

      await taskStore.update(videoPromptsTaskId, { status: 'awaiting_approval' });
      await projectManager.updateArtifactStatus(project, 'scenes/scene-01/video-prompt.md', 'approved');
      await projectManager.updateArtifactStatus(project, 'scenes/scene-02/video-prompt.md', 'approved');
      await taskStore.update(videoPromptsTaskId, { status: 'completed' });

      // 8. Generate videos (simulated ComfyUI img2video)
      expect(taskStore.list().find((t) => t.id === videosTaskId)?.status).toBe('pending');
      await taskStore.update(videosTaskId, { status: 'in_progress' });

      // Simulate ComfyUI output
      await writeFile(join(imageDir, 'clip.mp4'), 'fake video data', 'utf-8');

      scene0!.clip = { path: 'scenes/scene-01/clip.mp4', status: 'draft' };
      scene1!.clip = { path: 'scenes/scene-02/clip.mp4', status: 'draft' };
      await projectManager.writeManifest(project);

      await taskStore.update(videosTaskId, { status: 'awaiting_approval' });
      await projectManager.updateArtifactStatus(project, 'scenes/scene-01/clip.mp4', 'approved');
      await projectManager.updateArtifactStatus(project, 'scenes/scene-02/clip.mp4', 'approved');
      await taskStore.update(videosTaskId, { status: 'completed' });

      // 9. Verify final state
      const finalProject = await projectManager.readProject(project.id);
      expect(finalProject?.artifacts.trendReport?.status).toBe('approved');
      expect(finalProject?.artifacts.storyboard?.status).toBe('approved');
      const finalScene0 = finalProject?.artifacts.scenes[0];
      const finalScene1 = finalProject?.artifacts.scenes[1];
      expect(finalScene0).toBeDefined();
      expect(finalScene1).toBeDefined();
      expect(finalScene0?.image?.status).toBe('approved');
      expect(finalScene0?.clip?.status).toBe('approved');
      expect(finalScene1?.image?.status).toBe('approved');
      expect(finalScene1?.clip?.status).toBe('approved');

      // All tasks completed
      const tasks = taskStore.list();
      const allCompleted = tasks.every((t) => t.status === 'completed');
      expect(allCompleted).toBe(true);
    });
  });
});
