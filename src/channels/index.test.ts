import { describe, it, expect } from 'vitest';
import { CliChannel } from './index';
import type { Channel, UserTurn } from './index';

describe('Channel interface', () => {
  it('mock implementation satisfies the Channel interface', async () => {
    const turns: UserTurn[] = [
      { content: 'hello' },
      { content: 'world', metadata: { userId: '123', channelId: 'abc' } },
    ];

    const mockChannel: Channel = {
      async *receive() {
        for (const turn of turns) {
          yield turn;
        }
      },
      async send(_response: string) {
        // no-op
      },
    };

    const received: UserTurn[] = [];
    for await (const turn of mockChannel.receive()) {
      received.push(turn);
    }

    expect(received).toEqual(turns);
    await expect(mockChannel.send('response')).resolves.toBeUndefined();
  });

  it('UserTurn requires content and has optional metadata', () => {
    const minimal: UserTurn = { content: 'hello' };
    expect(minimal.content).toBe('hello');
    expect(minimal.metadata).toBeUndefined();

    const withMeta: UserTurn = { content: 'hi', metadata: { userId: '1' } };
    expect(withMeta.metadata?.['userId']).toBe('1');
  });

  it('Channel receive returns an AsyncIterable', async () => {
    const mockChannel: Channel = {
      async *receive() {
        yield { content: 'one' };
        yield { content: 'two' };
      },
      async send(_response: string) {},
    };

    const results: string[] = [];
    for await (const turn of mockChannel.receive()) {
      results.push(turn.content);
    }
    expect(results).toEqual(['one', 'two']);
  });

  it('exports CliChannel', () => {
    expect(CliChannel).toBeDefined();
  });

  it('Channel receive completes when channel closes', async () => {
    const mockChannel: Channel = {
      async *receive() {
        // yields nothing — channel closed immediately
      },
      async send(_response: string) {},
    };

    const results: UserTurn[] = [];
    for await (const turn of mockChannel.receive()) {
      results.push(turn);
    }
    expect(results).toHaveLength(0);
  });
});
