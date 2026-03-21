import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './tool';

export interface BashInput {
  command: string;
}

export interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const bashTool: Tool<BashInput, BashOutput> = {
  name: 'bash',
  description: 'Run a shell command and return stdout, stderr, and the exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },

  execute(input: BashInput, ctx: ToolContext): Promise<BashOutput> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', input.command], { cwd: ctx.cwd });

      let stdout = '';
      let stderr = '';
      let settled = false;

      proc.stdout.on('data', (chunk: Buffer | string) => {
        stdout += String(chunk);
      });

      proc.stderr.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk);
      });

      // Register 'error' before 'close' so that if both fire (e.g. ENOENT
      // spawning an invalid executable), the rejection wins and the subsequent
      // 'close' call to resolve is a no-op.
      proc.on('error', (err: Error) => {
        settled = true;
        reject(err);
      });

      proc.on('close', (code: number | null) => {
        if (!settled) resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  },
};
