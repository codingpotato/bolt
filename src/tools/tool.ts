import type { ToolLogger } from '../audit/audit-logger';
import type { Logger } from '../logger';
import type { ProgressReporter } from '../progress';

export type { ToolLogger };

/**
 * A minimal JSON Schema type — enough to describe tool input shapes and
 * drive Anthropic API definitions + required-field validation.
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  description?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

/** Execution context passed to every tool call. */
export interface ToolContext {
  /** Absolute working directory for the current session. */
  cwd: string;
  /** Audit logger — every tool call is recorded here. */
  log: ToolLogger;
  /** Structured logger — for operational and debug output. */
  logger: Logger;
  /**
   * Names of tools the current agent scope may use.
   * undefined means all registered tools are permitted.
   */
  allowedTools?: string[];
  /** Progress reporter — emits structured events to the UI layer. */
  progress: ProgressReporter;
  /** Current session ID — used by tools that need to stamp session provenance. */
  sessionId?: string;
  /** ID of the task currently being worked on, if any. Set by task_update when a task transitions to in_progress. */
  activeTaskId?: string;
  /**
   * Optional confirmation callback for dangerous operations.
   * When absent (sub-agents, non-interactive mode) the operation is auto-denied.
   */
  confirm?: (message: string) => Promise<boolean>;
}

/** A tool registered with the Tool Bus. */
export interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique snake_case name sent to / received from the model. */
  name: string;
  /** One-line description shown to the model. */
  description: string;
  /** JSON Schema for input — drives Anthropic tool definition + validation. */
  inputSchema: JSONSchema;
  /**
   * If true, the Tool Bus will not run this tool concurrently with other
   * sequential tools. Use for tools that mutate shared state.
   * Defaults to false.
   */
  sequential?: boolean;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

/** A single tool invocation requested by the model. */
export interface ToolCall {
  /** Unique ID assigned by the model (echoed back in the result). */
  id: string;
  name: string;
  input: unknown;
}

/** The result returned to the model for a single tool call. */
export interface ToolResult {
  id: string;
  /** JSON-serialized result or error message. */
  content: string;
  /** true when the tool failed. */
  is_error?: boolean;
}

/** Tool failure — caught by the Tool Bus and serialized as is_error: true. */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}
