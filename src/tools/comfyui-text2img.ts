import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import type { ComfyUIPool } from '../comfyui/comfyui-pool';
import { patchWorkflow } from '../comfyui/comfyui-pool';

export interface ComfyUIText2ImgInput {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  outputPath?: string;
}

export interface ComfyUIText2ImgOutput {
  outputPath: string;
  seed: number;
  durationMs: number;
}

export function createComfyUIText2ImgTool(
  pool: ComfyUIPool,
  timeoutMs: number,
): Tool<ComfyUIText2ImgInput, ComfyUIText2ImgOutput> {
  return {
    name: 'comfyui_text2img',
    description:
      'Generate an image from a text prompt using ComfyUI. Uses the image_z_image_turbo workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the desired image.' },
        width: { type: 'number', description: 'Image width (default: 1024).', default: 1024 },
        height: { type: 'number', description: 'Image height (default: 1024).', default: 1024 },
        steps: {
          type: 'number',
          description: 'Number of sampling steps (default: 8).',
          default: 8,
        },
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
      required: ['prompt'],
    },

    async execute(input: ComfyUIText2ImgInput, ctx: ToolContext): Promise<ComfyUIText2ImgOutput> {
      const resolvedOutputPath = input.outputPath ?? `${Date.now()}-text2img.png`;

      const { workflow, patchmap } = pool.loadWorkflow('image_z_image_turbo');

      const seed = input.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const patch: Record<string, Record<string, unknown>> = {};
      if (patchmap.params.prompt) {
        for (const { nodeId, field } of patchmap.params.prompt) {
          patch[nodeId] = { [field]: input.prompt };
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
      if (patchmap.params.steps && input.steps) {
        for (const { nodeId, field } of patchmap.params.steps) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.steps };
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

      const server = await pool.selectServer();
      const promptId = await pool.queueWorkflow(patchedWorkflow, server);

      ctx.progress.onToolCall('comfyui_text2img', { prompt: input.prompt, server: server.url });

      const outputs = await pool.pollResult(promptId, server, timeoutMs);

      if (outputs.files.length === 0) {
        throw new ToolError('Workflow completed but produced no output files', false);
      }

      await pool.downloadOutput(outputs.files[0]!, server, resolvedOutputPath);

      return {
        outputPath: resolvedOutputPath,
        seed,
        durationMs: Date.now() - startTime,
      };
    },
  };
}
