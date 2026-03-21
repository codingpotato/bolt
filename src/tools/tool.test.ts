import { describe, it, expect } from 'vitest';
import { ToolError } from './tool';

describe('ToolError', () => {
  it('has name ToolError', () => {
    const err = new ToolError('something went wrong');
    expect(err.name).toBe('ToolError');
  });

  it('stores message', () => {
    const err = new ToolError('bad input');
    expect(err.message).toBe('bad input');
  });

  it('defaults retryable to false', () => {
    const err = new ToolError('oops');
    expect(err.retryable).toBe(false);
  });

  it('stores retryable=true when passed', () => {
    const err = new ToolError('network error', true);
    expect(err.retryable).toBe(true);
  });

  it('is an instance of Error', () => {
    expect(new ToolError('x')).toBeInstanceOf(Error);
  });
});
