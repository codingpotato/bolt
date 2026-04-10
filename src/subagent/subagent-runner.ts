import { spawn } from 'node:child_process';
import type { AuthConfig } from '../auth/auth';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';
import type { ProgressReporter } from '../progress/progress';
import { NoopProgressReporter } from '../progress/progress';

export interface SubagentPayload {
  prompt: string;
  authConfig: AuthConfig;
  model: string;
  /** Workspace root to use — must be passed from the parent's ctx.cwd. */
  workspaceRoot: string;
  allowedTools?: string[];
  /** Optional system prompt override — used by skill_run to inject the skill's system prompt. */
  systemPrompt?: string;
  /** Inherited rules from parent (safety, communication, operating modes). */
  inheritedRules?: string;
}

export interface SubagentResult {
  output: string;
}

export type SubagentRunner = (
  payload: SubagentPayload,
  scriptPath: string,
  execPath?: string,
  progress?: ProgressReporter,
  skillName?: string,
) => Promise<SubagentResult>;

/**
 * Dispatches a parsed PROGRESS event from the child's stderr to the parent's
 * ProgressReporter as the corresponding onSubagent* method.
 */
function forwardProgressEvent(
  event: Record<string, unknown>,
  skillName: string,
  progress: ProgressReporter,
  logger: Logger,
): void {
  try {
    switch (event['event']) {
      case 'onThinking':
        progress.onSubagentThinking(skillName);
        break;
      case 'onToolCall':
        progress.onSubagentToolCall(skillName, String(event['name'] ?? ''), event['input']);
        break;
      case 'onToolResult':
        progress.onSubagentToolResult(
          skillName,
          String(event['name'] ?? ''),
          Boolean(event['success']),
          String(event['summary'] ?? ''),
        );
        break;
      case 'onRetry':
        progress.onSubagentRetry(
          skillName,
          Number(event['attempt']),
          Number(event['maxAttempts']),
          String(event['reason'] ?? ''),
        );
        break;
      default:
        logger.debug('Sub-agent unknown PROGRESS event type', { event: String(event['event']) });
    }
  } catch (err) {
    logger.warn('Failed to forward sub-agent progress event', { error: String(err) });
  }
}

/**
 * Spawns a child bolt sub-agent process, passes the payload via stdin,
 * and returns the structured result from stdout.
 *
 * The child constructs its Anthropic client from `authConfig` — it does not
 * read process.env for credentials, ensuring full auth isolation.
 *
 * Stderr is read line-by-line in real time. Lines starting with "PROGRESS:"
 * are parsed as JSON and forwarded to the parent's ProgressReporter as
 * onSubagentThinking / onSubagentToolCall / onSubagentToolResult / onSubagentRetry.
 * All other stderr lines are passed to the logger and collected for the error
 * message on non-zero exit.
 *
 * @param payload   - The subagent payload containing prompt and config
 * @param scriptPath - Path to the subagent script (JS or TS)
 * @param execPath  - Optional Node.js executable path (defaults to process.execPath)
 * @param progress  - Optional ProgressReporter to receive forwarded events
 * @param skillName - Skill name to attach to forwarded events (defaults to 'subagent')
 * @param logger    - Logger for sub-agent lifecycle events
 * @throws if the child exits with a non-zero code (includes captured stderr)
 */
export async function runSubagent(
  payload: SubagentPayload,
  scriptPath: string,
  execPath: string = process.execPath,
  progress: ProgressReporter = new NoopProgressReporter(),
  skillName: string = 'subagent',
  logger: Logger = createNoopLogger(),
): Promise<SubagentResult> {
  const startTime = Date.now();
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));

  logger.info('Sub-agent process spawning', {
    execPath,
    scriptPath,
    payloadBytes,
    model: payload.model,
    allowedTools: payload.allowedTools,
    hasSystemPrompt: !!payload.systemPrompt,
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Sub-agent spawn failed', {
        execPath,
        scriptPath,
        error: message,
      });
      reject(new Error(`Failed to spawn sub-agent: ${message}`));
      return;
    }

    logger.debug('Sub-agent process spawned', { pid: child.pid });

    let stdoutBuf = '';
    // Partial line buffer for stderr — flushed on newline.
    let stderrLineBuf = '';
    // Non-PROGRESS lines collected for error messages on non-zero exit.
    const stderrLines: string[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrLineBuf += chunk.toString();
      const lines = stderrLineBuf.split('\n');
      // Last element is the (possibly empty) incomplete line — keep it buffered.
      stderrLineBuf = lines.pop() ?? '';
      for (const line of lines) {
        processStderrLine(line, skillName, progress, stderrLines, logger);
      }
    });

    child.on('close', (code: number) => {
      // Flush any remaining partial line that didn't end with \n.
      if (stderrLineBuf.length > 0) {
        processStderrLine(stderrLineBuf, skillName, progress, stderrLines, logger);
        stderrLineBuf = '';
      }

      const duration = Date.now() - startTime;
      const stderrForError = stderrLines.join('\n');

      if (code !== 0) {
        logger.warn('Sub-agent exited with non-zero code', {
          exitCode: code,
          duration,
          stderrPreview: stderrForError.slice(0, 500),
        });
        reject(new Error(`Sub-agent exited with code ${code}: ${stderrForError.trim()}`));
        return;
      }

      logger.debug('Sub-agent stdout captured', {
        bytes: stdoutBuf.length,
        preview: stdoutBuf.slice(0, 200),
      });

      try {
        const result = JSON.parse(stdoutBuf) as SubagentResult;
        logger.info('Sub-agent completed', {
          duration,
          outputLength: result.output.length,
          outputPreview: result.output.slice(0, 300),
        });

        resolve(result);
      } catch {
        logger.error('Sub-agent produced invalid JSON', {
          stdoutPreview: stdoutBuf.slice(0, 500),
          stderrPreview: stderrForError.slice(0, 500),
        });
        reject(new Error(`Sub-agent produced invalid JSON output: ${stdoutBuf.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      logger.error('Sub-agent process error', {
        error: err.message,
        execPath,
        scriptPath,
      });
      reject(new Error(`Sub-agent process error: ${err.message}`));
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

/**
 * Handles a single complete stderr line from the child process.
 * PROGRESS: lines are parsed and forwarded; all others are logged and buffered.
 */
function processStderrLine(
  line: string,
  skillName: string,
  progress: ProgressReporter,
  stderrLines: string[],
  logger: Logger,
): void {
  if (line.startsWith('PROGRESS:')) {
    const jsonStr = line.slice('PROGRESS:'.length);
    try {
      const event = JSON.parse(jsonStr) as Record<string, unknown>;
      forwardProgressEvent(event, skillName, progress, logger);
    } catch {
      logger.warn('Sub-agent PROGRESS line is invalid JSON', { line });
    }
  } else {
    stderrLines.push(line);
    logger.debug('Sub-agent stderr', { chunk: line.trim() });
  }
}
