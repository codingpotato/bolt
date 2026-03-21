import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './tool';

export interface BashInput {
  command: string;
}

export const bashTool: Tool<BashInput, string> = {
  name: 'bash',
  description: 'Run a shell command and return stdout, stderr, and the exit code.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
    required: ['command'],
  },

  execute(input: BashInput, ctx: ToolContext): Promise<string> {
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

      proc.on('error', (err: Error) => {
        settled = true;
        reject(err);
      });

      proc.on('close', (code: number | null) => {
        if (!settled) {
          const exitCode = code ?? 1;
          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr) parts.push(stderr);
          if (exitCode !== 0) parts.push(`Exit code: ${exitCode}`);
          resolve(parts.join('\n') || '(no output)');
        }
      });
    });
  },
};
