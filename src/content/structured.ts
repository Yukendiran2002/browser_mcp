/**
 * Zero-LLM structured extraction (ported from DejavuScraper's smart extractors).
 *
 * Works on any DOM-like document (live browser DOM serialized to linkedom, or raw
 * HTML fetched over HTTP), so structured data costs no model tokens to find.
 */

export type StructuredKind =
  | "metadata"
  | "jsonld"
  | "microdata"
  | "tables"
  | "lists"
  | "pagination"
  | "contacts"
  | "prices"
  | "feeds";

export const ALL_KINDS: StructuredKind[] = [
  "metadata", "jsonld", "microdata", "tables", "lists", "pagination", "contacts", "prices", "feeds",
];

const PRICE_RE =
  /(?:[$€£¥₹₩₽]|US\$|USD|EUR|GBP|INR|JPY|CAD|AUD|Rs\.?)\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?\s?(?:[€£¥₹]|USD|EUR|GBP|INR|JPY)(?![\w$€£¥₹])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{3,4})?/g;

export function tagOf(el: any): string {
  return (el?.localName || el?.tagName || "").toLowerCase();
}

export function textOf(el: any): string {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

/** Text with a space between element boundaries ("Pixel 8" + "$699" → "Pixel 8 $699"). */
export function spacedText(el: any): string {
  const parts: string[] = [];
  const walk = (n: any) => {
    const kids = n.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) parts.push(c.nodeValue || "");
      else if (c.nodeType === 1 && !["script", "style", "noscript", "template"].includes(tagOf(c))) {
        parts.push(" ");
        walk(c);
        parts.push(" ");
      }
    }
  };
  walk(el);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function resolve(u: string | null | undefined, base: string): string {
  if (!u) return "";
  try {
    return new URL(u.trim(), base).href;
  } catch {
    return u.trim();
  }
}

/** Short, reasonably stable CSS selector for an element (used for hints to the agent). */
export function cssPath(el: any): string {
  const parts: string[] = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    const tag = tagOf(cur);
    if (tag === "html" || tag === "body") break;
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
      parts.unshift(`${tag}#${cur.id}`);
      break;
    }
    const cls = (cur.getAttribute("class") || "")
      .split(/\s+/)
      .filter((c: string) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 40)
      .slice(0, 2);
    parts.unshift(tag + cls.map((c: string) => "." + c).join(""));
    cur = cur.parentNode;
  }
  return parts.join(" > ");
}

// ─── Metadata ────────────────────────────────────────────────

export function extractMetadata(doc: any, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const title = doc.querySelector("title");
  if (title) out.title = textOf(title);
  const html = doc.documentElement;
  if (html?.getAttribute?.("lang")) out.lang = html.getAttribute("lang");
  const metas = doc.querySelectorAll("meta");
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    const key = m.getAttribute("property") || m.getAttribute("name") || m.getAttribute("itemprop");
    const val = m.getAttribute("content");
    if (!key || !val) continue;
    const k = key.toLowerCase();
    if (
      /^(description|keywords|author|robots|og:|twitter:|article:|product:|citation_|dc\.)/.test(k) &&
      !(k in out)
    ) {
      out[k] = val.trim().slice(0, 500);
    }
  }
  const canonical = doc.querySelector('link[rel="canonical"]');
  if (canonical) out.canonical = resolve(canonical.getAttribute("href"), base);
  return out;
}

// ─── JSON-LD ─────────────────────────────────────────────────

export function extractJsonLd(doc: any): any[] {
  const out: any[] = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    const raw = (scripts[i].textContent || "").trim();
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && Array.isArray(item["@graph"])) out.push(...item["@graph"]);
        else out.push(item);
      }
    } catch {
      // Some sites ship invalid JSON-LD (trailing commas, comments); skip it.
    }
  }
  return out;
}

// ─── Microdata ───────────────────────────────────────────────

export function extractMicrodata(doc: any, base: string): any[] {
  const out: any[] = [];
  const roots = doc.querySelectorAll("[itemscope]:not([itemprop])");
  const parseItem = (el: any, depth: number): any => {
    const item: any = {};
    const type = el.getAttribute("itemtype");
    if (type) item["@type"] = type.split("/").pop();
    const props = el.querySelectorAll("[itemprop]");
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      // Only direct properties (skip props owned by a nested itemscope).
      let owner = p.parentNode;
      while (owner && owner !== el && !(owner.hasAttribute && owner.hasAttribute("itemscope"))) owner = owner.parentNode;
      if (owner !== el) continue;
      const name = p.getAttribute("itemprop");
      let val: any;
      if (p.hasAttribute("itemscope")) val = depth < 3 ? parseItem(p, depth + 1) : textOf(p);
      else if (p.hasAttribute("content")) val = p.getAttribute("content");
      else if (["a", "link"].includes(tagOf(p))) val = resolve(p.getAttribute("href"), base);
      else if (["img", "source"].includes(tagOf(p))) val = resolve(p.getAttribute("src"), base);
      else if (tagOf(p) === "meta") val = p.getAttribute("content");
      else if (tagOf(p) === "time") val = p.getAttribute("datetime") || textOf(p);
      else val = textOf(p).slice(0, 300);
      if (name in item) item[name] = [].concat(item[name], val);
      else item[name] = val;
    }
    return item;
  };
  for (let i = 0; i < roots.length && out.length < 50; i++) out.push(parseItem(roots[i], 0));
  return out;
}

// ─── Tables ──────────────────────────────────────────────────

export interface TableData {
  selector: string;
  caption?: string;
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
}

export function extractTables(doc: any, maxRows = 50): TableData[] {
  const out: TableData[] = [];
  const tables = doc.querySelectorAll("table");
  for (let t = 0; t < tables.length && out.length < 20; t++) {
    const table = tables[t];
    if (table.querySelector("table")) continue; // layout wrapper
    const trs = Array.from(table.querySelectorAll("tr")) as any[];
    if (trs.length < 2) continue;
    const cellsOf = (tr: any) =>
      (Array.from(tr.children) as any[]).filter((c) => ["td", "th"].includes(tagOf(c))).map((c) => textOf(c));
    let headers: string[] = [];
    let start = 0;
    const thead = table.querySelector("thead tr");
    if (thead) {
      headers = cellsOf(thead);
      start = trs.indexOf(thead) + 1;
    } else if (trs[0].querySelector("th")) {
      headers = cellsOf(trs[0]);
      start = 1;
    }
    const body = trs.slice(start).map(cellsOf).filter((r) => r.length);
    if (!body.length) continue;
    const width = Math.max(...body.map((r) => r.length));
    if (width < 2) continue;
    if (!headers.length) headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    headers = headers.map((h, i) => h || `col${i + 1}`);
    const rows = body.slice(0, maxRows).map((r) => {
      const o: Record<string, string> = {};
      r.forEach((v, i) => (o[headers[i] || `col${i + 1}`] = v));
      return o;
    });
    const caption = table.querySelector("caption");
    out.push({ selector: cssPath(table), caption: caption ? textOf(caption) : undefined, headers, rows, totalRows: body.length });
  }
  return out;
}

// ─── Repeated items (lists / cards / search results) ─────────

export interface ListGroup {
  selector: string;
  count: number;
  items: Record<string, any>[];
}

/** Group key for sibling items: tag + first stable class (ignores state classes like "featured"). */
function signature(el: any): string {
  const cls = (el.getAttribute("class") || "")
    .split(/\s+/)
    .find((c: string) => c && !/\d{2,}|active|selected|first|last|odd|even|hover/.test(c));
  return tagOf(el) + (cls ? "." + cls : "");
}

function insideChrome(el: any): boolean {
  let p = el;
  while (p && p.nodeType === 1) {
    const tag = tagOf(p);
    if (tag === "nav" || tag === "footer" || tag === "header") return true;
    const role = p.getAttribute("role");
    if (role === "navigation" || role === "menu" || role === "menubar") return true;
    p = p.parentNode;
  }
  return false;
}

function itemFields(el: any, base: string): Record<string, any> {
  const f: Record<string, any> = {};
  const heading = el.querySelector("h1,h2,h3,h4,h5,h6,[class*=title],[class*=name]");
  const links = Array.from(el.querySelectorAll("a[href]")) as any[];
  const titleLink = links.find((a) => textOf(a).length > 3);
  const title = heading ? textOf(heading) : titleLink ? textOf(titleLink) : "";
  if (title) f.title = title.slice(0, 200);
  const primary = (heading && (heading.closest ? heading.closest("a[href]") || heading.querySelector("a[href]") : null)) || titleLink || links[0] || (tagOf(el) === "a" ? el : null);
  if (primary) f.url = resolve(primary.getAttribute("href"), base);
  const img = el.querySelector("img");
  if (img) {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
    if (src && !src.startsWith("data:")) f.image = resolve(src, base);
    if (img.getAttribute("alt")) f.imageAlt = img.getAttribute("alt");
  }
  const text = spacedText(el);
  const price = text.match(PRICE_RE);
  if (price) f.price = price[0].trim();
  const ratingEl = el.querySelector("[class*=rating],[class*=stars],[aria-label*=star i],[aria-label*=rating i]");
  if (ratingEl) {
    const r = ratingEl.getAttribute("aria-label") || ratingEl.getAttribute("title") || ratingEl.getAttribute("class") || textOf(ratingEl);
    if (r) f.rating = r.slice(0, 60);
  }
  // Named leaf fields: first class name → text, for leaves with short text.
  const extra: Record<string, string> = {};
  const leaves = el.querySelectorAll("[class]");
  for (let i = 0; i < leaves.length && Object.keys(extra).length < 8; i++) {
    const leaf = leaves[i];
    if (leaf.children.length > 1) continue;
    const t = textOf(leaf);
    if (!t || t.length > 120 || t === f.title) continue;
    const key = (leaf.getAttribute("class") || "").split(/\s+/)[0].replace(/[^\w-]/g, "").slice(0, 30);
    if (key && !(key in extra)) extra[key] = t;
  }
  if (Object.keys(extra).length) f.fields = extra;
  f.text = text.slice(0, 240);
  return f;
}

export function extractLists(doc: any, base: string, maxGroups = 3, maxItems = 50): ListGroup[] {
  const candidates: { parent: any; members: any[]; score: number; sig: string }[] = [];
  const parents = doc.querySelectorAll("body *");
  for (let i = 0; i < parents.length; i++) {
    const parent = parents[i];
    const kids = parent.children;
    if (!kids || kids.length < 3) continue;
    const groups = new Map<string, any[]>();
    for (let k = 0; k < kids.length; k++) {
      const sig = signature(kids[k]);
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig)!.push(kids[k]);
    }
    for (const [sig, members] of groups) {
      if (members.length < 3) continue;
      if (/^(script|style|br|hr|option|meta|link|td|th|tr)/.test(sig)) continue;
      const lens = members.map((m) => textOf(m).length);
      const avg = lens.reduce((a, b) => a + b, 0) / members.length;
      if (avg < 15) continue;
      const nonEmpty = lens.filter((l) => l > 0).length / members.length;
      if (nonEmpty < 0.7) continue;
      if (insideChrome(parent)) continue;
      const hasLink = members.filter((m) => tagOf(m) === "a" || m.querySelector("a[href]")).length / members.length;
      const hasImg = members.filter((m) => m.querySelector("img")).length / members.length;
      const depth = members[0].querySelectorAll("*").length;
      // Menus: short link-only text. Prefer richer items (more structure).
      if (avg < 40 && depth < 2) continue;
      const score = members.length * Math.log2(2 + avg) * (1 + hasLink) * (1 + 0.5 * hasImg) * Math.log2(2 + Math.min(depth, 30));
      candidates.push({ parent, members, score, sig });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: typeof candidates = [];
  for (const c of candidates) {
    if (chosen.length >= maxGroups) break;
    // Skip groups nested inside (or containing) an already chosen group.
    if (chosen.some((x) => x.parent.contains(c.parent) || c.parent.contains(x.parent))) continue;
    chosen.push(c);
  }
  return chosen.map((c) => ({
    selector: `${cssPath(c.parent)} > ${c.sig.replace(/^(\w+)/, "$1")}`,
    count: c.members.length,
    items: c.members.slice(0, maxItems).map((m) => itemFields(m, base)),
  }));
}

// ─── Pagination ──────────────────────────────────────────────

export interface Pagination {
  next?: string;
  prev?: string;
  pages?: string[];
}

export function extractPagination(doc: any, base: string): Pagination {
  const out: Pagination = {};
  const relNext = doc.querySelector('link[rel="next"], a[rel~="next"]');
  if (relNext) out.next = resolve(relNext.getAttribute("href"), base);
  const relPrev = doc.querySelector('link[rel="prev"], a[rel~="prev"]');
  if (relPrev) out.prev = resolve(relPrev.getAttribute("href"), base);
  const anchors = doc.querySelectorAll("a[href]");
  const pages: string[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || /^javascript:/i.test(href)) continue;
    const t = textOf(a).toLowerCase();
    const label = ((a.getAttribute("aria-label") || "") + " " + (a.getAttribute("class") || "") + " " + (a.getAttribute("title") || "")).toLowerCase();
    if (!out.next && (/^(next|next page|next ›|next »|›|»|→|>|more results|older posts)$/.test(t) || /\bnext\b/.test(label))) {
      out.next = resolve(href, base);
    } else if (!out.prev && (/^(prev|previous|previous page|‹|«|←|<|newer posts)$/.test(t) || /\bprev(ious)?\b/.test(label))) {
      out.prev = resolve(href, base);
    }
    let p = a.parentNode;
    let inPager = false;
    for (let d = 0; d < 4 && p && p.nodeType === 1; d++, p = p.parentNode) {
      if (/pag(e|ination|er)/i.test((p.getAttribute("class") || "") + " " + (p.id || "") + " " + (p.getAttribute("aria-label") || ""))) {
        inPager = true;
        break;
      }
    }
    if (inPager && /^\d{1,4}$/.test(t)) pages.push(resolve(href, base));
  }
  if (pages.length) out.pages = Array.from(new Set(pages)).slice(0, 50);
  return out;
}

// ─── Contacts / prices / feeds ───────────────────────────────

export function extractContacts(doc: any): { emails: string[]; phones: string[] } {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const links = doc.querySelectorAll('a[href^="mailto:"], a[href^="tel:"]');
  for (let i = 0; i < links.length; i++) {
    const href = links[i].getAttribute("href") || "";
    if (href.startsWith("mailto:")) emails.add(decodeURIComponent(href.slice(7).split("?")[0]).toLowerCase());
    else phones.add(href.slice(4).trim());
  }
  const text = spacedText(doc.body || doc.documentElement);
  for (const m of text.match(EMAIL_RE) || []) if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(m)) emails.add(m.toLowerCase());
  for (const m of text.match(PHONE_RE) || []) {
    const digits = m.replace(/\D/g, "");
    if (digits.length >= 9 && digits.length <= 15 && !/^(19|20)\d{6}$/.test(digits)) phones.add(m.trim());
  }
  return { emails: [...emails].slice(0, 50), phones: [...phones].slice(0, 50) };
}

export function extractPrices(doc: any): string[] {
  const text = spacedText(doc.body || doc.documentElement);
  return Array.from(new Set((text.match(PRICE_RE) || []).map((p) => p.trim()))).slice(0, 100);
}

export function extractFeeds(doc: any, base: string): string[] {
  const out: string[] = [];
  const links = doc.querySelectorAll('link[type="application/rss+xml"], link[type="application/atom+xml"], link[type="application/feed+json"]');
  for (let i = 0; i < links.length; i++) out.push(resolve(links[i].getAttribute("href"), base));
  return out;
}

/** Run the requested extractors and drop empty results to keep output small. */
export function extractStructured(doc: any, base: string, kinds: StructuredKind[] = ALL_KINDS, maxItems = 30): Record<string, any> {
  const out: Record<string, any> = {};
  const want = new Set(kinds);
  const put = (k: string, v: any) => {
    if (v == null) return;
    if (Array.isArray(v) && !v.length) return;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) return;
    out[k] = v;
  };
  if (want.has("metadata")) put("metadata", extractMetadata(doc, base));
  if (want.has("jsonld")) put("jsonld", extractJsonLd(doc));
  if (want.has("microdata")) put("microdata", extractMicrodata(doc, base));
  if (want.has("tables")) put("tables", extractTables(doc, maxItems));
  if (want.has("lists")) put("lists", extractLists(doc, base, 3, maxItems));
  if (want.has("pagination")) put("pagination", extractPagination(doc, base));
  if (want.has("contacts")) {
    const c = extractContacts(doc);
    put("contacts", c.emails.length || c.phones.length ? c : null);
  }
  if (want.has("prices")) put("prices", extractPrices(doc));
  if (want.has("feeds")) put("feeds", extractFeeds(doc, base));
  return out;
}

// ─── Schema extraction (CSS selectors, no LLM) ───────────────

export interface SchemaField {
  name: string;
  /** CSS selector relative to the item; omit to use the item itself. */
  selector?: string;
  /** text (default) | attribute | html | list | nested | exists | number */
  type?: "text" | "attribute" | "html" | "list" | "nested" | "exists" | "number";
  attribute?: string;
  /** Sub-fields for list/nested. */
  fields?: SchemaField[];
  /** Keep only the first capture group (or whole match) of this regex. */
  regex?: string;
}

export interface ExtractionSchema {
  baseSelector: string;
  fields: SchemaField[];
}

function fieldValue(el: any, f: SchemaField, base: string): any {
  const type = f.type || "text";
  if (type === "list") {
    const nodes = f.selector ? Array.from(el.querySelectorAll(f.selector)) : [el];
    return nodes.map((n: any) => (f.fields?.length ? objectFrom(n, f.fields, base) : applyRegex(spacedText(n), f.regex)));
  }
  const node = f.selector ? el.querySelector(f.selector) : el;
  if (type === "exists") return !!node;
  if (!node) return null;
  switch (type) {
    case "nested":
      return objectFrom(node, f.fields || [], base);
    case "html":
      return node.innerHTML;
    case "attribute": {
      const attr = f.attribute || "href";
      const v = node.getAttribute(attr);
      if (v == null) return null;
      return ["href", "src", "action", "data-src"].includes(attr) ? resolve(v, base) : applyRegex(v, f.regex);
    }
    case "number": {
      const t = applyRegex(spacedText(node), f.regex) || "";
      const m = String(t).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    }
    default:
      return applyRegex(spacedText(node), f.regex);
  }
}

function applyRegex(v: string, re?: string): string | null {
  if (!re) return v;
  const m = v.match(new RegExp(re));
  return m ? (m[1] ?? m[0]) : null;
}

function objectFrom(el: any, fields: SchemaField[], base: string): Record<string, any> {
  const o: Record<string, any> = {};
  for (const f of fields) o[f.name] = fieldValue(el, f, base);
  return o;
}

/** Extract one record per `baseSelector` match (Crawl4AI JsonCss-style schema). */
export function extractBySchema(doc: any, base: string, schema: ExtractionSchema, max = 1000): Record<string, any>[] {
  const items = Array.from(doc.querySelectorAll(schema.baseSelector)).slice(0, max);
  return items.map((el: any) => objectFrom(el, schema.fields, base));
}
