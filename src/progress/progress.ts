/** Context info emitted just before each LLM API call. */
export interface LlmCallInfo {
  /** Number of messages currently in L1 active context. */
  messageCount: number;
  /** Token estimate for messages injected at session start (may be 0 after compaction). */
  injectedTokens: number;
  /** Token estimate for system prompt. */
  systemTokens: number;
  /** Token estimate for all messages in L1 context (user + assistant + tool results). */
  ctxTokens: number;
}

/** Token usage emitted immediately after each LLM API response. */
export interface LlmResponseInfo {
  /** Actual input tokens consumed, as reported by the API. */
  inputTokens: number;
  /** Actual output tokens generated, as reported by the API. */
  outputTokens: number;
  /** Why the model stopped: 'end_turn' | 'tool_use' | 'max_tokens' | etc. */
  stopReason: string;
  /** Total context window capacity for the model, in tokens. */
  windowCapacity: number;
}

/**
 * ProgressReporter — the narrow event interface injected into AgentCore,
 * ToolBus (via ToolContext), and MemoryManager so each component can emit
 * progress events without depending on any concrete UI implementation.
 */
export interface ProgressReporter {
  /** Agent session started or resumed. */
  onSessionStart(sessionId: string, resumed: boolean): void;

  /** Model is about to be called (spinner start). */
  onThinking(): void;

  /** Emitted just before each LLM API call with current context state. */
  onLlmCall(info: LlmCallInfo): void;

  /** Emitted immediately after each LLM API response with actual token usage. */
  onLlmResponse(info: LlmResponseInfo): void;

  /** A tool call is about to be dispatched. */
  onToolCall(name: string, input: unknown): void;

  /** A tool call completed. */
  onToolResult(name: string, success: boolean, summary: string): void;

  /** A task's status changed. */
  onTaskStatusChange(taskId: string, title: string, status: string): void;

  /** Prior session messages were injected into context. */
  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void;

  /** Memory compaction completed — evicted messages summarised and stored. */
  onMemoryCompaction(evictedCount: number, summary: string, tags: string[]): void;

  /** An API call failed and will be retried. */
  onRetry(attempt: number, maxAttempts: number, reason: string): void;

  /** A skill subagent is about to be spawned. */
  onSubagentStart(skillName: string, description: string): void;

  /** A skill subagent completed successfully. */
  onSubagentEnd(skillName: string, durationMs: number): void;

  /** A skill subagent failed. */
  onSubagentError(skillName: string, error: string): void;
}

/** No-op implementation — used by sub-agents, Discord channel, and tests. */
export class NoopProgressReporter implements ProgressReporter {
  onSessionStart(_sessionId: string, _resumed: boolean): void {}
  onThinking(): void {}
  onLlmCall(_info: LlmCallInfo): void {}
  onLlmResponse(_info: LlmResponseInfo): void {}
  onToolCall(_name: string, _input: unknown): void {}
  onToolResult(_name: string, _success: boolean, _summary: string): void {}
  onTaskStatusChange(_taskId: string, _title: string, _status: string): void {}
  onContextInjection(_source: 'task' | 'chat', _count: number, _taskId?: string): void {}
  onMemoryCompaction(_evictedCount: number, _summary: string, _tags: string[]): void {}
  onRetry(_attempt: number, _maxAttempts: number, _reason: string): void {}
  onSubagentStart(_skillName: string, _description: string): void {}
  onSubagentEnd(_skillName: string, _durationMs: number): void {}
  onSubagentError(_skillName: string, _error: string): void {}
}
