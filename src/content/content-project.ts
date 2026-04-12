import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Target video resolution.
 * Stored in the storyboard and used for all image and video generation in the project.
 */
export interface VideoResolution {
  width: number;
  height: number;
}

/**
 * A character who appears in the video.
 * Defined once in the storyboard; referenced by ID from individual scenes.
 *
 * Character descriptions flow directly into image and video prompts:
 * - face + appearance + clothing → image prompts (for consistent visual identity across scenes)
 * - speakingAccent → video prompts (LTX-Video uses this for speech animation)
 */
export interface Character {
  /**
   * Unique identifier referenced from Scene.characterIds.
   * Use short lowercase slugs, e.g. "host", "narrator", "guest-sarah".
   */
  id: string;
  /** Display name, e.g. "Sarah Chen" */
  name: string;
  /** Approximate age in years */
  age: number;
  /** Gender, e.g. "female", "male", "non-binary" */
  gender: string;
  /** Nationality or ethnic background, e.g. "Chinese-American", "British" */
  nationality: string;
  /**
   * Overall physical appearance for image generation.
   * Describe build, height, hair colour/length/style, distinguishing features.
   * Example: "slender build, medium height, straight black hair to shoulders"
   */
  appearance: string;
  /**
   * Detailed face description for consistent character rendering across scenes.
   * Example: "oval face, high cheekbones, dark almond-shaped eyes, light freckles, warm smile"
   */
  face: string;
  /**
   * Clothing and style for consistent rendering across scenes.
   * Example: "casual-smart: light blue blazer over white t-shirt, dark jeans"
   */
  clothing: string;
  /**
   * Speaking accent for LTX-Video speech animation.
   * Include language and regional accent clearly.
   * Example: "American English", "British RP", "Mandarin-accented English", "Australian English"
   */
  speakingAccent: string;
  /**
   * Role in the video, e.g. "main presenter", "expert guest", "interviewer", "background passerby"
   */
  role: string;
}

/**
 * Storyboard output from the generate-video-script skill.
 * This is the complete production design document for a video project.
 * It contains all creative and technical decisions that downstream generation steps need:
 * - resolution (for comfyui_text2img and comfyui_img2video)
 * - characters (for image and video prompt generation)
 * - scenes (with character assignments)
 */
export interface Storyboard {
  title: string;
  summary: string;
  /** Target platform determines resolution and format constraints. */
  targetPlatform: string;
  /**
   * Target video resolution derived from targetPlatform.
   * All image and video generation in this project must use these exact dimensions.
   *
   * Canonical values by platform:
   *   tiktok / reels / youtube-shorts → { width: 1080, height: 1920 }  (9:16 portrait)
   *   youtube                         → { width: 1920, height: 1080 }  (16:9 landscape)
   *   linkedin                        → { width: 1080, height: 1080 }  (1:1 square)
   */
  resolution: VideoResolution;
  estimatedDuration: string;
  /**
   * All characters who appear in this video.
   * May be empty for narration-only or b-roll videos with no on-screen people.
   */
  characters: Character[];
  scenes: Scene[];
}

/**
 * A single scene in a video storyboard.
 */
export interface Scene {
  sceneNumber: number;
  /** What happens visually in this scene */
  description: string;
  /** Spoken dialogue or voiceover text for this scene */
  dialogue?: string;
  /** Camera movement or angle, e.g. "slow zoom in", "static wide shot" */
  camera: string;
  /** Approximate scene duration, e.g. "5s", "8s" */
  duration: string;
  /** Brief hint for the generate-image-prompt skill */
  imagePromptHint: string;
  /**
   * IDs of characters from Storyboard.characters who appear in this scene.
   * Empty array for scenes with no on-screen characters (e.g. pure b-roll).
   * The generate-image-prompt and generate-video-prompt skills use this list to
   * inject character descriptions (face, clothing, accent) into the generated prompts.
   */
  characterIds: string[];
  /** Transition effect to the next scene, e.g. "cut", "fade to black" */
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
 * Content project manifest (project.json).
 * Written by the agent at project creation and updated after every step.
 *
 * This is the OPERATIONAL manifest: it tracks artifact file locations and statuses.
 * Creative and technical production design (resolution, characters) live in the
 * storyboard (02-storyboard.json), which is referenced via artifacts.storyboard.
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
   * Also writes an empty tasks.json file for per-project task storage.
   * Returns the project manifest.
   *
   * If a project with the same ID already exists, appends a suffix (-2, -3, etc.)
   * to ensure uniqueness and avoid overwriting existing data.
   */
  async createProject(topic: string, title?: string): Promise<ContentProject> {
    const baseId = generateProjectId(topic);
    const id = await this.findUniqueProjectId(baseId);
    const projectDir = join(this.projectsDir, id);
    const now = new Date().toISOString();

    const project: ContentProject = {
      id,
      title: title ?? topic.slice(0, 100),
      topic,
      createdAt: now,
      updatedAt: now,
      dir: projectDir,
      artifacts: {
        scenes: [],
      },
    };

    // Create project directory
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, 'scenes'), { recursive: true });
    await mkdir(join(projectDir, 'final'), { recursive: true });

    // Write empty tasks file for per-project task storage
    const tasksPath = join(projectDir, 'tasks.json');
    await writeFile(tasksPath, JSON.stringify({ tasks: [], counter: 0 }, null, 2), 'utf-8');

    // Write initial manifest
    await this.writeManifest(project);

    return project;
  }

  /**
   * Find a unique project ID by appending a suffix if necessary.
   * If the base ID is available, returns it as-is.
   * Otherwise, tries baseId-2, baseId-3, etc. until an available ID is found.
   */
  private async findUniqueProjectId(baseId: string): Promise<string> {
    const manifestPath = join(this.projectsDir, baseId, 'project.json');

    // Check if base ID is available
    try {
      await access(manifestPath);
      // File exists, need to find a unique ID
    } catch {
      // File doesn't exist, base ID is available
      return baseId;
    }

    // Find unique ID by appending counter
    let counter = 2;
    while (true) {
      const newId = `${baseId}-${counter}`;
      const newManifestPath = join(this.projectsDir, newId, 'project.json');
      try {
        await access(newManifestPath);
        // Exists, try next counter
        counter++;
      } catch {
        // Doesn't exist, this ID is available
        return newId;
      }
    }
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
   * Returns true if an artifact was found and updated, false if no matching artifact was found.
   */
  async updateArtifactStatus(
    project: ContentProject,
    artifactPath: string,
    status: ArtifactStatus,
  ): Promise<boolean> {
    const updateArtifact = (artifact: Artifact | undefined): boolean => {
      if (!artifact) return false;
      if (artifact.path !== artifactPath) return false;
      artifact.status = status;
      if (status === 'approved') {
        artifact.approvedAt = new Date().toISOString();
      } else {
        delete artifact.approvedAt;
      }
      return true;
    };

    // Check top-level artifacts
    if (updateArtifact(project.artifacts.trendReport)) {
      await this.writeManifest(project);
      return true;
    }
    if (updateArtifact(project.artifacts.storyboard)) {
      await this.writeManifest(project);
      return true;
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
        return true;
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
        return true;
      }
    }

    return false;
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
   * Get the absolute path for a project file.
   * Validates that the resolved path stays within the project directory.
   * @throws Error if the path would escape the project directory
   */
  getProjectFilePath(projectId: string, relativePath: string): string {
    const projectDir = join(this.projectsDir, projectId);
    const resolvedPath = resolve(projectDir, relativePath);

    // Ensure the resolved path is within the project directory
    if (!resolvedPath.startsWith(projectDir + '/') && resolvedPath !== projectDir) {
      throw new Error(
        `Path traversal attempt detected: "${relativePath}" resolves outside project directory`,
      );
    }

    return resolvedPath;
  }
}
