import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import type { ComfyUIPool } from '../comfyui/comfyui-pool';
import { patchWorkflow } from '../comfyui/comfyui-pool';
import { resolvePath, assertWithinWorkspace } from './fs-utils';

export interface ComfyUIImg2VideoInput {
  imagePath: string;
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  seed?: number;
  outputPath?: string;
}

export interface ComfyUIImg2VideoOutput {
  outputPath: string;
  durationMs: number;
}

export function createComfyUIImg2VideoTool(
  pool: ComfyUIPool | null,
  timeoutMs: number,
): Tool<ComfyUIImg2VideoInput, ComfyUIImg2VideoOutput> {
  return {
    name: 'comfyui_img2video',
    description:
      'Generate a video from an image using ComfyUI LTX-Video. Uploads the source image then generates a video.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: {
          type: 'string',
          description: 'Path to the source image file within the workspace.',
        },
        prompt: { type: 'string', description: 'Text description of the desired motion/video.' },
        negativePrompt: {
          type: 'string',
          description: 'Negative prompt to avoid unwanted elements.',
        },
        width: {
          type: 'number',
          description: 'Output video width (default: 1280).',
          default: 1280,
        },
        height: {
          type: 'number',
          description: 'Output video height (default: 720).',
          default: 720,
        },
        frames: { type: 'number', description: 'Number of frames (default: 121).', default: 121 },
        fps: { type: 'number', description: 'Frames per second (default: 24).', default: 24 },
        seed: {
          type: 'number',
          description:
            'Random seed for reproducibility. If not provided, a random seed is generated.',
        },
        outputPath: {
          type: 'string',
          description:
            'Output file path within the workspace. Defaults to generated timestamped filename.',
        },
      },
      required: ['imagePath', 'prompt'],
    },

    async execute(input: ComfyUIImg2VideoInput, ctx: ToolContext): Promise<ComfyUIImg2VideoOutput> {
      if (!pool) {
        throw new ToolError(
          'No ComfyUI servers configured — add servers to config.comfyui.servers',
          false,
        );
      }

      const rawOutputPath = input.outputPath ?? `scenes/${Date.now()}-img2video.mp4`;
      const absOutputPath = resolvePath(ctx.cwd, rawOutputPath);
      assertWithinWorkspace(ctx.cwd, absOutputPath, rawOutputPath);

      const absImagePath = resolvePath(ctx.cwd, input.imagePath);
      assertWithinWorkspace(ctx.cwd, absImagePath, input.imagePath);

      const { workflow, patchmap } = pool.loadWorkflow('video_ltx2_3_i2v');

      const server = await pool.selectServer();
      const uploadedFilename = await pool.uploadImage(absImagePath, server);

      const seed = input.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const patch: Record<string, Record<string, unknown>> = {};

      if (patchmap.imageNode && patchmap.imageField) {
        patch[patchmap.imageNode] = { [patchmap.imageField]: uploadedFilename };
      }

      if (patchmap.params.prompt) {
        for (const { nodeId, field } of patchmap.params.prompt) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.prompt };
        }
      }
      if (patchmap.params.negativePrompt && input.negativePrompt) {
        for (const { nodeId, field } of patchmap.params.negativePrompt) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.negativePrompt };
        }
      }
      if (patchmap.params.width && input.width) {
        for (const { nodeId, field } of patchmap.params.width) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.width };
        }
      }
      if (patchmap.params.height && input.height) {
        for (const { nodeId, field } of patchmap.params.height) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.height };
        }
      }
      if (patchmap.params.frames && input.frames) {
        for (const { nodeId, field } of patchmap.params.frames) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.frames };
        }
      }
      if (patchmap.params.fps && input.fps) {
        for (const { nodeId, field } of patchmap.params.fps) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.fps };
        }
      }
      if (patchmap.params.seed) {
        for (const { nodeId, field } of patchmap.params.seed) {
          patch[nodeId] = { ...patch[nodeId], [field]: seed };
        }
      }

      const patchedWorkflow =
        Object.keys(patch).length > 0 ? patchWorkflow(workflow, patch) : workflow;

      const startTime = Date.now();

      const promptId = await pool.queueWorkflow(patchedWorkflow, server);

      ctx.progress.onToolCall('comfyui_img2video', { prompt: input.prompt, server: server.url });

      const outputs = await pool.pollResult(promptId, server, timeoutMs);

      if (outputs.files.length === 0) {
        throw new ToolError('Workflow completed but produced no output files', false);
      }

      await pool.downloadOutput(outputs.files[0]!, server, absOutputPath);

      return {
        outputPath: absOutputPath,
        durationMs: Date.now() - startTime,
      };
    },
  };
}
