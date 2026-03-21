import { createInterface } from 'node:readline';
import type { Channel, UserTurn } from './index';

/**
 * Channel implementation for CLI interaction.
 * Reads user input from stdin line by line; writes responses to stdout.
 * EOF on stdin causes receive() to complete (clean shutdown).
 */
export class CliChannel implements Channel {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {}

  async *receive(): AsyncIterable<UserTurn> {
    const rl = createInterface({ input: this.input, terminal: false });
    for await (const line of rl) {
      yield { content: line };
    }
  }

  async send(response: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.output.write(response + '\n', (err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
