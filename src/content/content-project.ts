import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Storyboard output from generate-video-script skill.
 * Represents a scene-by-scene breakdown for short-form video.
 */
export interface Storyboard {
  title: string;
  summary: string;
  targetPlatform: string;
  estimatedDuration: string;
  scenes: Scene[];
}

/**
 * A single scene in a video storyboard.
 */
export interface Scene {
  sceneNumber: number;
  description: string;
  dialogue?: string;
  camera: string;
  duration: string;
  imagePromptHint: string;
  transitionTo?: string;
}

/**
 * Status of an artifact in the content project.
 */
export type ArtifactStatus = 'pending' | 'draft' | 'approved' | 'failed';

/**
 * An artifact file in the content project.
 */
export interface Artifact {
  /** Relative path from project directory, e.g. "01-trend-report.md" */
  path: string;
  status: ArtifactStatus;
  approvedAt?: string;
}

/**
 * Artifacts for a single scene.
 */
export interface SceneArtifacts {
  sceneNumber: number;
  imagePrompt?: Artifact;
  image?: Artifact;
  videoPrompt?: Artifact;
  clip?: Artifact;
}

/**
 * Artifacts from post-production steps.
 */
export interface PostProductionArtifacts {
  subtitles?: Artifact;
  rawVideo?: Artifact;
  audioVideo?: Artifact;
  finalVideo?: Artifact;
}

/**
 * Maps workflow steps to task IDs.
 */
export interface TaskIdMap {
  analyzeTrends?: string;
  generateScript?: string;
  generateImagePrompts?: string;
  generateImages?: string;
  generateVideoPrompts?: string;
  generateVideos?: string;
  mergeClips?: string;
  addAudio?: string;
  addSubtitles?: string;
}

/**
 * Content project manifest.
 * Written by the agent at project creation and updated after every step.
 */
export interface ContentProject {
  /** Slug, e.g. "ai-coding-trends-2026-03-24" */
  id: string;
  /** Human-readable title, e.g. "AI Coding Trends" */
  title: string;
  /** Original user request */
  topic: string;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp */
  updatedAt: string;
  /** Absolute path to project directory */
  dir: string;
  /** Maps workflow steps to task IDs */
  taskIds: TaskIdMap;
  artifacts: {
    trendReport?: Artifact;
    storyboard?: Artifact;
    scenes: SceneArtifacts[];
    postProduction?: PostProductionArtifacts;
  };
}

/**
 * Generate a slug from a topic string.
 * Converts to lowercase, replaces spaces and special chars with hyphens,
 * appends the current date.
 */
export function generateProjectId(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const date = new Date().toISOString().slice(0, 10);
  return `${slug}-${date}`;
}

/**
 * Manager for content projects.
 * Handles creation, reading, and updating of project manifests.
 */
export class ContentProjectManager {
  private readonly projectsDir: string;

  constructor(workspaceRoot: string) {
    this.projectsDir = join(workspaceRoot, 'projects');
  }

  /**
   * Create a new content project with the given topic.
   * Creates the project directory and writes the initial manifest.
   * Returns the project manifest.
   */
  async createProject(topic: string, title?: string): Promise<ContentProject> {
    const id = generateProjectId(topic);
    const projectDir = join(this.projectsDir, id);
    const now = new Date().toISOString();

    const project: ContentProject = {
      id,
      title: title ?? topic.slice(0, 100),
      topic,
      createdAt: now,
      updatedAt: now,
      dir: projectDir,
      taskIds: {},
      artifacts: {
        scenes: [],
      },
    };

    // Create project directory
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, 'scenes'), { recursive: true });
    await mkdir(join(projectDir, 'final'), { recursive: true });

    // Write initial manifest
    await this.writeManifest(project);

    return project;
  }

  /**
   * Read a project manifest from disk.
   * Returns undefined if the project doesn't exist.
   */
  async readProject(projectId: string): Promise<ContentProject | undefined> {
    const manifestPath = join(this.projectsDir, projectId, 'project.json');
    if (!existsSync(manifestPath)) {
      return undefined;
    }
    const raw = await readFile(manifestPath, 'utf-8');
    return JSON.parse(raw) as ContentProject;
  }

  /**
   * Write the project manifest to disk.
   */
  async writeManifest(project: ContentProject): Promise<void> {
    project.updatedAt = new Date().toISOString();
    const manifestPath = join(project.dir, 'project.json');
    await writeFile(manifestPath, JSON.stringify(project, null, 2), 'utf-8');
  }

  /**
   * Update an artifact's status in the project manifest.
   */
  async updateArtifactStatus(
    project: ContentProject,
    artifactPath: string,
    status: ArtifactStatus,
  ): Promise<void> {
    const updateArtifact = (artifact: Artifact | undefined): boolean => {
      if (!artifact) return false;
      if (artifact.path !== artifactPath) return false;
      artifact.status = status;
      if (status === 'approved') {
        artifact.approvedAt = new Date().toISOString();
      }
      return true;
    };

    // Check top-level artifacts
    if (updateArtifact(project.artifacts.trendReport)) {
      await this.writeManifest(project);
      return;
    }
    if (updateArtifact(project.artifacts.storyboard)) {
      await this.writeManifest(project);
      return;
    }

    // Check scene artifacts
    for (const scene of project.artifacts.scenes) {
      if (
        updateArtifact(scene.imagePrompt) ||
        updateArtifact(scene.image) ||
        updateArtifact(scene.videoPrompt) ||
        updateArtifact(scene.clip)
      ) {
        await this.writeManifest(project);
        return;
      }
    }

    // Check post-production artifacts
    if (project.artifacts.postProduction) {
      const pp = project.artifacts.postProduction;
      if (
        updateArtifact(pp.subtitles) ||
        updateArtifact(pp.rawVideo) ||
        updateArtifact(pp.audioVideo) ||
        updateArtifact(pp.finalVideo)
      ) {
        await this.writeManifest(project);
        return;
      }
    }
  }

  /**
   * Initialize scene artifacts based on a storyboard.
   * Creates SceneArtifacts entries for each scene in the storyboard.
   */
  async initializeScenes(project: ContentProject, storyboard: Storyboard): Promise<void> {
    project.artifacts.scenes = storyboard.scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
    }));
    await this.writeManifest(project);
  }

  /**
   * Set a task ID for a workflow step.
   */
  async setTaskId(
    project: ContentProject,
    step: keyof TaskIdMap,
    taskId: string,
  ): Promise<void> {
    project.taskIds[step] = taskId;
    await this.writeManifest(project);
  }

  /**
   * Get the absolute path for a project file.
   */
  getProjectFilePath(projectId: string, relativePath: string): string {
    return join(this.projectsDir, projectId, relativePath);
  }
}
