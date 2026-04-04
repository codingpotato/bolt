import { describe, it, expect } from 'vitest';
import { globToRegex, matchesGlob } from './fs-utils';

describe('globToRegex', () => {
  it('matches all files with **', () => {
    const re = globToRegex('**');
    expect(re.test('anything')).toBe(true);
    expect(re.test('a/b/c.txt')).toBe(true);
    expect(re.test('')).toBe(true);
  });

  it('matches extension recursively with **/*.ts', () => {
    const re = globToRegex('**/*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/app.ts')).toBe(true);
    expect(re.test('src/deep/nested/test.ts')).toBe(true);
    expect(re.test('a.js')).toBe(false);
    expect(re.test('src/a.js')).toBe(false);
  });

  it('matches single-level with *.ts', () => {
    const re = globToRegex('*.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(false);
  });

  it('matches src/**/*.test.ts', () => {
    const re = globToRegex('src/**/*.test.ts');
    expect(re.test('src/foo.test.ts')).toBe(true);
    expect(re.test('src/deep/foo.test.ts')).toBe(true);
    expect(re.test('src/a.test.ts')).toBe(true);
    expect(re.test('test/foo.test.ts')).toBe(false);
    expect(re.test('src/foo.spec.ts')).toBe(false);
  });

  it('matches src/** (directory + all contents)', () => {
    const re = globToRegex('src/**');
    expect(re.test('src')).toBe(true);
    expect(re.test('src/file.ts')).toBe(true);
    expect(re.test('src/a/b.ts')).toBe(true);
    expect(re.test('other/file.ts')).toBe(false);
  });

  it('matches **/foo/**/bar.ts (mid-pattern **)', () => {
    const re = globToRegex('**/foo/**/bar.ts');
    expect(re.test('foo/bar.ts')).toBe(true);
    expect(re.test('src/foo/bar.ts')).toBe(true);
    expect(re.test('src/foo/deep/bar.ts')).toBe(true);
    expect(re.test('foo/x/bar.ts')).toBe(true);
    expect(re.test('bar.ts')).toBe(false);
  });

  it('matches **/* (all files at any depth)', () => {
    const re = globToRegex('**/*');
    expect(re.test('visible.ts')).toBe(true);
    expect(re.test('src/app.ts')).toBe(true);
    expect(re.test('a')).toBe(true);
  });

  it('escapes literal dots', () => {
    const re = globToRegex('*.test.ts');
    expect(re.test('foo.test.ts')).toBe(true);
    expect(re.test('fooXtestYts')).toBe(false);
  });

  it('handles ? as single-char wildcard', () => {
    const re = globToRegex('?.ts');
    expect(re.test('a.ts')).toBe(true);
    expect(re.test('ab.ts')).toBe(false);
  });

  it('handles literal filenames', () => {
    const re = globToRegex('package.json');
    expect(re.test('package.json')).toBe(true);
    expect(re.test('packageXjson')).toBe(false);
    expect(re.test('src/package.json')).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('delegates to globToRegex', () => {
    expect(matchesGlob('src/app.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/app.js', '**/*.ts')).toBe(false);
    expect(matchesGlob('test.ts', '*.ts')).toBe(true);
    expect(matchesGlob('dir/test.ts', '*.ts')).toBe(false);
  });
});
