/**
 * DejavuScraper in TypeScript: learn extraction rules from example values, then
 * re-apply them to any number of similar pages with zero LLM calls.
 *
 * Port of https://github.com/Yukendiran2002/dejavu_scraper (AutoScraper-style
 * stack rules). Rule files use the same JSON layout as the Python library
 * (`{"stack_list": [...]}`), so models can be moved between the two:
 *   Python:  DejavuScraper().load("products.json")
 *   MCP:     run_extractor { name: "products" }
 *
 * Additions over the Python rules:
 *   - `<tbody>` is treated as transparent, so rules learned on a live browser DOM
 *     also match raw HTML (and vice versa).
 *   - Each rule stores a small fingerprint (`fp`) of the example element; when a
 *     rule stops matching after a site redesign, similar elements are found by
 *     similarity scoring instead ("self-healing" extraction).
 *   - Results can be zipped into records (one object per repeated item).
 */

import { createHash } from "node:crypto";

export interface AttrSpec {
  class: string[] | string;
  style: string;
}
export type StackEntry = [string, AttrSpec, number] | [string, AttrSpec];

/** Content + structure summary of what a rule matched, used to re-find data after redesigns. */
export interface Fingerprint {
  tag: string;
  cls: string[];
  ptag: string;
  pcls: string[];
  /** Text shapes of sample values ("$999.00" → "$9.9", "iPhone 15" → "aAa 9"). */
  shapes: string[];
  /** Average / max length of sample values. */
  len: number;
  max: number;
}

export interface Rule {
  content: StackEntry[];
  wanted_attr: string | null;
  is_full_url: boolean;
  is_non_rec_text: boolean;
  url: string;
  hash: string;
  stack_id: string;
  alias: string;
  fp?: Fingerprint;
}

export interface ExtractorModel {
  stack_list: Rule[];
  meta?: Record<string, any>;
  [k: string]: any;
}

interface Hit {
  el: any;
  value: string;
}

// ─── DOM helpers ─────────────────────────────────────────────

const tagOf = (el: any): string => (el.nodeType === 9 ? "[document]" : (el.localName || el.tagName || "").toLowerCase());

function norm(s: string): string {
  return (s || "").normalize("NFKD").replace(/\s+/g, " ").trim();
}

function textOf(el: any): string {
  return norm(el.textContent || "");
}

function nonRecText(el: any): string {
  let s = "";
  const kids = el.childNodes || [];
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 3) s += kids[i].nodeValue;
  return norm(s);
}

function classes(el: any): string[] {
  const c = el.getAttribute ? el.getAttribute("class") : null;
  return c ? c.split(/\s+/).filter(Boolean) : [];
}

/** Element children, with <tbody>/<thead>/<tfoot> made transparent. */
function kids(el: any): any[] {
  const out: any[] = [];
  const cs = el.children || [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const t = tagOf(c);
    if ((t === "tbody" || t === "thead" || t === "tfoot") && tagOf(el) === "table") out.push(...kids(c));
    else out.push(c);
  }
  return out;
}

function parentOf(el: any): any {
  let p = el.parentNode;
  if (p && p.nodeType === 1 && ["tbody", "thead", "tfoot"].includes(tagOf(p)) && p.parentNode && tagOf(p.parentNode) === "table") {
    p = p.parentNode;
  }
  return p && (p.nodeType === 1 || p.nodeType === 9) ? p : null;
}

function validAttrs(el: any): AttrSpec {
  if (el.nodeType === 9) return { class: "", style: "" };
  const cls = classes(el);
  const style = (el.getAttribute("style") || "").trim();
  return { class: cls.length ? cls : "", style };
}

/** BeautifulSoup `findAll(name, attrs)` semantics: class lists match on any overlap, "" means absent. */
function attrsMatch(el: any, spec: AttrSpec): boolean {
  const cls = classes(el);
  const want = spec.class;
  if (!want || (Array.isArray(want) && !want.length)) {
    if (cls.length) return false;
  } else {
    const w = Array.isArray(want) ? want : String(want).split(/\s+/);
    if (!w.some((c) => cls.includes(c))) return false;
  }
  const style = (el.getAttribute("style") || "").trim();
  return (spec.style || "") === style;
}

function resolve(u: string, base: string): string {
  try {
    return new URL(u, base).href;
  } catch {
    return u;
  }
}

// ─── Text matching ───────────────────────────────────────────

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Dice coefficient on character bigrams — a fast stand-in for difflib's ratio. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

type Matcher = (s: string) => boolean;

function makeMatcher(wanted: string, fuzz: number): Matcher {
  const re = wanted.match(/^\/(.+)\/([imsu]*)$/);
  if (re) {
    const rx = new RegExp(`^(?:${re[1]})$`, re[2]);
    return (s) => rx.test(s);
  }
  const w = norm(wanted);
  if (fuzz >= 1) return (s) => s === w;
  return (s) => !!s && similarity(w, s) >= fuzz;
}

// ─── Learning ────────────────────────────────────────────────

/** Mirror of DejavuScraper._child_has_text: which part of `el` holds the wanted value. */
function childHasText(
  el: any,
  match: Matcher,
  url: string,
  text: (el: any) => string
): { attr: string | null; fullUrl: boolean; nonRec: boolean } | null {
  const t = text(el);
  if (match(t)) {
    const p = el.parentNode;
    if (p && p.nodeType === 1 && text(p) === t && p.parentNode) return null;
    return { attr: null, fullUrl: false, nonRec: false };
  }
  if (match(nonRecText(el))) return { attr: null, fullUrl: false, nonRec: true };
  const attrs = el.attributes || [];
  for (let i = 0; i < attrs.length; i++) {
    const name = attrs[i].name;
    if (name === "class") continue; // bs4 exposes class as a list; never matched as text
    const value = (attrs[i].value || "").trim();
    if (match(value)) return { attr: name, fullUrl: false, nonRec: false };
    if ((name === "href" || name === "src") && url && match(resolve(value, url))) return { attr: name, fullUrl: true, nonRec: false };
  }
  return null;
}

export function textShape(s: string): string {
  return s
    .slice(0, 40)
    .replace(/\p{Lu}+/gu, "A")
    .replace(/\p{Ll}+/gu, "a")
    .replace(/\d+/g, "9")
    .replace(/\s+/g, " ");
}

function fingerprint(el: any, samples: string[]): Fingerprint {
  const p = parentOf(el);
  const vals = samples.length ? samples.slice(0, 12) : [""];
  return {
    tag: tagOf(el),
    cls: classes(el),
    ptag: p ? tagOf(p) : "",
    pcls: p && p.nodeType === 1 ? classes(p) : [],
    shapes: Array.from(new Set(vals.map(textShape))),
    len: Math.round(vals.reduce((a, v) => a + v.length, 0) / vals.length),
    max: Math.max(...vals.map((v) => v.length)),
  };
}

function buildStack(el: any, url: string, how: { attr: string | null; fullUrl: boolean; nonRec: boolean }): Rule {
  const content: StackEntry[] = [[tagOf(el), validAttrs(el)]];
  let cur = el;
  for (;;) {
    const gp = parentOf(cur);
    if (!gp) break;
    const spec = validAttrs(cur);
    const siblings = kids(gp).filter((c) => tagOf(c) === tagOf(cur) && attrsMatch(c, spec));
    const idx = Math.max(0, siblings.indexOf(cur));
    content.unshift([tagOf(gp), validAttrs(gp), idx]);
    if (gp.nodeType === 9) break;
    cur = gp;
  }
  const base = {
    content,
    wanted_attr: how.attr,
    is_full_url: how.fullUrl,
    is_non_rec_text: how.nonRec,
    url: how.fullUrl ? url : "",
  };
  const hash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, hash, stack_id: "rule_" + hash.slice(0, 8), alias: "" };
}

function fetchValue(el: any, rule: Rule, url: string): string | null {
  if (rule.wanted_attr == null) return rule.is_non_rec_text ? nonRecText(el) : textOf(el);
  const v = el.getAttribute ? el.getAttribute(rule.wanted_attr) : null;
  if (v == null) return null;
  return rule.is_full_url ? resolve(v, url || rule.url) : v;
}

export interface LearnResult {
  rules: Rule[];
  unmatched: string[];
}

/**
 * Learn rules for the wanted values. `wanted` maps alias → example values
 * (use alias "" for a plain list). Values of the form /regex/ are matched as regex.
 */
export function learn(doc: any, url: string, wanted: Record<string, string[]>, fuzz = 1): LearnResult {
  const all = Array.from(doc.querySelectorAll("*")).reverse() as any[];
  const rules: Rule[] = [];
  const seen = new Set<string>();
  const unmatched: string[] = [];
  const cache = new Map<any, string>();
  const text = (el: any) => {
    let t = cache.get(el);
    if (t === undefined) cache.set(el, (t = textOf(el)));
    return t;
  };
  for (const [alias, values] of Object.entries(wanted)) {
    for (const w of values) {
      const match = makeMatcher(w, fuzz);
      let found = false;
      for (const el of all) {
        const how = childHasText(el, match, url, text);
        if (!how) continue;
        found = true;
        const rule = buildStack(el, url, how);
        rule.alias = alias;
        if (seen.has(rule.hash + alias)) continue;
        seen.add(rule.hash + alias);
        const samples = applySimilar(doc, rule, url).map((h) => h.value);
        rule.fp = fingerprint(el, samples.length ? samples : [fetchValue(el, rule, url) || ""]);
        rules.push(rule);
      }
      if (!found) unmatched.push(alias ? `${alias}: ${w}` : w);
    }
  }
  return { rules, unmatched };
}

// ─── Applying ────────────────────────────────────────────────

function applySimilar(doc: any, rule: Rule, url: string): Hit[] {
  const content = rule.content.filter((e) => !["tbody", "thead", "tfoot"].includes(e[0]));
  let parents: any[] = [doc];
  for (let i = 0; i < content.length; i++) {
    const [tag, spec] = content[i];
    if (tag === "[document]") continue;
    const next: any[] = [];
    for (const p of parents) {
      let found = kids(p).filter((c) => tagOf(c) === tag && attrsMatch(c, spec));
      if (!found.length) continue;
      if (i === content.length - 1 && i > 0) {
        const idx = Math.min(found.length - 1, (content[i - 1] as any)[2] ?? 0);
        found = [found[idx]];
      }
      next.push(...found);
    }
    parents = next;
    if (!parents.length) break;
  }
  const hits: Hit[] = [];
  for (const el of parents) {
    const v = fetchValue(el, rule, url);
    if (v) hits.push({ el, value: v });
  }
  return hits;
}

function applyExact(doc: any, rule: Rule, url: string): Hit[] {
  const content = rule.content.filter((e) => !["tbody", "thead", "tfoot"].includes(e[0]));
  let p: any = doc;
  for (let i = 0; i < content.length - 1; i++) {
    const idx = (content[i] as any)[2] ?? 0;
    const [tag, spec] = content[i + 1];
    const found = kids(p).filter((c) => tagOf(c) === tag && attrsMatch(c, spec));
    if (!found.length) return [];
    p = found[Math.min(found.length - 1, idx)];
  }
  const v = p && p.nodeType === 1 ? fetchValue(p, rule, url) : null;
  return v ? [{ el: p, value: v }] : [];
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  let inter = 0;
  for (const x of b) if (A.has(x)) inter++;
  return inter / (A.size + b.length - inter || 1);
}

const isHeading = (t: string) => /^h[1-6]$/.test(t);

/**
 * Re-find an alias after its rules stopped matching (e.g. a site redesign).
 * Every element is scored on how much its value *looks like* the learned samples
 * (text shape, length) plus weak structural hints; candidates are clustered by
 * tag/class/parent signature and the best repeating cluster wins.
 */
function healAlias(doc: any, rules: Rule[], url: string): Hit[] {
  const fps = rules.map((r) => r.fp).filter(Boolean) as Fingerprint[];
  if (!fps.length) return [];
  const rule = rules[0];
  const shapes = Array.from(new Set(fps.flatMap((f) => f.shapes || [])));
  const maxLen = Math.max(...fps.map((f) => f.max || f.len || 0)) * 3 + 20;
  const avgLen = fps.reduce((a, f) => a + (f.len || 0), 0) / fps.length || 1;
  const groups = new Map<string, { hits: Hit[]; total: number }>();
  const els = doc.querySelectorAll("*");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const tag = tagOf(el);
    if (["script", "style", "noscript", "template", "head", "html", "body"].includes(tag)) continue;
    const v = fetchValue(el, rule, url);
    if (!v || v.length > maxLen) continue;
    const shape = textShape(v);
    let shapeSim = 0;
    for (const sh of shapes) shapeSim = Math.max(shapeSim, sh === shape ? 1 : similarity(sh, shape));
    if (shapeSim < 0.5) continue;
    const lenSim = Math.min(v.length, avgLen) / Math.max(v.length, avgLen);
    const p = parentOf(el);
    let struct = 0;
    for (const f of fps) {
      let st = f.tag === tag ? 1 : isHeading(f.tag) && isHeading(tag) ? 0.6 : 0;
      st = 0.5 * st + 0.3 * jaccard(f.cls, classes(el)) + 0.2 * (p && tagOf(p) === f.ptag ? 1 : 0);
      struct = Math.max(struct, st);
    }
    const score = 0.55 * shapeSim + 0.2 * lenSim + 0.25 * struct;
    const key = `${tag}.${classes(el).join(".")}|${p ? tagOf(p) : ""}`;
    const g = groups.get(key) || { hits: [], total: 0 };
    g.hits.push({ el, value: v });
    g.total += score;
    groups.set(key, g);
  }
  let best: { hits: Hit[]; total: number } | null = null;
  let bestScore = 0;
  for (const g of groups.values()) {
    const mean = g.total / g.hits.length;
    if (mean < 0.6) continue;
    // Repeating groups are what list extraction is about; singletons need a strong match.
    const score = mean * Math.log2(1 + g.hits.length);
    if (score > bestScore && (g.hits.length > 1 || mean > 0.85)) {
      best = g;
      bestScore = score;
    }
  }
  return best ? best.hits.slice(0, 1000) : [];
}

export interface ApplyOptions {
  mode?: "similar" | "exact";
  /** Re-find aliases whose rules all return nothing via fingerprint matching (default true). */
  heal?: boolean;
}

export interface RuleHits {
  rule: Rule;
  hits: Hit[];
  healed: boolean;
}

export function applyRules(doc: any, url: string, rules: Rule[], opts: ApplyOptions = {}): RuleHits[] {
  const out: RuleHits[] = rules.map((rule) => ({
    rule,
    hits: opts.mode === "exact" ? applyExact(doc, rule, url) : applySimilar(doc, rule, url),
    healed: false,
  }));
  if (opts.heal === false) return out;
  const aliases = Array.from(new Set(rules.map((r) => r.alias)));
  for (const alias of aliases) {
    const mine = out.filter((r) => r.rule.alias === alias);
    if (mine.some((r) => r.hits.length)) continue;
    const hits = healAlias(doc, mine.map((r) => r.rule), url);
    if (hits.length) {
      mine[0].hits = hits;
      mine[0].healed = true;
    }
  }
  return out;
}

// ─── Output shaping ──────────────────────────────────────────

function docOrder(a: any, b: any): number {
  if (a === b) return 0;
  const pos = a.compareDocumentPosition(b);
  return pos & 4 ? -1 : pos & 2 ? 1 : 0;
}

/** Values per alias (deduped, document order). */
export function grouped(results: RuleHits[]): Record<string, string[]> {
  const byAlias = new Map<string, Hit[]>();
  for (const r of results) {
    const list = byAlias.get(r.rule.alias) || [];
    list.push(...r.hits);
    byAlias.set(r.rule.alias, list);
  }
  const out: Record<string, string[]> = {};
  for (const [alias, hits] of byAlias) {
    const uniq = Array.from(new Map(hits.map((h) => [h.el, h])).values()).sort((a, b) => docOrder(a.el, b.el));
    out[alias || "value"] = Array.from(new Set(uniq.map((h) => h.value)));
  }
  return out;
}

/**
 * Zip alias values into records: each hit climbs to the largest ancestor that
 * contains no other hit of the same alias — that ancestor is the item container.
 */
export function records(results: RuleHits[]): Record<string, any>[] {
  // One rule per alias: several rules for the same field usually match the same
  // value in different places (heading text, image alt, a comparison table…),
  // which would split items apart. Prefer the rule with most hits, text over attrs.
  const primary = new Map<string, RuleHits>();
  for (const r of results) {
    if (!r.hits.length) continue;
    const cur = primary.get(r.rule.alias);
    const better =
      !cur ||
      r.hits.length > cur.hits.length ||
      (r.hits.length === cur.hits.length && r.rule.wanted_attr == null && cur.rule.wanted_attr != null);
    if (better) primary.set(r.rule.alias, r);
  }
  const byAlias = new Map<string, Hit[]>();
  for (const r of results) if (!byAlias.has(r.rule.alias)) byAlias.set(r.rule.alias, []);
  for (const [alias, r] of primary) byAlias.set(alias, r.hits);
  const containers = new Map<any, Record<string, any>>();
  for (const [alias, hits] of byAlias) {
    const count = new Map<any, number>();
    for (const h of hits) {
      for (let p = h.el; p; p = p.parentNode) count.set(p, (count.get(p) || 0) + 1);
    }
    for (const h of hits) {
      let c = h.el;
      while (c.parentNode && c.parentNode.nodeType === 1 && (count.get(c.parentNode) || 0) <= 1) c = c.parentNode;
      const rec = containers.get(c) || {};
      const key = alias || "value";
      if (key in rec) rec[key] = [].concat(rec[key], h.value);
      else rec[key] = h.value;
      containers.set(c, rec);
    }
  }
  const aliases = Array.from(byAlias.keys()).map((a) => a || "value");
  return Array.from(containers.entries())
    .sort((a, b) => docOrder(a[0], b[0]))
    .map(([, rec]) => {
      for (const a of aliases) if (!(a in rec)) rec[a] = null;
      return rec;
    });
}

/** Normalise a model loaded from disk (Python files may be a bare list). */
export function normalizeModel(data: any): ExtractorModel {
  if (Array.isArray(data)) return { stack_list: data };
  if (!data || !Array.isArray(data.stack_list)) throw new Error("Invalid extractor file: missing stack_list");
  for (const r of data.stack_list) {
    if (r.alias == null) r.alias = "";
    if (!r.stack_id) r.stack_id = "rule_" + String(r.hash || "").slice(0, 8);
  }
  return data;
}
