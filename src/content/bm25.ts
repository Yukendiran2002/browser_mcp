/**
 * Query-focused markdown filtering.
 *
 * Splits markdown into heading-aware chunks, ranks them with BM25 against a
 * query and keeps the best chunks (in original order) within a char budget.
 * Lets an agent read only the parts of a page relevant to its question.
 */

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with what which who how when where why".split(" ")
);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 ? t.replace(/(ing|ed|es|s)$/, "") : t));
}

/** Split markdown into chunks of roughly `target` chars, never splitting inside a line. */
export function chunkMarkdown(md: string, target = 600): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  let heading = "";
  const push = () => {
    const body = cur.join("\n").trim();
    if (body) chunks.push(body);
    cur = [];
    len = 0;
  };
  for (const line of md.split("\n")) {
    const isHeading = /^#{1,6} /.test(line);
    if (isHeading) {
      push();
      heading = line;
    }
    if (len + line.length > target && len > 0) {
      push();
      // Carry the section heading so each chunk keeps its context.
      if (heading && !isHeading) {
        cur.push(heading);
        len += heading.length;
      }
    }
    cur.push(line);
    len += line.length + 1;
  }
  push();
  return chunks;
}

export function bm25Rank(chunks: string[], query: string): number[] {
  const q = Array.from(new Set(tokenize(query)));
  const docs = chunks.map(tokenize);
  const N = docs.length || 1;
  const avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return score;
  });
}

/** Keep the chunks most relevant to `query`, preserving document order. */
export function filterByQuery(md: string, query: string, maxChars: number): { markdown: string; kept: number; total: number } {
  const chunks = chunkMarkdown(md);
  const scores = bm25Rank(chunks, query);
  const order = scores
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const keep = new Set<number>();
  let used = 0;
  for (const { i } of order) {
    if (used + chunks[i].length > maxChars && keep.size > 0) continue;
    keep.add(i);
    used += chunks[i].length + 5;
    if (used >= maxChars) break;
  }
  const out = chunks.filter((_, i) => keep.has(i));
  return { markdown: out.join("\n\n…\n\n"), kept: out.length, total: chunks.length };
}
