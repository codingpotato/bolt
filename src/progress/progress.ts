/**
 * ProgressReporter — the narrow event interface injected into AgentCore,
 * ToolBus (via ToolContext), and MemoryManager so each component can emit
 * progress events without depending on any concrete UI implementation.
 */
export interface ProgressReporter {
  /** Agent session started or resumed. */
  onSessionStart(sessionId: string, resumed: boolean): void;

  /** Model is generating a response (spinner / status line). */
  onThinking(): void;

  /** A tool call is about to be dispatched. */
  onToolCall(name: string, input: unknown): void;

  /** A tool call completed. */
  onToolResult(name: string, success: boolean, summary: string): void;

  /** A task's status changed. */
  onTaskStatusChange(taskId: string, title: string, status: string): void;

  /** Prior session messages were injected into context. */
  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void;

  /** Memory compaction was triggered. */
  onMemoryCompaction(evictedCount: number): void;

  /** An API call failed and will be retried. */
  onRetry(attempt: number, maxAttempts: number, reason: string): void;
}

/** No-op implementation — used by sub-agents, Discord channel, and tests. */
export class NoopProgressReporter implements ProgressReporter {
  onSessionStart(_sessionId: string, _resumed: boolean): void {}
  onThinking(): void {}
  onToolCall(_name: string, _input: unknown): void {}
  onToolResult(_name: string, _success: boolean, _summary: string): void {}
  onTaskStatusChange(_taskId: string, _title: string, _status: string): void {}
  onContextInjection(_source: 'task' | 'chat', _count: number, _taskId?: string): void {}
  onMemoryCompaction(_evictedCount: number): void {}
  onRetry(_attempt: number, _maxAttempts: number, _reason: string): void {}
}
