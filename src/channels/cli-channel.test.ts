import { describe, it, expect, vi } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { CliChannel } from './cli-channel';

function makeInput(lines: string[]): Readable {
  return Readable.from(lines.map((l) => l + '\n').join(''));
}

function makeOutput(): { stream: Writable; data: () => string } {
  let captured = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk.toString();
      callback();
    },
  });
  return { stream, data: () => captured };
}

describe('CliChannel', () => {
  describe('receive()', () => {
    it('yields a UserTurn for each line from stdin', async () => {
      const channel = new CliChannel(makeInput(['hello', 'world']));

      const turns = [];
      for await (const turn of channel.receive()) {
        turns.push(turn);
      }

      expect(turns).toEqual([{ content: 'hello' }, { content: 'world' }]);
    });

    it('completes cleanly on EOF (empty stream)', async () => {
      const channel = new CliChannel(Readable.from(''));

      const turns = [];
      for await (const turn of channel.receive()) {
        turns.push(turn);
      }

      expect(turns).toHaveLength(0);
    });

    it('yields UserTurns with no metadata', async () => {
      const channel = new CliChannel(makeInput(['message']));

      const turns = [];
      for await (const turn of channel.receive()) {
        turns.push(turn);
      }

      expect(turns[0]?.metadata).toBeUndefined();
    });

    it('handles single-line input', async () => {
      const channel = new CliChannel(makeInput(['only one line']));

      const turns = [];
      for await (const turn of channel.receive()) {
        turns.push(turn);
      }

      expect(turns).toHaveLength(1);
      expect(turns[0]?.content).toBe('only one line');
    });
  });

  describe('send()', () => {
    it('writes the response followed by a newline to stdout', async () => {
      const { stream, data } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);

      await channel.send('hello agent');

      expect(data()).toBe('hello agent\n');
    });

    it('resolves the promise after writing', async () => {
      const { stream } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);

      await expect(channel.send('test')).resolves.toBeUndefined();
    });

    it('rejects if the stream errors', async () => {
      const errorStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('write failed'));
        },
      });
      // Suppress the stream-level 'error' event that Node emits alongside the callback error
      errorStream.on('error', () => {});
      const channel = new CliChannel(Readable.from(''), errorStream);

      await expect(channel.send('test')).rejects.toThrow('write failed');
    });

    it('calls beforeSend hook before writing the response', async () => {
      const { stream } = makeOutput();
      const beforeSend = vi.fn();
      const channel = new CliChannel(Readable.from(''), stream, beforeSend);

      await channel.send('hello');

      expect(beforeSend).toHaveBeenCalledOnce();
    });
  });

  describe('question()', () => {
    it('returns empty string when receive() has not been called (rl is null)', async () => {
      const channel = new CliChannel(Readable.from(''), makeOutput().stream);
      const answer = await channel.question('Are you sure? ');
      expect(answer).toBe('');
    });

    it('resolves with the answer provided via the readline interface', async () => {
      const channel = new CliChannel(makeInput(['yes']), makeOutput().stream);

      // Calling next() without awaiting runs the async generator synchronously up to
      // its first await (the for-await loop), which creates this.rl before suspending.
      const receiveIterator = channel.receive()[Symbol.asyncIterator]();
      void receiveIterator.next();

      // question() registers a one-time line listener; readline delivers 'yes' async.
      const answer = await channel.question('Confirm? ');

      expect(answer).toBe('yes');
      await receiveIterator.return?.();
    });
  });

  describe('notifyTaskCompletion()', () => {
    it('writes a success line for completed status', async () => {
      const { stream, data } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);

      await channel.notifyTaskCompletion('t-1', 'My Task', 'completed');

      expect(data()).toBe('✓ Task completed: My Task\n');
    });

    it('writes a failure line for failed status', async () => {
      const { stream, data } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);

      await channel.notifyTaskCompletion('t-1', 'My Task', 'failed');

      expect(data()).toBe('✗ Task failed: My Task\n');
    });

    it('appends the error reason when provided', async () => {
      const { stream, data } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);

      await channel.notifyTaskCompletion('t-1', 'My Task', 'failed', undefined, 'network timeout');

      expect(data()).toBe('✗ Task failed: My Task — network timeout\n');
    });

    it('calls beforeSend hook before writing', async () => {
      const { stream } = makeOutput();
      const beforeSend = vi.fn();
      const channel = new CliChannel(Readable.from(''), stream, beforeSend);

      await channel.notifyTaskCompletion('t-1', 'My Task', 'completed');

      expect(beforeSend).toHaveBeenCalledOnce();
    });

    it('rejects if the stream errors', async () => {
      const errorStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('write failed'));
        },
      });
      errorStream.on('error', () => {});
      const channel = new CliChannel(Readable.from(''), errorStream);

      await expect(channel.notifyTaskCompletion('t-1', 'My Task', 'completed')).rejects.toThrow(
        'write failed',
      );
    });
  });

  describe('implements Channel interface', () => {
    it('uses process.stdin and process.stdout by default', () => {
      const channel = new CliChannel();
      // Verify construction succeeds with no args — runtime defaults apply
      expect(channel).toBeInstanceOf(CliChannel);
    });
  });

  describe('requestReview()', () => {
    /** Start receive() so that rl is initialised, then call requestReview(). */
    async function withReceive(
      lines: string[],
      fn: (channel: CliChannel, output: () => string) => Promise<void>,
    ): Promise<void> {
      const { stream, data } = makeOutput();
      const channel = new CliChannel(makeInput(lines), stream);
      const iter = channel.receive()[Symbol.asyncIterator]();
      void iter.next(); // initialise rl without consuming a line
      await fn(channel, data);
      await iter.return?.();
    }

    it('returns approved: true when user enters "approve"', async () => {
      await withReceive(['approve'], async (channel) => {
        const result = await channel.requestReview({
          content: 'hello',
          contentType: 'text',
          question: 'OK?',
        });
        expect(result).toEqual({ approved: true });
      });
    });

    it('returns approved: true when user enters "y"', async () => {
      await withReceive(['y'], async (channel) => {
        const result = await channel.requestReview({
          content: 'hello',
          contentType: 'text',
          question: 'OK?',
        });
        expect(result.approved).toBe(true);
      });
    });

    it('returns approved: false when user enters "reject"', async () => {
      await withReceive(['reject'], async (channel) => {
        const result = await channel.requestReview({
          content: 'hello',
          contentType: 'text',
          question: 'OK?',
        });
        expect(result).toEqual({ approved: false });
      });
    });

    it('returns feedback when user enters "feedback" then feedback text', async () => {
      const { stream } = makeOutput();
      const channel = new CliChannel(Readable.from(''), stream);
      // Stub question() to return controlled answers without depending on readline timing
      vi.spyOn(channel, 'question')
        .mockResolvedValueOnce('feedback')
        .mockResolvedValueOnce('needs more detail');

      const result = await channel.requestReview({
        content: 'hello',
        contentType: 'script',
        question: 'Review?',
      });
      expect(result).toEqual({ approved: false, feedback: 'needs more detail' });
    });

    it('writes content and question to output', async () => {
      await withReceive(['approve'], async (channel, data) => {
        await channel.requestReview({
          content: 'my content',
          contentType: 'storyboard',
          question: 'Looks good?',
        });
        expect(data()).toContain('my content');
        expect(data()).toContain('Looks good?');
        expect(data()).toContain('storyboard');
      });
    });
  });
});
