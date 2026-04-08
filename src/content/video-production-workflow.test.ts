import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContentProjectManager, type ContentProject, type Storyboard } from './content-project';
import { TaskStore } from '../tasks/task-store';
import { FfmpegRunner } from '../ffmpeg/ffmpeg-runner';
import { createVideoMergeTool } from '../tools/video-merge';
import { createVideoAddAudioTool } from '../tools/video-add-audio';
import type { ToolContext } from '../tools/tool';

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
    taskStore = new TaskStore(join(dataDir, 'tasks.json'), dataDir);
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

      // Verify task result contains project reference as structured JSON
      const tasks = taskStore.list();
      const completedTask = tasks.find((t) => t.id === taskId);
      expect(completedTask).toBeDefined();
      expect(completedTask?.result).toBeDefined();
      const parsedResult = JSON.parse(completedTask!.result as string) as {
        projectId: string;
        manifestPath: string;
      };
      expect(parsedResult.projectId).toBe(project.id);
      expect(parsedResult.manifestPath).toBe(`projects/${project.id}/project.json`);
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

    it('creates valid DAG shapes (linear chain, diamond pattern)', async () => {
      const task1 = await taskStore.create('Task 1', 'Description', []);
      const task2 = await taskStore.create('Task 2', 'Description', [task1]);

      // Valid: task1 -> task2 -> task3 (linear chain)
      const task3 = await taskStore.create('Task 3', 'Description', [task2]);
      expect(task3).toBe('task-3');

      // Valid: task1 -> task4 (direct dependency, no cycle)
      const task4 = await taskStore.create('Task 4', 'Description', [task1]);
      expect(task4).toBe('task-4');

      // Valid: task3 -> task5 AND task4 -> task5 (diamond pattern, no cycle)
      const task5 = await taskStore.create('Task 5', 'Description', [task3, task4]);
      expect(task5).toBe('task-5');
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
        scenes: [
          {
            sceneNumber: 1,
            description: 'Test',
            camera: 'wide',
            duration: '5s',
            imagePromptHint: 'test',
          },
        ],
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
        scenes: [
          {
            sceneNumber: 1,
            description: 'Test',
            camera: 'wide',
            duration: '5s',
            imagePromptHint: 'test',
          },
        ],
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
          {
            sceneNumber: 1,
            description: 'Scene 1',
            camera: 'wide',
            duration: '5s',
            imagePromptHint: 'hint1',
          },
          {
            sceneNumber: 2,
            description: 'Scene 2',
            camera: 'wide',
            duration: '5s',
            imagePromptHint: 'hint2',
          },
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
      const scriptTaskId = await taskStore.create(
        'Generate script',
        'Write storyboard',
        [analyzeTaskId],
        true,
      );
      const imagePromptsTaskId = await taskStore.create(
        'Generate image prompts',
        'Create prompts',
        [scriptTaskId],
        true,
      );
      const imagesTaskId = await taskStore.create(
        'Generate images',
        'ComfyUI text2img',
        [imagePromptsTaskId],
        true,
      );
      const videoPromptsTaskId = await taskStore.create(
        'Generate video prompts',
        'Create motion prompts',
        [imagesTaskId],
        true,
      );
      const videosTaskId = await taskStore.create(
        'Generate videos',
        'ComfyUI img2video',
        [videoPromptsTaskId],
        true,
      );

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
          {
            sceneNumber: 1,
            description: 'Intro',
            camera: 'wide',
            duration: '5s',
            imagePromptHint: 'tech background',
          },
          {
            sceneNumber: 2,
            description: 'Conclusion',
            camera: 'close-up',
            duration: '5s',
            imagePromptHint: 'speaker',
          },
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
      await projectManager.updateArtifactStatus(
        project,
        'scenes/scene-01/video-prompt.md',
        'approved',
      );
      await projectManager.updateArtifactStatus(
        project,
        'scenes/scene-02/video-prompt.md',
        'approved',
      );
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

describe('Post-production workflow (S10-8)', () => {
  const testDir = join(__dirname, '.test-video-production');
  const dataDir = join(testDir, '.bolt');
  let projectManager: ContentProjectManager;
  let taskStore: TaskStore;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    projectManager = new ContentProjectManager(testDir);
    taskStore = new TaskStore(join(dataDir, 'tasks.json'), dataDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function setupCompletedVideoGeneration() {
    const project = await projectManager.createProject('Post-Production Test');

    // Create storyboard and initialize scenes
    const storyboard: Storyboard = {
      title: 'Test Video',
      summary: 'A test video for post-production',
      targetPlatform: 'tiktok',
      estimatedDuration: '30s',
      scenes: [
        {
          sceneNumber: 1,
          description: 'Scene 1',
          camera: 'wide',
          duration: '10s',
          imagePromptHint: 'hint1',
        },
        {
          sceneNumber: 2,
          description: 'Scene 2',
          camera: 'medium',
          duration: '10s',
          imagePromptHint: 'hint2',
        },
        {
          sceneNumber: 3,
          description: 'Scene 3',
          camera: 'close-up',
          duration: '10s',
          imagePromptHint: 'hint3',
        },
      ],
    };
    await projectManager.initializeScenes(project, storyboard);

    // Mark storyboard as approved
    project.artifacts.storyboard = {
      path: '02-storyboard.json',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    // Create fake clip files on disk
    for (let i = 1; i <= 3; i++) {
      const sceneDir = join(project.dir, 'scenes', `scene-0${i}`);
      await mkdir(sceneDir, { recursive: true });
      await writeFile(join(sceneDir, 'clip.mp4'), `fake clip data for scene ${i}`, 'utf-8');

      // Mark clips as approved in manifest
      const scene = project.artifacts.scenes[i - 1];
      if (!scene) throw new Error(`Scene ${i} not found`);
      scene.clip = {
        path: `scenes/scene-0${i}/clip.mp4`,
        status: 'approved',
        approvedAt: new Date().toISOString(),
      };
    }

    // Create fake audio file
    const audioDir = join(project.dir, 'audio');
    await mkdir(audioDir, { recursive: true });
    await writeFile(join(audioDir, 'bgm.mp3'), 'fake audio data', 'utf-8');

    // Initialize postProduction artifacts
    project.artifacts.postProduction = {};
    await projectManager.writeManifest(project);

    return project;
  }

  it('mergeClips creates final/raw.mp4 and updates manifest', async () => {
    const project = await setupCompletedVideoGeneration();

    // Verify all scene clips are approved
    for (const scene of project.artifacts.scenes) {
      expect(scene.clip?.status).toBe('approved');
    }

    // Simulate video_merge output by writing final/raw.mp4
    const rawVideoPath = join(project.dir, 'final', 'raw.mp4');
    await writeFile(rawVideoPath, 'fake raw merged video', 'utf-8');

    // Update manifest with postProduction.rawVideo as draft
    project.artifacts.postProduction!.rawVideo = {
      path: 'final/raw.mp4',
      status: 'draft',
    };
    await projectManager.writeManifest(project);

    // Approve rawVideo
    await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');

    // Verify manifest shows rawVideo approved with approvedAt timestamp
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.rawVideo?.approvedAt).toBeDefined();
  });

  it('addAudio creates final/audio.mp4 (replace mode) and updates manifest', async () => {
    const project = await setupCompletedVideoGeneration();

    // Pre-create final/raw.mp4 with approved status
    project.artifacts.postProduction!.rawVideo = {
      path: 'final/raw.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    // Simulate video_add_audio output by writing final/audio.mp4
    const audioVideoPath = join(project.dir, 'final', 'audio.mp4');
    await writeFile(audioVideoPath, 'fake audio video', 'utf-8');

    // Update manifest with postProduction.audioVideo as draft
    project.artifacts.postProduction!.audioVideo = {
      path: 'final/audio.mp4',
      status: 'draft',
    };
    await projectManager.writeManifest(project);

    // Approve audioVideo
    await projectManager.updateArtifactStatus(project, 'final/audio.mp4', 'approved');

    // Verify both rawVideo and audioVideo are approved
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.approvedAt).toBeDefined();
  });

  it('addSubtitles creates final/video.mp4 (soft mode) and updates manifest', async () => {
    const project = await setupCompletedVideoGeneration();

    // Pre-create final/audio.mp4 with approved status
    project.artifacts.postProduction!.audioVideo = {
      path: 'final/audio.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    // Agent generates SRT via file_write: write scenes/subtitles.srt with 3 subtitle entries
    const subtitlesPath = join(project.dir, 'scenes', 'subtitles.srt');
    const srtContent = `1
00:00:00,000 --> 00:00:05,000
Welcome to the video

2
00:00:05,000 --> 00:00:10,000
This is the second subtitle

3
00:00:10,000 --> 00:00:15,000
Thanks for watching`;
    await writeFile(subtitlesPath, srtContent, 'utf-8');

    // Simulate video_add_subtitles output by writing final/video.mp4
    const finalVideoPath = join(project.dir, 'final', 'video.mp4');
    await writeFile(finalVideoPath, 'fake final video with subtitles', 'utf-8');

    // Update manifest with subtitles and finalVideo as draft
    project.artifacts.postProduction!.subtitles = {
      path: 'scenes/subtitles.srt',
      status: 'draft',
    };
    project.artifacts.postProduction!.finalVideo = {
      path: 'final/video.mp4',
      status: 'draft',
    };
    await projectManager.writeManifest(project);

    // Approve both
    await projectManager.updateArtifactStatus(project, 'scenes/subtitles.srt', 'approved');
    await projectManager.updateArtifactStatus(project, 'final/video.mp4', 'approved');

    // Verify all postProduction artifacts are approved
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.subtitles?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.subtitles?.approvedAt).toBeDefined();
    expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.finalVideo?.approvedAt).toBeDefined();
  });

  it('Full post-production pipeline: merge → audio → subtitles with approval gates', async () => {
    const project = await setupCompletedVideoGeneration();

    // Create task DAG: mergeClips (no deps) → addAudio (depends on merge) → addSubtitles (depends on audio)
    const mergeTaskId = await taskStore.create(
      'Merge clips',
      'Merge scene clips into raw video',
      [],
      true,
    );
    const audioTaskId = await taskStore.create(
      'Add audio',
      'Add background audio to raw video',
      [mergeTaskId],
      true,
    );
    const subtitlesTaskId = await taskStore.create(
      'Add subtitles',
      'Add subtitles to final video',
      [audioTaskId],
      true,
    );

    // Verify initial state: merge pending, others waiting
    const initialTasks = taskStore.list();
    expect(initialTasks.find((t) => t.id === mergeTaskId)?.status).toBe('pending');
    expect(initialTasks.find((t) => t.id === audioTaskId)?.status).toBe('waiting');
    expect(initialTasks.find((t) => t.id === subtitlesTaskId)?.status).toBe('waiting');

    // Execute merge: in_progress → write raw.mp4 → awaiting_approval → approve → completed
    await taskStore.update(mergeTaskId, { status: 'in_progress' });
    const rawVideoPath = join(project.dir, 'final', 'raw.mp4');
    await writeFile(rawVideoPath, 'fake raw merged video', 'utf-8');
    project.artifacts.postProduction!.rawVideo = { path: 'final/raw.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });
    await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');
    await taskStore.update(mergeTaskId, { status: 'completed' });

    // Verify audio task becomes pending after merge completes
    expect(taskStore.list().find((t) => t.id === audioTaskId)?.status).toBe('pending');

    // Execute audio: in_progress → write audio.mp4 → awaiting_approval → approve → completed
    await taskStore.update(audioTaskId, { status: 'in_progress' });
    const audioVideoPath = join(project.dir, 'final', 'audio.mp4');
    await writeFile(audioVideoPath, 'fake audio video', 'utf-8');
    project.artifacts.postProduction!.audioVideo = { path: 'final/audio.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await taskStore.update(audioTaskId, { status: 'awaiting_approval' });
    await projectManager.updateArtifactStatus(project, 'final/audio.mp4', 'approved');
    await taskStore.update(audioTaskId, { status: 'completed' });

    // Verify subtitles task becomes pending after audio completes
    expect(taskStore.list().find((t) => t.id === subtitlesTaskId)?.status).toBe('pending');

    // Execute subtitles: in_progress → write SRT + video.mp4 → awaiting_approval → approve → completed
    await taskStore.update(subtitlesTaskId, { status: 'in_progress' });
    const subtitlesPath = join(project.dir, 'scenes', 'subtitles.srt');
    await writeFile(subtitlesPath, 'fake subtitles', 'utf-8');
    const finalVideoPath = join(project.dir, 'final', 'video.mp4');
    await writeFile(finalVideoPath, 'fake final video', 'utf-8');
    project.artifacts.postProduction!.subtitles = { path: 'scenes/subtitles.srt', status: 'draft' };
    project.artifacts.postProduction!.finalVideo = { path: 'final/video.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await taskStore.update(subtitlesTaskId, { status: 'awaiting_approval' });
    await projectManager.updateArtifactStatus(project, 'scenes/subtitles.srt', 'approved');
    await projectManager.updateArtifactStatus(project, 'final/video.mp4', 'approved');
    await taskStore.update(subtitlesTaskId, { status: 'completed' });

    // Verify all postProduction artifacts approved, all tasks completed
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.subtitles?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');

    const allTasks = taskStore.list();
    expect(allTasks.every((t) => t.status === 'completed')).toBe(true);
  });

  it('User rejects merge, agent re-presents and succeeds on second attempt', async () => {
    const project = await setupCompletedVideoGeneration();

    // Pre-create raw.mp4 as draft
    project.artifacts.postProduction!.rawVideo = {
      path: 'final/raw.mp4',
      status: 'draft',
    };
    await projectManager.writeManifest(project);

    // Create merge task, go to awaiting_approval
    const mergeTaskId = await taskStore.create('Merge clips', 'Merge scene clips', [], true);
    await taskStore.update(mergeTaskId, { status: 'in_progress' });
    await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });

    // Reject: set artifact back to draft, task back to in_progress
    await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'draft');
    await taskStore.update(mergeTaskId, { status: 'in_progress' });

    // Agent re-merges (write revised file)
    const rawVideoPath = join(project.dir, 'final', 'raw.mp4');
    await writeFile(rawVideoPath, 'revised fake raw merged video', 'utf-8');

    // Re-present, approve, complete
    project.artifacts.postProduction!.rawVideo = { path: 'final/raw.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await taskStore.update(mergeTaskId, { status: 'awaiting_approval' });
    await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');
    await taskStore.update(mergeTaskId, { status: 'completed' });

    // Verify rawVideo approved with approvedAt
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.rawVideo?.approvedAt).toBeDefined();
    expect(taskStore.list().find((t) => t.id === mergeTaskId)?.status).toBe('completed');
  });

  it('Post-production with no audio: skips addAudio, goes merge → subtitles directly', async () => {
    const project = await setupCompletedVideoGeneration();

    // Pre-create raw.mp4 approved
    project.artifacts.postProduction!.rawVideo = {
      path: 'final/raw.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    // Create only merge and subtitles tasks (no audio task)
    const mergeTaskId = await taskStore.create('Merge clips', 'Merge scene clips', [], true);
    const subtitlesTaskId = await taskStore.create(
      'Add subtitles',
      'Add subtitles to final video',
      [mergeTaskId],
      true,
    );

    // Complete merge (should unlock subtitles)
    await taskStore.update(mergeTaskId, { status: 'completed' });

    // Subtitles task should be pending (merge completed)
    expect(taskStore.list().find((t) => t.id === subtitlesTaskId)?.status).toBe('pending');

    // Complete subtitles: write SRT + video.mp4, approve
    await taskStore.update(subtitlesTaskId, { status: 'in_progress' });
    const subtitlesPath = join(project.dir, 'scenes', 'subtitles.srt');
    await writeFile(subtitlesPath, 'fake subtitles', 'utf-8');
    const finalVideoPath = join(project.dir, 'final', 'video.mp4');
    await writeFile(finalVideoPath, 'fake final video', 'utf-8');
    project.artifacts.postProduction!.subtitles = { path: 'scenes/subtitles.srt', status: 'draft' };
    project.artifacts.postProduction!.finalVideo = { path: 'final/video.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await taskStore.update(subtitlesTaskId, { status: 'awaiting_approval' });
    await projectManager.updateArtifactStatus(project, 'scenes/subtitles.srt', 'approved');
    await projectManager.updateArtifactStatus(project, 'final/video.mp4', 'approved');
    await taskStore.update(subtitlesTaskId, { status: 'completed' });

    // Verify no audioVideo artifact, finalVideo approved
    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.audioVideo).toBeUndefined();
    expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.finalVideo?.approvedAt).toBeDefined();
  });

  it('Cascade failure: if merge fails, audio and subtitles auto-fail', async () => {
    await setupCompletedVideoGeneration();

    // Create merge → audio → subtitles task chain
    const mergeTaskId = await taskStore.create('Merge clips', 'Merge scene clips', [], true);
    const audioTaskId = await taskStore.create(
      'Add audio',
      'Add background audio',
      [mergeTaskId],
      true,
    );
    const subtitlesTaskId = await taskStore.create(
      'Add subtitles',
      'Add subtitles',
      [audioTaskId],
      true,
    );

    // Fail merge task with error message
    await taskStore.update(mergeTaskId, {
      status: 'failed',
      error: 'Merge failed: incompatible clip formats',
    });

    // Verify audio and subtitles are auto-failed (cascade)
    const tasks = taskStore.list();
    const audioTask = tasks.find((t) => t.id === audioTaskId);
    const subtitlesTask = tasks.find((t) => t.id === subtitlesTaskId);

    expect(audioTask?.status).toBe('failed');
    expect(audioTask?.error).toBe('dependency task-1 failed');
    expect(subtitlesTask?.status).toBe('failed');
    expect(subtitlesTask?.error).toBe('dependency task-2 failed');
  });

  it('video_merge and video_add_audio execute through mocked FfmpegRunner and update manifest', async () => {
    const project = await setupCompletedVideoGeneration();

    const mockRun = vi.fn();
    const mockRunner = {
      assertWithinWorkspace: vi.fn(),
      run: mockRun,
      config: {
        videoCodec: 'libx264',
        crf: 23,
        preset: 'medium',
        audioCodec: 'aac',
        audioBitrate: '192k',
      },
    };

    const ctx: ToolContext = {
      cwd: project.dir,
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
      },
    };

    // Step 1: merge all approved clips via video_merge tool
    const rawPath = join(project.dir, 'final', 'raw.mp4');
    mockRun.mockResolvedValueOnce({
      outputPath: rawPath,
      durationMs: 30000,
      stderr: 'Duration: 00:00:30.00, start: 0.000000, bitrate: 1000 kb/s',
    });

    const mergeTool = createVideoMergeTool(mockRunner as unknown as FfmpegRunner);
    const clipPaths = project.artifacts.scenes.map((_, i) => `scenes/scene-0${i + 1}/clip.mp4`);
    const mergeResult = await mergeTool.execute(
      { clips: clipPaths, outputPath: 'final/raw.mp4' },
      ctx,
    );

    expect(mergeResult.outputPath).toBe(rawPath);
    expect(mergeResult.videoDurationSec).toBeCloseTo(30, 1);
    expect(mockRun).toHaveBeenCalledOnce();

    // Agent updates manifest after merge completes
    project.artifacts.postProduction!.rawVideo = { path: 'final/raw.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await projectManager.updateArtifactStatus(project, 'final/raw.mp4', 'approved');

    // Step 2: add background audio via video_add_audio tool
    const audioVideoPath = join(project.dir, 'final', 'audio.mp4');
    mockRun.mockResolvedValueOnce({
      outputPath: audioVideoPath,
      durationMs: 30000,
      stderr: '',
    });

    const addAudioTool = createVideoAddAudioTool(mockRunner as unknown as FfmpegRunner);
    const audioResult = await addAudioTool.execute(
      {
        videoPath: 'final/raw.mp4',
        audioPath: 'audio/bgm.mp3',
        outputPath: 'final/audio.mp4',
      },
      ctx,
    );

    expect(audioResult.outputPath).toBe(audioVideoPath);
    expect(mockRun).toHaveBeenCalledTimes(2);

    // Agent updates manifest after addAudio completes
    project.artifacts.postProduction!.audioVideo = { path: 'final/audio.mp4', status: 'draft' };
    await projectManager.writeManifest(project);
    await projectManager.updateArtifactStatus(project, 'final/audio.mp4', 'approved');

    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.approvedAt).toBeDefined();
  });

  it('merge + audio with no subtitles: finalVideo links to final/audio.mp4 in manifest', async () => {
    const project = await setupCompletedVideoGeneration();

    // Merge step approved
    project.artifacts.postProduction!.rawVideo = {
      path: 'final/raw.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    // addAudio step approved; subtitles skipped so agent links finalVideo to audio output
    project.artifacts.postProduction!.audioVideo = {
      path: 'final/audio.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    project.artifacts.postProduction!.finalVideo = {
      path: 'final/audio.mp4',
      status: 'approved',
      approvedAt: new Date().toISOString(),
    };
    await projectManager.writeManifest(project);

    const reloaded = await projectManager.readProject(project.id);
    expect(reloaded?.artifacts.postProduction?.rawVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.audioVideo?.status).toBe('approved');
    // finalVideo must point to the last completed output (audio.mp4) when subtitles are skipped
    expect(reloaded?.artifacts.postProduction?.finalVideo?.path).toBe('final/audio.mp4');
    expect(reloaded?.artifacts.postProduction?.finalVideo?.status).toBe('approved');
    expect(reloaded?.artifacts.postProduction?.finalVideo?.approvedAt).toBeDefined();
    // No subtitles artifact in manifest
    expect(reloaded?.artifacts.postProduction?.subtitles).toBeUndefined();
  });
});
