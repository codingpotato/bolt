import { describe, it, expect } from 'vitest';
import { CliChannel } from './index';
import type { Channel, UserTurn } from './index';

describe('channels/index re-exports', () => {
  it('exports CliChannel as a constructor', () => {
    expect(typeof CliChannel).toBe('function');
  });

  it('exported types satisfy structural typing', () => {
    // Compile-time check: a value typed as Channel and UserTurn can be constructed
    const turn: UserTurn = { content: 'hello' };
    const mockChannel: Channel = {
      async *receive() { yield turn; },
      async send(_r: string) {},
    };
    expect(mockChannel).toBeDefined();
    expect(turn.content).toBe('hello');
  });
});
