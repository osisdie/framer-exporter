import { logger } from '../utils/logger.js';

export interface JsRewriteContext {
  /**
   * Map of CDN host or full URL prefix → root-relative replacement.
   * Order matters: longer prefixes should appear first.
   */
  replacements: Array<{ from: string; to: string }>;
}

/**
 * Rewrite a JS bundle (or any text body) by literal string replacement of known
 * CDN host prefixes. Never AST-parses minified bundles — the goal is byte-safe
 * substitution that maps CDN hosts to local `/assets/<host>` paths.
 *
 * After running, the JS will reference paths like `/assets/framerusercontent.com/...`
 * which `sirv` serves from the same `output/` root. URL fingerprints / query
 * params don't need rewriting because the captured filenames already include
 * a hash of the original query (see assetLocalPath in urlUtils).
 */
export function rewriteJs(body: string, ctx: JsRewriteContext): string {
  if (!ctx.replacements.length) return body;
  let out = body;
  let totalReplacements = 0;
  for (const { from, to } of ctx.replacements) {
    if (!out.includes(from)) continue;
    const before = out.length;
    out = out.split(from).join(to);
    const after = out.length;
    totalReplacements += Math.abs(before - after);
  }
  if (totalReplacements > 0) {
    logger.debug({ deltaBytes: totalReplacements, prefixes: ctx.replacements.length }, 'js-rewrite-applied');
  }
  return out;
}

/**
 * Build the replacement table from the set of asset hosts we observed.
 * Each host gets two replacement entries: one for `https://host` → `/assets/host`,
 * and one for protocol-relative `//host` → `/assets/host`.
 */
export function buildJsReplacements(hosts: Set<string>): JsRewriteContext['replacements'] {
  const sorted = Array.from(hosts).sort((a, b) => b.length - a.length);
  const out: Array<{ from: string; to: string }> = [];
  for (const host of sorted) {
    out.push({ from: `https://${host}`, to: `/assets/${host}` });
    out.push({ from: `http://${host}`, to: `/assets/${host}` });
    out.push({ from: `//${host}`, to: `/assets/${host}` });
  }
  return out;
}
