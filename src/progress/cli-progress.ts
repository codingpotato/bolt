import type { LlmCallInfo, LlmResponseInfo, ProgressReporter } from './progress';

/** ANSI: move up one line then erase it. */
const ERASE_LINE = '\x1b[1A\x1b[2K';

/** Format a number with comma separators for readability. */
export function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Produces a concise, human-readable summary of a tool's input for display.
 * Raw JSON is never dumped; each tool has a known format per the design doc.
 */
export function summariseInput(name: string, input: unknown): string {
  const obj = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  switch (name) {
    case 'bash':
      return `$ ${String(obj['command'] ?? '').slice(0, 120)}`;
    case 'file_read':
    case 'file_write':
    case 'file_edit':
      return String(obj['path'] ?? '');
    case 'web_fetch':
      return String(obj['url'] ?? '').slice(0, 120);
    case 'task_create':
      return `"${String(obj['title'] ?? '')}"`;
    case 'task_update':
      return `${String(obj['id'] ?? '')} → ${String(obj['status'] ?? '')}`;
    case 'memory_search':
      return `"${String(obj['query'] ?? '')}"`;
    case 'memory_write':
      return String(obj['content'] ?? '').slice(0, 80);
    default:
      return JSON.stringify(input).slice(0, 120);
  }
}

/**
 * CliProgressReporter writes formatted progress lines to a writable stream.
 *
 * Output is controlled by three orthogonal flags:
 *   quiet   → suppress all progress even on a TTY
 *   verbose → emit progress even in non-TTY mode
 *   isTTY   → the stream is attached to a terminal (automatic)
 *
 * When none of the flags are set, output is emitted only when the stream is
 * a TTY (i.e. interactive terminal).
 *
 * The "Thinking…" line is managed here.  AgentCore calls onThinking() before
 * each LLM call; onToolCall() and clearPendingThinking() erase it before
 * printing the next line so it never coexists with tool or response output.
 */
export class CliProgressReporter implements ProgressReporter {
  private pendingThinking = false;

  constructor(
    private readonly out: NodeJS.WritableStream = process.stdout,
    private readonly verbose = false,
    private readonly quiet = false,
  ) {}

  private get active(): boolean {
    if (this.quiet) return false;
    if (this.verbose) return true;
    return (this.out as NodeJS.WriteStream).isTTY === true;
  }

  private write(text: string): void {
    if (this.active) this.out.write(text);
  }

  private eraseThinking(): void {
    if (this.pendingThinking) {
      this.out.write(ERASE_LINE);
      this.pendingThinking = false;
    }
  }

  /**
   * Called by CliChannel.send() (via a beforeSend hook) so the Thinking line
   * is erased before the final response is written.
   */
  clearPendingThinking(): void {
    if (this.active) this.eraseThinking();
  }

  onSessionStart(sessionId: string, resumed: boolean): void {
    const short = sessionId.slice(0, 8);
    this.write(`◆ Session ${short} ${resumed ? 'resumed' : 'started'}\n`);
  }

  onThinking(): void {
    if (!this.active) return;
    this.out.write('⟳ Thinking…\n');
    this.pendingThinking = true;
  }

  onLlmCall(info: LlmCallInfo): void {
    if (!this.active) return;
    // Replace the plain "Thinking…" line with context stats.
    this.eraseThinking();
    this.out.write(
      `⟳ Thinking… [${info.messageCount} msgs · inj: ${fmt(info.injectedTokens)} tokens]\n`,
    );
    this.pendingThinking = true;
  }

  onLlmResponse(info: LlmResponseInfo): void {
    if (!this.active) return;
    const pct =
      info.windowCapacity > 0 ? ((info.inputTokens / info.windowCapacity) * 100).toFixed(1) : '?';
    const capacityK = info.windowCapacity > 0 ? `${Math.round(info.windowCapacity / 1000)}k` : '?';
    // Replace the thinking/call line with actual token usage — will be erased
    // by the next onToolCall() or clearPendingThinking() before response text.
    this.eraseThinking();
    this.out.write(
      `⟳ [in: ${fmt(info.inputTokens)} / ${capacityK} · ${pct}% · out: ${fmt(info.outputTokens)} · ${info.stopReason}]\n`,
    );
    this.pendingThinking = true;
  }

  onToolCall(name: string, input: unknown): void {
    if (!this.active) return;
    this.eraseThinking();
    const summary = summariseInput(name, input);
    this.out.write(`⚙  ${name}\n   ${summary}\n\n`);
  }

  onToolResult(_name: string, success: boolean, summary: string): void {
    if (!this.active) return;
    const icon = success ? '✓' : '✗';
    const label = success ? 'completed' : 'error';
    this.out.write(`   ${icon} ${label}  ${summary}\n\n`);
  }

  onTaskStatusChange(_taskId: string, title: string, status: string): void {
    this.write(`◆ Task "${title}" → ${status}\n`);
  }

  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void {
    if (source === 'task' && taskId !== undefined) {
      this.write(`  ↳ Loaded ${count} messages from task "${taskId}"\n`);
    } else {
      this.write(`  ↳ Loaded ${count} messages from previous chat session\n`);
    }
  }

  onMemoryCompaction(evictedCount: number, summary: string, tags: string[]): void {
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    const truncated = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
    this.write(`⟳ Compacted ${evictedCount} msgs → "${truncated}"${tagStr}\n`);
  }

  onRetry(attempt: number, maxAttempts: number, reason: string): void {
    this.write(`⚠  API error, retrying (${attempt}/${maxAttempts}): ${reason}\n`);
  }
}
