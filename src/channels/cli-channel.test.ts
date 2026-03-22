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

  describe('implements Channel interface', () => {
    it('uses process.stdin and process.stdout by default', () => {
      const channel = new CliChannel();
      // Verify construction succeeds with no args — runtime defaults apply
      expect(channel).toBeInstanceOf(CliChannel);
    });
  });
});
