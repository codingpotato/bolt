import { describe, it, expect } from 'vitest';
import { levenshtein } from './file';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length for empty vs non-empty', () => {
    expect(levenshtein('', 'hello')).toBe(5);
    expect(levenshtein('hello', '')).toBe(5);
  });

  it('returns 0 for two empty strings', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  it('returns 1 for single char substitution', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('returns 1 for single char insertion', () => {
    expect(levenshtein('cat', 'cart')).toBe(1);
  });

  it('returns 1 for single char deletion', () => {
    expect(levenshtein('cart', 'cat')).toBe(1);
  });

  it('handles multi-edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('handles completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  it('handles single character strings', () => {
    expect(levenshtein('a', 'a')).toBe(0);
    expect(levenshtein('a', 'b')).toBe(1);
  });

  it('is symmetric', () => {
    expect(levenshtein('hello', 'world')).toBe(levenshtein('world', 'hello'));
  });

  it('handles strings with spaces', () => {
    expect(levenshtein('hello world', 'hello world')).toBe(0);
    expect(levenshtein('hello world', 'hello word')).toBe(1);
  });

  it('handles case sensitivity', () => {
    expect(levenshtein('Hello', 'hello')).toBe(1);
  });
});
