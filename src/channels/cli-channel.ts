import { createInterface, type Interface } from 'node:readline';
import type { Channel, UserTurn, UserReviewRequest, UserReviewResponse } from './channel';

// ANSI escape helpers
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';


/**
 * Channel implementation for CLI interaction.
 * Reads user input from stdin line by line; writes responses to stdout.
 * EOF on stdin causes receive() to complete (clean shutdown).
 *
 * When attached to a TTY:
 *   - Shows a colored `❯` prompt at the bottom.
 *   - Shows a dim "Thinking…" line while the agent is processing.
 *   - Frames each response with separator lines sized to the terminal width.
 */
export class CliChannel implements Channel {
  private rl: Interface | null = null;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    /** Called just before send() writes the response — used to erase the Thinking line. */
    private readonly beforeSend?: () => void,
  ) {}

  private get isTTY(): boolean {
    return (this.output as NodeJS.WriteStream).isTTY === true;
  }

  private get cols(): number {
    return (this.output as NodeJS.WriteStream).columns || 80;
  }

  private separator(): string {
    const line = '─'.repeat(this.cols);
    return this.isTTY ? `${DIM}${line}${RESET}` : line;
  }

  async *receive(): AsyncIterable<UserTurn> {
    this.rl = createInterface({
      input: this.input,
      output: this.output,
      terminal: this.isTTY,
    });

    this.rl.setPrompt(this.isTTY ? `${CYAN}${BOLD}❯${RESET} ` : '> ');
    this.rl.prompt();

    for await (const line of this.rl) {
      const content = line.trim();
      if (!content) {
        this.rl.prompt();
        continue;
      }

      yield { content };
    }
  }

  /**
   * Prompt the user for a single-line answer and return it.
   * Uses the active readline interface so the answer is consumed before the
   * next user turn, without interfering with the normal input loop.
   * Returns an empty string when no readline interface is active.
   */
  async question(prompt: string): Promise<string> {
    if (!this.rl) return '';
    return new Promise((resolve) => {
      this.rl!.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  /**
   * Display content for user review and collect approve/reject/feedback via readline.
   * Prompts: [approve/reject/feedback]:
   *   - "y", "yes", "approve" → { approved: true }
   *   - "f", "feedback"       → prompts for feedback text → { approved: false, feedback }
   *   - anything else         → { approved: false }
   */
  async requestReview(request: UserReviewRequest): Promise<UserReviewResponse> {
    const sep = '─'.repeat(40);
    this.output.write(`\n${sep}\n[${request.contentType}] ${request.question}\n${sep}\n`);
    this.output.write(`${request.content}\n${sep}\n\n`);

    const answer = (await this.question('[approve/reject/feedback]: ')).trim().toLowerCase();

    if (answer === 'y' || answer === 'yes' || answer === 'approve') {
      return { approved: true };
    }

    if (answer === 'f' || answer === 'feedback') {
      const feedback = (await this.question('Feedback: ')).trim();
      return { approved: false, feedback: feedback || undefined };
    }

    return { approved: false };
  }

  async send(response: string): Promise<void> {
    this.beforeSend?.();

    const sep = this.separator();
    const content = this.isTTY
      ? `\n${sep}\n${response}\n${sep}\n\n`
      : `${response}\n`;

    await new Promise<void>((resolve, reject) => {
      this.output.write(content, (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (this.rl) {
      this.rl.prompt();
    }
  }
}
