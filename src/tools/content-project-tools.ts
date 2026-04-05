import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import {
  ContentProjectManager,
  type ContentProject,
  type ArtifactStatus,
} from '../content/content-project';

interface ContentProjectCreateInput {
  topic: string;
  title?: string;
}

interface ContentProjectCreateOutput {
  projectId: string;
  manifestPath: string;
  projectDir: string;
}

interface ContentProjectReadInput {
  projectId: string;
}

interface ContentProjectUpdateArtifactInput {
  projectId: string;
  artifactPath: string;
  status: ArtifactStatus;
}

interface ContentProjectUpdateArtifactOutput {
  updated: boolean;
}

export function createContentProjectTools(): Tool[] {
  const create: Tool<ContentProjectCreateInput, ContentProjectCreateOutput> = {
    name: 'content_project_create',
    description:
      'Create a content project directory and initial project.json manifest inside the workspace. Returns the project ID, manifest path, and absolute project directory. If a project with the same topic and date already exists, a unique suffix (-2, -3, …) is appended.',
    sequential: true,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Original user brief / topic for the content project.',
        },
        title: {
          type: 'string',
          description: 'Human-readable project title (defaults to topic).',
        },
      },
      required: ['topic'],
    },
    async execute(
      input: ContentProjectCreateInput,
      ctx: ToolContext,
    ): Promise<ContentProjectCreateOutput> {
      const manager = new ContentProjectManager(ctx.cwd);
      try {
        const project = await manager.createProject(input.topic, input.title);
        return {
          projectId: project.id,
          manifestPath: `projects/${project.id}/project.json`,
          projectDir: project.dir,
        };
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const read: Tool<ContentProjectReadInput, ContentProject> = {
    name: 'content_project_read',
    description:
      'Read and return the current ContentProject manifest for a given project ID. Returns a ToolError if the project does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID (slug) to read, e.g. "ai-coding-trends-2026-03-24".',
        },
      },
      required: ['projectId'],
    },
    async execute(input: ContentProjectReadInput, ctx: ToolContext): Promise<ContentProject> {
      const manager = new ContentProjectManager(ctx.cwd);
      const project = await manager.readProject(input.projectId);
      if (!project) {
        throw new ToolError(`Content project "${input.projectId}" not found`, false);
      }
      return project;
    },
  };

  const updateArtifact: Tool<
    ContentProjectUpdateArtifactInput,
    ContentProjectUpdateArtifactOutput
  > = {
    name: 'content_project_update_artifact',
    description:
      "Update an artifact's status (pending/draft/approved/failed) in project.json. Returns { updated: false } when no artifact with the given path exists in the manifest.",
    sequential: true,
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID of the content project.',
        },
        artifactPath: {
          type: 'string',
          description:
            "Path relative to the project directory, e.g. \"01-trend-report.md\" or \"scenes/scene-01/image.png\".",
        },
        status: {
          type: 'string',
          enum: ['pending', 'draft', 'approved', 'failed'],
          description: 'New status for the artifact.',
        },
      },
      required: ['projectId', 'artifactPath', 'status'],
    },
    async execute(
      input: ContentProjectUpdateArtifactInput,
      ctx: ToolContext,
    ): Promise<ContentProjectUpdateArtifactOutput> {
      const manager = new ContentProjectManager(ctx.cwd);
      const project = await manager.readProject(input.projectId);
      if (!project) {
        throw new ToolError(`Content project "${input.projectId}" not found`, false);
      }
      const updated = await manager.updateArtifactStatus(
        project,
        input.artifactPath,
        input.status,
      );
      return { updated };
    },
  };

  return [create, read, updateArtifact];
}
