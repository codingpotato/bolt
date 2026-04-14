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
 * Voice design profile for OmniVoice TTS narration via comfyui_tts.
 * Applied to every scene where audioSource === "narration".
 * One narrator voice per video — stored in Storyboard.narrator.
 *
 * At synthesis time, attributes are assembled into a voiceInstruct string and a speed value:
 *   voiceInstruct = "<gender>, <age>, <pitch> pitch, <accent>[, <style>]"
 *   speed         = narratorToSpeed(narrator.pace)
 *
 * See docs/design/tts-narration.md for the full selection guide.
 */
export interface NarrationVoice {
  /** Narrator archetype for scriptwriting guidance, e.g. "documentary narrator" */
  persona: string;
  /** Voice gender. Maps to the first voiceInstruct term. */
  gender: 'male' | 'female';
  /** Vocal age group. Maps to the second voiceInstruct term. */
  age: 'child' | 'young' | 'middle-aged' | 'elderly';
  /**
   * Pitch register. Maps to the "<x> pitch" voiceInstruct term.
   *   very-low → "very low pitch"
   *   low      → "low pitch"
   *   medium   → "medium pitch"
   *   high     → "high pitch"
   *   very-high→ "very high pitch"
   */
  pitch: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
  /**
   * Regional accent — passed verbatim as the accent voiceInstruct term.
   * Examples: "american accent", "british accent", "australian accent",
   *           "indian accent", "mandarin accent", "french accent"
   * For Chinese dialects: "四川话", "广东话", "东北话"
   */
  accent: string;
  /**
   * Speaking pace — maps to comfyui_tts `speed` parameter:
   *   slow      → 0.8
   *   medium    → 1.0
   *   fast      → 1.2
   *   very-fast → 1.4
   */
  pace: 'slow' | 'medium' | 'fast' | 'very-fast';
  /**
   * Vocal style modifier — appended to voiceInstruct when set.
   * "whisper" is the only OmniVoice style currently supported.
   */
  style?: 'whisper';
  /**
   * Diffusion quality steps for comfyui_tts. Default: 32.
   * 16 = faster generation, 64 = best quality.
   */
  steps?: number;
  /**
   * Classifier-free guidance scale for comfyui_tts. Default: 2.0.
   * Higher = more faithful to voiceInstruct, less variation.
   */
  guidanceScale?: number;
}

const PITCH_LABELS: Record<NarrationVoice['pitch'], string> = {
  'very-low': 'very low pitch',
  low: 'low pitch',
  medium: 'medium pitch',
  high: 'high pitch',
  'very-high': 'very high pitch',
};

const SPEED_VALUES: Record<NarrationVoice['pace'], number> = {
  slow: 0.8,
  medium: 1.0,
  fast: 1.2,
  'very-fast': 1.4,
};

/**
 * Derive the voiceInstruct string for comfyui_tts from a NarrationVoice profile.
 * Format: "<gender>, <age>, <pitch> pitch, <accent>[, <style>]"
 * Example: "female, young, high pitch, british accent, whisper"
 */
export function narratorToVoiceInstruct(narrator: NarrationVoice): string {
  const parts = [narrator.gender, narrator.age, PITCH_LABELS[narrator.pitch], narrator.accent];
  if (narrator.style) parts.push(narrator.style);
  return parts.join(', ');
}

/**
 * Derive the speed parameter for comfyui_tts from a NarrationVoice pace.
 */
export function narratorToSpeed(narrator: NarrationVoice): number {
  return SPEED_VALUES[narrator.pace];
}

/**
 * Storyboard output from the generate-video-script skill.
 * This is the complete production design document for a video project.
 * It contains all creative and technical decisions that downstream generation steps need:
 * - resolution (for comfyui_text2img and comfyui_img2video)
 * - characters (for image and video prompt generation)
 * - narrator (for OmniVoice TTS narration synthesis)
 * - scenes (with character assignments and audioSource per scene)
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
  /**
   * Narrator voice design profile for comfyui_tts (OmniVoice model).
   * Applies to every narration scene. Use narratorToVoiceInstruct() and
   * narratorToSpeed() to derive the comfyui_tts call parameters.
   */
  narrator: NarrationVoice;
  scenes: Scene[];
}

/**
 * A single scene in a video storyboard.
 */
export interface Scene {
  sceneNumber: number;
  /** What happens visually in this scene */
  description: string;
  /**
   * Primary audio source for this scene. Required on every scene.
   *
   * "character-speech": character speaks on camera → LTX-Video generates lip-synced clip with
   *   baked audio. Set `dialogue`, leave `narration` empty.
   *
   * "narration": off-screen narrator voices this scene → LTX-Video generates a silent clip;
   *   OmniVoice TTS synthesizes narration.wav which is mixed in. Set `narration`, leave `dialogue` empty.
   *
   * "silent": no speech or narration → LTX-Video generates a silent clip for background music.
   *   Both `dialogue` and `narration` must be empty.
   */
  audioSource: 'character-speech' | 'narration' | 'silent';
  /**
   * Dialogue spoken by a character on camera.
   * Only set when audioSource === "character-speech".
   * Injected into the LTX-Video prompt to animate lip sync.
   */
  dialogue?: string;
  /**
   * Narration voiceover text for off-screen narrator.
   * Only set when audioSource === "narration".
   * Sent to OmniVoice TTS using Storyboard.narrator voice profile.
   */
  narration?: string;
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
   * For narration scenes, characters may appear visually (pose/motion) but their
   * speakingAccent is not used — the video prompt must not include speech animation.
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
  /** LTX-Video clip — silent for narration/silent scenes */
  clip?: Artifact;
  /** comfyui_tts output audio — narration scenes only (scenes/scene-<NN>/narration.wav) */
  narrationAudio?: Artifact;
  /** clip.mp4 + narration audio mixed — narration scenes only (scenes/scene-<NN>/narrated.mp4) */
  narratedClip?: Artifact;
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
   * Add a new artifact to the project manifest.
   * Returns true if the artifact was added, false if an artifact with the same path already exists.
   * @param project The content project to update
   * @param artifactPath Path relative to project directory, e.g. "01-trend-report.md"
   * @param status Initial status (defaults to 'pending')
   * @param artifactType Type of artifact: 'trendReport', 'storyboard', or 'scene'
   * @param sceneNumber Required when artifactType is 'scene'; the scene number (1-based)
   * @param sceneArtifactType Required when artifactType is 'scene'; one of: 'imagePrompt', 'image', 'videoPrompt', 'clip', 'narrationAudio', 'narratedClip'
   */
  async addArtifact(
    project: ContentProject,
    artifactPath: string,
    status: ArtifactStatus = 'pending',
    artifactType: 'trendReport' | 'storyboard' | 'scene' = 'trendReport',
    sceneNumber?: number,
    sceneArtifactType?: 'imagePrompt' | 'image' | 'videoPrompt' | 'clip' | 'narrationAudio' | 'narratedClip',
  ): Promise<boolean> {
    // Ensure artifacts structure exists
    if (!project.artifacts) {
      project.artifacts = { scenes: [] };
    }
    if (!project.artifacts.scenes) {
      project.artifacts.scenes = [];
    }

    // Check if artifact already exists
    if (await this.findArtifact(project, artifactPath)) {
      return false;
    }

    const newArtifact: Artifact = {
      path: artifactPath,
      status,
    };

    if (artifactType === 'trendReport') {
      project.artifacts.trendReport = newArtifact;
    } else if (artifactType === 'storyboard') {
      project.artifacts.storyboard = newArtifact;
    } else if (artifactType === 'scene' && sceneNumber !== undefined && sceneArtifactType) {
      let scene = project.artifacts.scenes.find((s) => s.sceneNumber === sceneNumber);
      if (!scene) {
        scene = { sceneNumber };
        project.artifacts.scenes.push(scene);
      }
      scene[sceneArtifactType] = newArtifact;
    } else {
      return false;
    }

    await this.writeManifest(project);
    return true;
  }

  /**
   * Find an artifact by path in the project manifest.
   * Returns the artifact if found, undefined otherwise.
   */
  private findArtifact(project: ContentProject, artifactPath: string): Artifact | undefined {
    if (project.artifacts.trendReport?.path === artifactPath) {
      return project.artifacts.trendReport;
    }
    if (project.artifacts.storyboard?.path === artifactPath) {
      return project.artifacts.storyboard;
    }
    for (const scene of project.artifacts.scenes || []) {
      const artifacts = [
        scene.imagePrompt,
        scene.image,
        scene.videoPrompt,
        scene.clip,
        scene.narrationAudio,
        scene.narratedClip,
      ];
      for (const artifact of artifacts) {
        if (artifact?.path === artifactPath) {
          return artifact;
        }
      }
    }
    const pp = project.artifacts.postProduction;
    if (pp) {
      const ppArtifacts = [pp.subtitles, pp.rawVideo, pp.audioVideo, pp.finalVideo];
      for (const artifact of ppArtifacts) {
        if (artifact?.path === artifactPath) {
          return artifact;
        }
      }
    }
    return undefined;
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
    // Ensure artifacts structure exists (handles old/incompatible project.json files)
    if (!project.artifacts) {
      project.artifacts = { scenes: [] };
    }
    if (!project.artifacts.scenes) {
      project.artifacts.scenes = [];
    }

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
        updateArtifact(scene.clip) ||
        updateArtifact(scene.narrationAudio) ||
        updateArtifact(scene.narratedClip)
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
