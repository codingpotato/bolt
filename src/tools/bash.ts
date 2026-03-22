import { spawn } from 'node:child_process';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export interface BashInput {
  command: string;
}

/** Patterns that require explicit user confirmation before running. */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\b.*-[a-zA-Z]*[rR]/,        // rm -r, rm -rf, rm -Rf, etc.
  /\bsudo\b/,                        // sudo
  /\bsu\s/,                          // su <user>
  /\|\s*(sh|bash)\b/,               // pipe to shell
  /\bmkfs/,                          // filesystem format
  /\bdd\b.*\bof=/,                   // raw disk write
  />\s*\/dev\/(sd[a-z]|nvme)/,      // write to block device
  /\bkillall\b/,                     // killall
  /\bpkill\b/,                       // pkill
  /\bshred\b/,                       // shred
];

/** Returns the matched pattern description, or null if the command is safe. */
function detectDangerous(command: string): string | null {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return pattern.source;
    }
  }
  return null;
}

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sh', ['-c', command], { cwd });

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

  async execute(input: BashInput, ctx: ToolContext): Promise<string> {
    const matched = detectDangerous(input.command);
    if (matched !== null) {
      const confirm = ctx.confirm;
      if (!confirm) {
        throw new ToolError(
          `command blocked: "${input.command}" matches dangerous pattern — confirmation not available`,
          false,
        );
      }
      const ok = await confirm(
        `The following command matches a dangerous pattern (${matched}):\n\n  ${input.command}\n\nRun it? [y/N]`,
      );
      if (!ok) {
        throw new ToolError(`command "${input.command}" was denied`, false);
      }
    }
    return runCommand(input.command, ctx.cwd);
  },
};
