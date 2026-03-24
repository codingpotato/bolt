import { spawn } from 'node:child_process';
import type { AuthConfig } from '../auth/auth';

export interface SubagentPayload {
  prompt: string;
  authConfig: AuthConfig;
  model: string;
  allowedTools?: string[];
  /** Optional system prompt override — used by skill_run to inject the skill's system prompt. */
  systemPrompt?: string;
}

export interface SubagentResult {
  output: string;
}

/**
 * Spawns a child bolt sub-agent process, passes the payload via stdin,
 * and returns the structured result from stdout.
 *
 * The child constructs its Anthropic client from `authConfig` — it does not
 * read process.env for credentials, ensuring full auth isolation.
 *
 * @throws if the child exits with a non-zero code (includes captured stderr)
 */
export async function runSubagent(
  payload: SubagentPayload,
  scriptPath: string,
): Promise<SubagentResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.on('close', (code: number) => {
      if (code !== 0) {
        reject(new Error(`Sub-agent exited with code ${code}: ${stderrBuf.trim()}`));
        return;
      }
      try {
        const result = JSON.parse(stdoutBuf) as SubagentResult;
        resolve(result);
      } catch {
        reject(new Error(`Sub-agent produced invalid JSON output: ${stdoutBuf.slice(0, 200)}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
