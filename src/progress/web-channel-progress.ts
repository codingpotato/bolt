import type { LlmCallInfo, LlmResponseInfo, ProgressReporter } from './progress';
import { fmt, summariseInput } from './cli-progress';

/**
 * ProgressReporter for the WebChannel (daemon mode).
 *
 * Sends progress events as `progress`-typed messages to all connected clients.
 * Uses the same text format as CliProgressReporter but without ANSI codes.
 * Errors from sendProgress are swallowed so a disconnected client never
 * blocks the agent loop.
 */
export class WebChannelProgressReporter implements ProgressReporter {
  constructor(private readonly sendProgress: (text: string) => void) {}

  private emit(text: string): void {
    try {
      this.sendProgress(text);
    } catch {
      // Never block the agent loop on a failed broadcast.
    }
  }

  onSessionStart(sessionId: string, resumed: boolean): void {
    const short = sessionId.slice(0, 8);
    this.emit(`◆ Session ${short} ${resumed ? 'resumed' : 'started'}`);
  }

  onThinking(): void {
    // No-op: onLlmCall fires immediately after with richer context info,
    // so emitting a bare "Thinking…" here would create duplicate messages
    // for WebSocket/SSE clients that have no way to erase a prior line.
  }

  onLlmCall(info: LlmCallInfo): void {
    this.emit(`⟳ Thinking… [${info.messageCount} msgs · inj: ${fmt(info.injectedTokens)} tokens]`);
  }

  onLlmResponse(info: LlmResponseInfo): void {
    const pct =
      info.windowCapacity > 0 ? ((info.inputTokens / info.windowCapacity) * 100).toFixed(1) : '?';
    const capacityK = info.windowCapacity > 0 ? `${Math.round(info.windowCapacity / 1000)}k` : '?';
    this.emit(
      `⟳ [in: ${fmt(info.inputTokens)} / ${capacityK} · ${pct}% · out: ${fmt(info.outputTokens)} · ${info.stopReason}]`,
    );
  }

  onToolCall(name: string, input: unknown): void {
    const summary = summariseInput(name, input);
    this.emit(`⚙ ${name}\n   ${summary}`);
  }

  onToolResult(_name: string, success: boolean, summary: string): void {
    const icon = success ? '✓' : '✗';
    const label = success ? 'completed' : 'error';
    this.emit(`   ${icon} ${label}  ${summary}`);
  }

  onTaskStatusChange(_taskId: string, title: string, status: string): void {
    this.emit(`◆ Task "${title}" → ${status}`);
  }

  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void {
    if (source === 'task' && taskId !== undefined) {
      this.emit(`  ↳ Loaded ${count} messages from task "${taskId}"`);
    } else {
      this.emit(`  ↳ Loaded ${count} messages from previous chat session`);
    }
  }

  onMemoryCompaction(evictedCount: number, summary: string, tags: string[]): void {
    const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    const truncated = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
    this.emit(`⟳ Compacted ${evictedCount} msgs → "${truncated}"${tagStr}`);
  }

  onRetry(attempt: number, maxAttempts: number, reason: string): void {
    this.emit(`⚠ API error, retrying (${attempt}/${maxAttempts}): ${reason}`);
  }
}
