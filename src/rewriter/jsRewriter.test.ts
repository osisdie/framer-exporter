import { describe, expect, it } from 'vitest';
import { buildJsReplacements, rewriteJs } from './jsRewriter.js';

describe('buildJsReplacements', () => {
  it('emits 3 entries per host (https, http, protocol-relative)', () => {
    const r = buildJsReplacements(new Set(['cdn.example.com']));
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.from)).toEqual([
      'https://cdn.example.com',
      'http://cdn.example.com',
      '//cdn.example.com',
    ]);
    expect(r.every((x) => x.to === '/assets/cdn.example.com')).toBe(true);
  });

  it('orders longer hostnames first to avoid premature substring matches', () => {
    const r = buildJsReplacements(new Set(['a.example.com', 'longer-cdn.example.com']));
    const first = r[0]!;
    const last = r[r.length - 1]!;
    expect(first.from.length).toBeGreaterThan(last.from.length);
  });
});

describe('rewriteJs', () => {
  it('replaces every occurrence of known prefixes', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const input = `let x = "https://cdn.example.com/a.png"; let y = "https://cdn.example.com/b.png";`;
    const out = rewriteJs(input, { replacements });
    expect(out).not.toContain('https://cdn.example.com');
    expect(out).toContain('/assets/cdn.example.com/a.png');
    expect(out).toContain('/assets/cdn.example.com/b.png');
  });

  it('preserves byte content for unrelated text', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const input = `function noTouch() { return 42; }`;
    expect(rewriteJs(input, { replacements })).toBe(input);
  });

  it('returns input unchanged when replacements is empty', () => {
    const input = `https://cdn.example.com/a`;
    expect(rewriteJs(input, { replacements: [] })).toBe(input);
  });

  it('handles protocol-relative URLs', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const out = rewriteJs(`fetch("//cdn.example.com/x")`, { replacements });
    expect(out).toBe(`fetch("/assets/cdn.example.com/x")`);
  });
});
