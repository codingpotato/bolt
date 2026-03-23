import { describe, it, expect } from 'vitest';
import { CaptureChannel } from './subagent';

describe('CaptureChannel', () => {
  it('yields the prompt as the first and only turn', async () => {
    const ch = new CaptureChannel('hello world');
    const turns: string[] = [];
    for await (const turn of ch.receive()) {
      turns.push(turn.content);
    }
    expect(turns).toEqual(['hello world']);
  });

  it('captures the sent response', async () => {
    const ch = new CaptureChannel('prompt');
    await ch.send('agent response');
    expect(ch.getOutput()).toBe('agent response');
  });

  it('returns empty string before any response is sent', () => {
    const ch = new CaptureChannel('prompt');
    expect(ch.getOutput()).toBe('');
  });
});
