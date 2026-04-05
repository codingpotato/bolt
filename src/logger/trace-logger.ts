/**
 * Trace logger — writes pretty formatted trace output to stderr for debugging.
 *
 * Only active when `BOLT_LOG_TRACE=true`. Outputs colorized bordered blocks to
 * stderr showing full LLM payloads, tool calls, and sub-agent dispatches in
 * real time — no file writing, no post-processing required.
 *
 * The output is visually distinct from the one-line structured log format
 * (uses box-drawing characters and block headers).
 */

// ANSI codes
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const MAGENTA = '\x1b[35m';

export interface TraceLogger {
  /** Full system prompt sent to the LLM — logged once per session. */
  systemPrompt(prompt: string, model: string): void;
  /** Last user/tool message and context summary sent to the LLM. */
  llmRequest(messages: unknown[], model: string, tools?: unknown[]): void;
  /** Full response from the LLM including all content blocks. */
  llmResponse(response: unknown): void;
  /** Full tool call input. */
  toolCall(toolName: string, callId: string, input: unknown): void;
  /** Full tool call result. */
  toolResult(toolName: string, callId: string, result: unknown, isError?: boolean): void;
  /** Full sub-agent/skill prompt and allowed tools. */
  subagentDispatch(prompt: string, model: string, allowedTools?: string[]): void;
  /** Full sub-agent/skill output. */
  subagentResult(output: string, durationMs: number): void;
}

/** Returns the current terminal width, capped at 120 columns. */
function getWidth(): number {
  return Math.min(process.stderr.columns || 80, 120);
}

/** Pads or truncates a string to exactly `width` chars. */
function pad(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

/**
 * Splits a string into lines of at most `width` chars,
 * preserving existing newlines.
 */
function wrapText(text: string, width: number): string[] {
  const result: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length <= width) {
      result.push(rawLine);
    } else {
      let rest = rawLine;
      while (rest.length > width) {
        result.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      if (rest.length > 0) result.push(rest);
    }
  }
  return result;
}

/**
 * Draws a bordered block to stderr.
 *
 * Layout:
 *   ╔══ HEADER ══════════════════╗
 *   ║ meta line                  ║   ← shown only when meta is non-empty
 *   ╟────────────────────────────╢   ← shown only when both meta and body exist
 *   ║ body line 1                ║
 *   ║ body line 2                ║
 *   ╚════════════════════════════╝
 *
 * @param header - Title in the top border
 * @param color - ANSI color applied to the border and header
 * @param meta - Optional single-line metadata row (not wrapped)
 * @param body - Multi-line content (wrapped at contentWidth)
 * @param maxBodyLines - Truncate body after this many lines (0 = unlimited)
 */
function drawBlock(
  header: string,
  color: string,
  meta: string | null,
  body: string,
  maxBodyLines = 0,
): void {
  const width = getWidth();
  const inner = width - 2; // chars between ╔ and ╗
  const contentWidth = inner - 2; // inner minus the two space paddings

  // Build top bar: ╔══ HEADER ════...════╗
  const headerPadded = ` ${header} `;
  const fillWidth = inner - 2 - headerPadded.length; // 2 = the '══' prefix
  const topBar = `╔══${headerPadded}${'═'.repeat(Math.max(0, fillWidth))}╗`;
  const botBar = `╚${'═'.repeat(inner)}╝`;
  const separator = `╟${'─'.repeat(inner)}╢`;

  const out: string[] = [];
  out.push(`${color}${BOLD}${topBar}${RESET}`);

  if (meta) {
    out.push(`${DIM}║ ${pad(meta, contentWidth)} ║${RESET}`);
  }

  if (body.trim()) {
    if (meta) {
      out.push(`${DIM}${separator}${RESET}`);
    }
    let lines = wrapText(body, contentWidth);
    let truncated = false;
    if (maxBodyLines > 0 && lines.length > maxBodyLines) {
      lines = lines.slice(0, maxBodyLines);
      truncated = true;
    }
    for (const line of lines) {
      out.push(`║ ${pad(line, contentWidth)} ║`);
    }
    if (truncated) {
      out.push(`${DIM}║ ${pad('... (truncated)', contentWidth)} ║${RESET}`);
    }
  }

  out.push(`${color}${BOLD}${botBar}${RESET}`);
  process.stderr.write(out.join('\n') + '\n\n');
}

/**
 * Converts a message content value (string or content-block array) to a
 * human-readable string for display in trace output.
 */
function formatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);

  return (content as unknown[])
    .map((block) => {
      if (typeof block !== 'object' || block === null) return String(block);
      const b = block as Record<string, unknown>;
      switch (b['type']) {
        case 'text':
          return String(b['text'] ?? '');
        case 'tool_use':
          return `[tool_use: ${String(b['name'])}]\n${JSON.stringify(b['input'], null, 2)}`;
        case 'tool_result':
          return `[tool_result id=${String(b['tool_use_id'])}]\n${String(b['content'] ?? '')}`;
        default:
          return JSON.stringify(block, null, 2);
      }
    })
    .join('\n---\n');
}

export function createTraceLogger(): TraceLogger {
  return {
    systemPrompt(prompt, model) {
      drawBlock(
        'SYSTEM PROMPT',
        MAGENTA,
        `model=${model}  length=${prompt.length}`,
        prompt,
        60,
      );
    },

    llmRequest(messages, model, tools) {
      const msgs = messages as Array<{ role: string; content: unknown }>;
      const last = msgs[msgs.length - 1];
      const body = last ? `[${last.role}]\n${formatContent(last.content)}` : '';
      drawBlock(
        'LLM REQUEST',
        CYAN,
        `model=${model}  messages=${messages.length}  tools=${tools?.length ?? 0}`,
        body,
        40,
      );
    },

    llmResponse(response) {
      const r = response as {
        stop_reason?: string | null;
        usage?: { input_tokens: number; output_tokens: number };
        content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
      };

      const stopReason = r.stop_reason ?? 'end_turn';
      const inTok = r.usage?.input_tokens ?? 0;
      const outTok = r.usage?.output_tokens ?? 0;

      const parts: string[] = [];
      for (const block of r.content ?? []) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'tool_use') {
          parts.push(`→ ${block.name}\n${JSON.stringify(block.input, null, 2)}`);
        }
      }

      drawBlock(
        'LLM RESPONSE',
        CYAN,
        `stop=${stopReason}  in=${inTok}  out=${outTok}`,
        parts.join('\n---\n'),
        40,
      );
    },

    toolCall(toolName, callId, input) {
      const body = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input);
      drawBlock(
        `TOOL CALL: ${toolName}`,
        YELLOW,
        `id=${callId}`,
        body,
        30,
      );
    },

    toolResult(toolName, callId, result, isError) {
      const color = isError ? RED : GREEN;
      const status = isError ? '✗' : '✓';
      const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      drawBlock(
        `TOOL RESULT ${status}: ${toolName}`,
        color,
        `id=${callId}`,
        body,
        30,
      );
    },

    subagentDispatch(prompt, model, allowedTools) {
      const toolsList = allowedTools?.join(', ') ?? 'all';
      drawBlock(
        'SUBAGENT DISPATCH',
        MAGENTA,
        `model=${model}  tools=[${toolsList}]`,
        prompt,
        40,
      );
    },

    subagentResult(output, durationMs) {
      drawBlock(
        'SUBAGENT RESULT',
        MAGENTA,
        `duration=${durationMs}ms  length=${output.length}`,
        output,
        40,
      );
    },
  };
}

/** A no-op trace logger that discards all entries — used in tests and non-trace mode. */
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
