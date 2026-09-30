/**
 * HTML → Markdown conversion with main-content detection.
 *
 * `htmlToMarkdown` is deliberately self-contained (no imports, no closures over
 * module scope) so the exact same function can run:
 *   - inside the browser via `page.evaluate(htmlToMarkdown, opts)` (uses the live
 *     DOM and can skip elements hidden by CSS), and
 *   - in Node on a linkedom document for the HTTP fast path (no browser at all).
 */

export interface MarkdownOptions {
  /** Base URL used to resolve relative links. Defaults to document.baseURI. */
  baseUrl?: string;
  /** Keep only the main content (strips nav, footer, sidebars, cookie banners…). */
  mainContent?: boolean;
  /** How links are rendered: inline [t](u), numbered refs [t][1] + footer, or text only. */
  links?: "inline" | "refs" | "none";
  /** Include images as ![alt](src). */
  images?: boolean;
  /** Skip elements hidden via CSS (only meaningful in a real browser). */
  visibleOnly?: boolean;
  /** Optional CSS selector to convert instead of the whole page. */
  selector?: string;
}

export interface MarkdownResult {
  title: string;
  markdown: string;
  links: number;
}

export function htmlToMarkdown(opts: MarkdownOptions, docArg?: any): MarkdownResult {
  const doc: any = docArg || (globalThis as any).document;
  const o = opts || {};
  const linkMode = o.links || "inline";
  const base = o.baseUrl || doc.baseURI || (doc.location && doc.location.href) || "";
  const hasStyle = !!o.visibleOnly && typeof (globalThis as any).getComputedStyle === "function";

  const SKIP = new Set([
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
    "embed", "head", "meta", "link", "title", "base", "button", "select", "option",
    "input", "textarea", "dialog", "map", "audio", "video", "source", "track",
  ]);
  const BLOCK = new Set([
    "p", "div", "section", "article", "main", "header", "footer", "aside", "nav",
    "form", "fieldset", "figure", "figcaption", "address", "details", "summary",
    "center", "body", "html",
  ]);
  const NOISE_TAGS = new Set(["nav", "footer", "aside", "form"]);
  const NOISE_RE =
    /(^|[\s_-])(nav|navbar|menu|footer|sidebar|side-bar|cookie|consent|banner|advert|ads?|promo|share|social|related|breadcrumbs?|popup|modal|newsletter|subscribe|signup|skip|masthead|toolbar|pagination|comments?)([\s_-]|$)/i;

  function resolve(u: string): string {
    if (!u) return "";
    u = u.trim();
    if (/^(javascript|data):/i.test(u)) return "";
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  }

  function isHidden(el: any): boolean {
    if (el.hasAttribute && (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true")) return true;
    if (!hasStyle) return false;
    try {
      const cs = (globalThis as any).getComputedStyle(el);
      return cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse";
    } catch {
      return false;
    }
  }

  function tagOf(el: any): string {
    return (el.localName || el.tagName || "").toLowerCase();
  }

  function isNoise(el: any): boolean {
    const tag = tagOf(el);
    if (NOISE_TAGS.has(tag)) return true;
    const role = el.getAttribute ? el.getAttribute("role") || "" : "";
    if (/^(navigation|banner|contentinfo|complementary|search|dialog|alertdialog)$/.test(role)) return true;
    if (tag === "header" && !el.querySelector("h1")) return true;
    const sig = ((el.getAttribute && el.getAttribute("class")) || "") + " " + (el.id || "");
    return sig.length > 1 && NOISE_RE.test(sig);
  }

  function textLen(el: any): number {
    return (el.textContent || "").replace(/\s+/g, " ").trim().length;
  }

  function linkTextLen(el: any): number {
    let n = 0;
    const as = el.querySelectorAll("a");
    for (let i = 0; i < as.length; i++) n += textLen(as[i]);
    return n;
  }

  /** Pick the element that most likely holds the main content. */
  function findMain(): any {
    const body = doc.body || doc.documentElement;
    const explicit = doc.querySelectorAll("main, [role=main], article");
    const articles: any[] = [];
    for (let i = 0; i < explicit.length; i++) {
      const el = explicit[i];
      if (textLen(el) > 200) articles.push(el);
    }
    // A single <main>/<article> with most of the text wins outright.
    const bodyLen = Math.max(1, textLen(body));
    for (const el of articles) {
      if (tagOf(el) !== "article" && textLen(el) / bodyLen > 0.3) return el;
    }
    if (articles.length === 1 && textLen(articles[0]) / bodyLen > 0.25) return articles[0];

    // Otherwise score block containers by paragraph text with a link-density penalty.
    let best = body;
    let bestScore = 0;
    const cands = body.querySelectorAll("div, section, article, main, td");
    for (let i = 0; i < cands.length; i++) {
      const el = cands[i];
      const len = textLen(el);
      if (len < 250) continue;
      const density = linkTextLen(el) / len;
      if (density > 0.5) continue;
      const paras = el.querySelectorAll("p, pre, li, blockquote, h2, h3").length;
      const score = len * (1 - density) * Math.log2(2 + paras);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    // Avoid collapsing to a tiny sub-block: if best holds < 40% of body text, fall back to body.
    if (best !== body && textLen(best) / bodyLen < 0.4) return body;
    return best;
  }

  const refs: string[] = [];
  const refIndex = new Map<string, number>();
  function linkRef(href: string): number {
    let n = refIndex.get(href);
    if (n === undefined) {
      refs.push(href);
      n = refs.length;
      refIndex.set(href, n);
    }
    return n;
  }

  function inlineText(s: string): string {
    return s.replace(/[\t\n\r ]+/g, " ");
  }

  function escapeCell(s: string): string {
    return s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  }

  let linkCount = 0;

  /** Convert inline content of a node into a single markdown string. */
  function inline(node: any, root: any): string {
    return inlineNodes(node.childNodes || [], root);
  }

  function inlineNodes(kids: any, root: any): string {
    let out = "";
    let prevElement = false;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        out += inlineText(c.nodeValue || "");
        prevElement = false;
        continue;
      }
      if (c.nodeType !== 1) continue;
      // Adjacent elements with no whitespace between them ("<span>$9</span><span>★★</span>")
      // are usually visually separate; keep a space so words don't merge.
      if (prevElement && out && !/\s$/.test(out)) out += " ";
      prevElement = true;
      const tag = tagOf(c);
      if (SKIP.has(tag)) continue;
      if (isHidden(c)) continue;
      if (root && o.mainContent && c !== root && isNoise(c) && textLen(c) < textLen(root) * 0.5) continue;
      switch (tag) {
        case "br":
          out += "\n";
          break;
        case "strong":
        case "b": {
          const t = inline(c, root).trim();
          if (t) out += `**${t}**`;
          break;
        }
        case "em":
        case "i": {
          const t = inline(c, root).trim();
          if (t) out += `*${t}*`;
          break;
        }
        case "code":
        case "kbd":
        case "samp": {
          const t = (c.textContent || "").trim();
          if (t) out += "`" + t.replace(/`/g, "'") + "`";
          break;
        }
        case "a": {
          const t = inline(c, root).trim();
          const href = resolve(c.getAttribute("href") || "");
          if (!t) break;
          if (!href || linkMode === "none" || href.startsWith(base + "#")) {
            out += t;
          } else if (linkMode === "refs") {
            linkCount++;
            out += `[${t}][${linkRef(href)}]`;
          } else {
            linkCount++;
            out += `[${t}](${href})`;
          }
          break;
        }
        case "img": {
          if (!o.images) {
            break;
          }
          const alt = (c.getAttribute("alt") || "").trim();
          const src = resolve(c.getAttribute("src") || c.getAttribute("data-src") || "");
          if (src) out += `![${alt}](${src})`;
          break;
        }
        case "sup":
        case "sub":
        case "span":
        case "small":
        case "mark":
        case "abbr":
        case "cite":
        case "q":
        case "time":
        case "label":
        case "u":
        case "s":
        case "del":
        case "ins":
        case "font":
        default:
          if (BLOCK.has(tag) || /^h[1-6]$/.test(tag) || tag === "ul" || tag === "ol" || tag === "table" || tag === "pre" || tag === "blockquote" || tag === "hr") {
            out += "\n" + block(c, root, 0).join("\n") + "\n";
          } else {
            out += inline(c, root);
          }
      }
    }
    return out;
  }

  function clean(s: string): string {
    return s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
  }

  function listBlock(el: any, root: any, depth: number): string[] {
    const lines: string[] = [];
    const ordered = tagOf(el) === "ol";
    let n = parseInt(el.getAttribute("start") || "1", 10) || 1;
    const kids = el.children || [];
    for (let i = 0; i < kids.length; i++) {
      const li = kids[i];
      if (tagOf(li) !== "li" || isHidden(li)) continue;
      const bullet = ordered ? `${n++}.` : "-";
      const indent = "  ".repeat(depth);
      // Split li into its own inline text and nested lists.
      let own = "";
      const nested: string[] = [];
      const cs = li.childNodes || [];
      for (let j = 0; j < cs.length; j++) {
        const c = cs[j];
        if (c.nodeType === 1 && (tagOf(c) === "ul" || tagOf(c) === "ol")) {
          nested.push(...listBlock(c, root, depth + 1));
        } else if (c.nodeType === 1 && (BLOCK.has(tagOf(c)) || tagOf(c) === "table" || tagOf(c) === "pre")) {
          own += " " + block(c, root, 0).join(" ");
        } else if (c.nodeType === 1 || c.nodeType === 3) {
          own += inlineNodes([c], root);
        }
      }
      own = clean(own).replace(/\n+/g, " ");
      if (own) lines.push(`${indent}${bullet} ${own}`);
      lines.push(...nested);
    }
    return lines;
  }

  function tableBlock(el: any, root: any): string[] {
    const rows: string[][] = [];
    const trs = el.querySelectorAll("tr");
    let headerRow = -1;
    for (let i = 0; i < trs.length && rows.length < 200; i++) {
      const tr = trs[i];
      // Skip rows belonging to nested tables.
      let p = tr.parentNode;
      while (p && tagOf(p) !== "table") p = p.parentNode;
      if (p !== el) continue;
      const cells: string[] = [];
      const tds = tr.children || [];
      let allTh = tds.length > 0;
      for (let j = 0; j < tds.length; j++) {
        const td = tds[j];
        const t = tagOf(td);
        if (t !== "td" && t !== "th") continue;
        if (t !== "th") allTh = false;
        cells.push(escapeCell(clean(inline(td, root))));
      }
      if (!cells.length) continue;
      if (allTh && headerRow === -1 && rows.length === 0) headerRow = 0;
      rows.push(cells);
    }
    if (!rows.length) return [];
    const width = Math.max(...rows.map((r) => r.length));
    // Layout tables (single column) read better as paragraphs.
    if (width === 1) return rows.map((r) => r[0]).filter(Boolean);
    const pad = (r: string[]) => {
      const c = r.slice();
      while (c.length < width) c.push("");
      return "| " + c.join(" | ") + " |";
    };
    const out: string[] = [];
    const head = headerRow === 0 ? rows[0] : rows[0];
    out.push(pad(head));
    out.push("|" + " --- |".repeat(width));
    for (const r of rows.slice(1)) out.push(pad(r));
    return out;
  }

  /** Convert a block-level subtree into markdown lines. */
  function block(el: any, root: any, depth: number): string[] {
    const tag = tagOf(el);
    if (SKIP.has(tag) || isHidden(el)) return [];
    if (root && o.mainContent && el !== root && isNoise(el) && textLen(el) < textLen(root) * 0.5) return [];

    if (/^h[1-6]$/.test(tag)) {
      const t = clean(inline(el, root)).replace(/\n+/g, " ");
      return t ? ["", "#".repeat(parseInt(tag[1], 10)) + " " + t, ""] : [];
    }
    if (tag === "ul" || tag === "ol") return ["", ...listBlock(el, root, 0), ""];
    if (tag === "table") return ["", ...tableBlock(el, root), ""];
    if (tag === "hr") return ["", "---", ""];
    if (tag === "pre") {
      const code = (el.textContent || "").replace(/\n+$/, "");
      const cls = (el.querySelector && el.querySelector("code") && el.querySelector("code").getAttribute("class")) || "";
      const lang = (cls.match(/language-([\w+-]+)/) || [])[1] || "";
      return ["", "```" + lang, code, "```", ""];
    }
    if (tag === "blockquote") {
      const inner = blockChildren(el, root, depth);
      return ["", ...inner.filter((l) => l.trim()).map((l) => "> " + l), ""];
    }
    if (tag === "dl") {
      const out: string[] = [""];
      const kids = el.children || [];
      for (let i = 0; i < kids.length; i++) {
        const t = clean(inline(kids[i], root)).replace(/\n+/g, " ");
        if (!t) continue;
        out.push(tagOf(kids[i]) === "dt" ? `**${t}**` : `: ${t}`);
      }
      out.push("");
      return out;
    }
    return blockChildren(el, root, depth);
  }

  /** Walk children, grouping runs of inline content into paragraphs. */
  function blockChildren(el: any, root: any, depth: number): string[] {
    const out: string[] = [];
    let para: any[] = [];
    const flush = () => {
      if (!para.length) return;
      const t = clean(inlineNodes(para, root));
      if (t) out.push("", t, "");
      para = [];
    };
    const kids = el.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        if ((c.nodeValue || "").trim()) para.push(c);
        else if (para.length) para.push(c);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const tag = tagOf(c);
      const isBlock =
        BLOCK.has(tag) || /^h[1-6]$/.test(tag) || ["ul", "ol", "table", "pre", "blockquote", "hr", "dl", "li", "tr"].includes(tag);
      if (isBlock) {
        flush();
        if (depth > 60) continue;
        out.push(...block(c, root, depth + 1));
      } else {
        if (isHidden(c) || SKIP.has(tag)) continue;
        para.push(c);
      }
    }
    flush();
    return out;
  }

  let root: any = doc.body || doc.documentElement;
  if (o.selector) {
    const sel = doc.querySelector(o.selector);
    if (sel) root = sel;
  } else if (o.mainContent) {
    root = findMain();
  }

  const lines = root ? block(root, root, 0) : [];
  let md = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (linkMode === "refs" && refs.length) {
    md += "\n\n" + refs.map((u, i) => `[${i + 1}]: ${u}`).join("\n");
  }
  const title = ((doc.querySelector && doc.querySelector("title") && doc.querySelector("title").textContent) || "").trim();
  return { title, markdown: md, links: linkCount };
}
