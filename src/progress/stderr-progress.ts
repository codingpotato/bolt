import type { LlmCallInfo, LlmResponseInfo, ProgressReporter } from './progress';

/**
 * ProgressReporter used inside sub-agent child processes.
 *
 * Forwards high-signal events to the parent process by writing newline-delimited
 * JSON lines to stderr, each prefixed with "PROGRESS:". The parent's
 * subagent-runner reads these in real time and re-emits them as
 * onSubagentThinking / onSubagentToolCall / onSubagentToolResult / onSubagentRetry.
 *
 * Low-signal events (session lifecycle, LLM token usage, task state, memory
 * compaction) are suppressed to avoid noise.
 */
export class StderrProgressReporter implements ProgressReporter {
  private emit(data: Record<string, unknown>): void {
    process.stderr.write('PROGRESS:' + JSON.stringify(data) + '\n');
  }

  onThinking(): void {
    this.emit({ event: 'onThinking' });
  }

  onToolCall(name: string, input: unknown): void {
    this.emit({ event: 'onToolCall', name, input });
  }

  onToolResult(name: string, success: boolean, summary: string): void {
    this.emit({ event: 'onToolResult', name, success, summary });
  }

  onRetry(attempt: number, maxAttempts: number, reason: string): void {
    this.emit({ event: 'onRetry', attempt, maxAttempts, reason });
  }

  // Suppressed — low-signal or irrelevant to the parent.
  onSessionStart(_sessionId: string, _resumed: boolean): void {}
  onLlmCall(_info: LlmCallInfo): void {}
  onLlmResponse(_info: LlmResponseInfo): void {}
  onTaskStatusChange(_taskId: string, _title: string, _status: string): void {}
  onContextInjection(_source: 'task' | 'chat', _count: number, _taskId?: string): void {}
  onMemoryCompaction(_evictedCount: number, _summary: string, _tags: string[]): void {}
  onSubagentStart(_skillName: string, _description: string): void {}
  onSubagentEnd(_skillName: string, _durationMs: number): void {}
  onSubagentError(_skillName: string, _error: string): void {}
  onSubagentThinking(_skill: string): void {}
  onSubagentToolCall(_skill: string, _name: string, _input: unknown): void {}
  onSubagentToolResult(_skill: string, _name: string, _success: boolean, _summary: string): void {}
  onSubagentRetry(_skill: string, _attempt: number, _maxAttempts: number, _reason: string): void {}
}
