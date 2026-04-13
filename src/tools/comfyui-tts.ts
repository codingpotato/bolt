import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import type { ComfyUIPool } from '../comfyui/comfyui-pool';
import { patchWorkflow } from '../comfyui/comfyui-pool';
import { resolvePath, assertWithinWorkspace } from './fs-utils';

export interface ComfyUITTSInput {
  text: string;
  voiceInstruct?: string;
  steps?: number;
  guidanceScale?: number;
  tShift?: number;
  speed?: number;
  duration?: number;
  positionTemperature?: number;
  classTemperature?: number;
  layerPenaltyFactor?: number;
  denoise?: boolean;
  postprocessOutput?: boolean;
  keepModelLoaded?: boolean;
  outputPath?: string;
}

export interface ComfyUITTSOutput {
  outputPath: string;
  durationMs: number;
}

export function createComfyUITTS(
  pool: ComfyUIPool | null,
  timeoutMs: number,
): Tool<ComfyUITTSInput, ComfyUITTSOutput> {
  return {
    name: 'comfyui_tts',
    description:
      'Generate speech from text using OmniVoice TTS on ComfyUI. Supports voice design attributes (gender, age, pitch, accent, style) and non-verbal expression tags. Example voice instruct: "female, young, high pitch, british accent, whisper". Non-verbal tags: [laughter] [sigh] [sniff] [question-en] [surprise-ah] etc.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Text to convert to speech. Can include non-verbal expression tags like [laughter] [sigh] [sniff] [question-en] [surprise-ah].',
        },
        voiceInstruct: {
          type: 'string',
          description:
            'Voice design attributes as comma-separated values. Format: "gender, age, pitch, accent, style". Examples: "female, young, high pitch, british accent, whisper" or "male, middle-aged, low pitch, american accent". Options: Gender (male, female), Age (child, young, middle-aged, elderly), Pitch (very low pitch, low pitch, medium pitch, high pitch, very high pitch), Style (whisper), Accents (american accent, british accent, australian accent, indian accent, etc.), Chinese Dialects (四川话，广东话，东北话，etc.).',
        },
        steps: {
          type: 'number',
          description:
            'Diffusion steps. 16=faster, 32=balanced (default), 64=best quality. Range: 4-64.',
          default: 32,
        },
        guidanceScale: {
          type: 'number',
          description:
            'Classifier-free guidance. Higher = more text-aligned. Range: 0-10. Default: 2.0.',
          default: 2,
        },
        tShift: {
          type: 'number',
          description: 'Time-step shift. Smaller = emphasis on earlier steps. Range: 0-1. Default: 0.1.',
          default: 0.1,
        },
        speed: {
          type: 'number',
          description: 'Speaking speed. >1=faster, <1=slower. Range: 0.5-2.0. Default: 1.0.',
          default: 1,
        },
        duration: {
          type: 'number',
          description:
            'Fixed output duration in seconds. Overrides speed. 0=auto. Range: 0-60. Default: 0.',
          default: 0,
        },
        positionTemperature: {
          type: 'number',
          description:
            'Mask-position randomness. 0=greedy, higher=more random. Range: 0-20. Default: 5.0.',
          default: 5,
        },
        classTemperature: {
          type: 'number',
          description:
            'Token sampling randomness. 0=greedy, higher=more random. Range: 0-5. Default: 0.0.',
          default: 0,
        },
        layerPenaltyFactor: {
          type: 'number',
          description: 'Penalty on deeper codebook layers. Range: 0-20. Default: 5.0.',
          default: 5,
        },
        denoise: {
          type: 'boolean',
          description: 'Prepend denoise token for cleaner output. Default: true.',
          default: true,
        },
        postprocessOutput: {
          type: 'boolean',
          description: 'Remove long silences from generated audio. Default: true.',
          default: true,
        },
        keepModelLoaded: {
          type: 'boolean',
          description:
            'Keep model in memory (offloads to CPU between runs). Default: true.',
          default: true,
        },
        outputPath: {
          type: 'string',
          description:
            'Output file path within the workspace. In content project workflows, always pass the project-relative path (e.g. "projects/<id>/scenes/<filename>.wav"). Defaults to scenes/<timestamp>-tts.wav at workspace root.',
        },
      },
      required: ['text'],
    },

    async execute(input: ComfyUITTSInput, ctx: ToolContext): Promise<ComfyUITTSOutput> {
      if (!pool) {
        throw new ToolError(
          'No ComfyUI servers configured — add servers to config.comfyui.servers',
          false,
        );
      }

      const rawOutputPath = input.outputPath ?? `scenes/${Date.now()}-tts.wav`;
      const absOutputPath = resolvePath(ctx.cwd, rawOutputPath);
      assertWithinWorkspace(ctx.cwd, absOutputPath, rawOutputPath);

      const { workflow, patchmap } = pool.loadWorkflow('tts_omnivoice');

      const patch: Record<string, Record<string, unknown>> = {};

      // Patch text input
      if (patchmap.params.text) {
        for (const { nodeId, field } of patchmap.params.text) {
          patch[nodeId] = { [field]: input.text };
        }
      }

      // Patch voice_instruct if provided
      if (patchmap.params.voiceInstruct && input.voiceInstruct) {
        for (const { nodeId, field } of patchmap.params.voiceInstruct) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.voiceInstruct };
        }
      }

      // Patch optional generation parameters
      if (patchmap.params.steps && input.steps !== undefined) {
        for (const { nodeId, field } of patchmap.params.steps) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.steps };
        }
      }
      if (patchmap.params.guidanceScale && input.guidanceScale !== undefined) {
        for (const { nodeId, field } of patchmap.params.guidanceScale) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.guidanceScale };
        }
      }
      if (patchmap.params.tShift && input.tShift !== undefined) {
        for (const { nodeId, field } of patchmap.params.tShift) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.tShift };
        }
      }
      if (patchmap.params.speed && input.speed !== undefined) {
        for (const { nodeId, field } of patchmap.params.speed) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.speed };
        }
      }
      if (patchmap.params.duration && input.duration !== undefined) {
        for (const { nodeId, field } of patchmap.params.duration) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.duration };
        }
      }
      if (patchmap.params.positionTemperature && input.positionTemperature !== undefined) {
        for (const { nodeId, field } of patchmap.params.positionTemperature) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.positionTemperature };
        }
      }
      if (patchmap.params.classTemperature && input.classTemperature !== undefined) {
        for (const { nodeId, field } of patchmap.params.classTemperature) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.classTemperature };
        }
      }
      if (patchmap.params.layerPenaltyFactor && input.layerPenaltyFactor !== undefined) {
        for (const { nodeId, field } of patchmap.params.layerPenaltyFactor) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.layerPenaltyFactor };
        }
      }
      if (patchmap.params.denoise && input.denoise !== undefined) {
        for (const { nodeId, field } of patchmap.params.denoise) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.denoise };
        }
      }
      if (patchmap.params.postprocessOutput && input.postprocessOutput !== undefined) {
        for (const { nodeId, field } of patchmap.params.postprocessOutput) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.postprocessOutput };
        }
      }
      if (patchmap.params.keepModelLoaded && input.keepModelLoaded !== undefined) {
        for (const { nodeId, field } of patchmap.params.keepModelLoaded) {
          patch[nodeId] = { ...patch[nodeId], [field]: input.keepModelLoaded };
        }
      }

      const patchedWorkflow =
        Object.keys(patch).length > 0 ? patchWorkflow(workflow, patch) : workflow;

      const startTime = Date.now();

      const server = await pool.selectServer();
      const promptId = await pool.queueWorkflow(patchedWorkflow, server);

      ctx.progress.onToolCall('comfyui_tts', {
        text: input.text,
        voiceInstruct: input.voiceInstruct,
        server: server.url,
      });

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
