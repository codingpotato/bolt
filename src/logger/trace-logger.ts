import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Trace logger — writes full LLM request/response payloads to a separate file.
 *
 * Only active when `BOLT_LOG_TRACE=true`. Writes to `.bolt/trace.jsonl`.
 * Each line is a JSON object with a `type` field distinguishing the entry kind.
 *
 * The trace file is separate from `bolt.log` to avoid polluting normal logs
 * with multi-kilobyte prompt/response payloads. It is intended for deep
 * debugging, replay, and prompt engineering analysis.
 */
export interface TraceLogger {
  /** Full system prompt sent to the LLM. */
  systemPrompt(prompt: string, model: string): void;
  /** Complete messages array sent to the LLM. */
  llmRequest(messages: unknown[], model: string, tools?: unknown[]): void;
  /** Full response from the LLM including all content blocks. */
  llmResponse(response: unknown): void;
  /** Full tool call input. */
  toolCall(toolName: string, callId: string, input: unknown): void;
  /** Full tool call result. */
  toolResult(toolName: string, callId: string, result: unknown, isError?: boolean): void;
  /** Full sub-agent payload (minus credentials). */
  subagentDispatch(prompt: string, model: string, allowedTools?: string[]): void;
  /** Full sub-agent output. */
  subagentResult(output: string, durationMs: number): void;
}

interface TraceEntry {
  ts: string;
  type: string;
  [key: string]: unknown;
}

export function createTraceLogger(traceFilePath: string): TraceLogger {
  const traceDir = dirname(traceFilePath);
  let initPromise: Promise<void> | null = null;

  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(traceDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  function write(entry: TraceEntry): void {
    const line = JSON.stringify(entry) + '\n';
    void ensureDir()
      .then(() => appendFile(traceFilePath, line))
      .catch(() => undefined);
  }

  return {
    systemPrompt(prompt, model) {
      write({
        ts: new Date().toISOString(),
        type: 'system_prompt',
        model,
        promptLength: prompt.length,
        prompt,
      });
    },

    llmRequest(messages, model, tools) {
      write({
        ts: new Date().toISOString(),
        type: 'llm_request',
        model,
        messageCount: messages.length,
        toolCount: tools?.length ?? 0,
        messages,
        ...(tools ? { tools } : {}),
      });
    },

    llmResponse(response) {
      write({
        ts: new Date().toISOString(),
        type: 'llm_response',
        response,
      });
    },

    toolCall(toolName, callId, input) {
      write({
        ts: new Date().toISOString(),
        type: 'tool_call',
        toolName,
        callId,
        input,
      });
    },

    toolResult(toolName, callId, result, isError) {
      write({
        ts: new Date().toISOString(),
        type: 'tool_result',
        toolName,
        callId,
        isError: isError ?? false,
        result,
      });
    },

    subagentDispatch(prompt, model, allowedTools) {
      write({
        ts: new Date().toISOString(),
        type: 'subagent_dispatch',
        model,
        promptLength: prompt.length,
        prompt,
        ...(allowedTools ? { allowedTools } : {}),
      });
    },

    subagentResult(output, durationMs) {
      write({
        ts: new Date().toISOString(),
        type: 'subagent_result',
        outputLength: output.length,
        output,
        durationMs,
      });
    },
  };
}

/** A no-op trace logger that discards all entries. */
export function createNoopTraceLogger(): TraceLogger {
  return {
    systemPrompt() {},
    llmRequest() {},
    llmResponse() {},
    toolCall() {},
    toolResult() {},
    subagentDispatch() {},
    subagentResult() {},
  };
}
