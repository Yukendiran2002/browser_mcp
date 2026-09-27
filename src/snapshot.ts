/**
 * Compact, ref-annotated page snapshots.
 *
 * Instead of dumping HTML or a full accessibility tree, the snapshot lists only
 * what an agent can act on (plus headings and landmarks for orientation), one
 * line per element, each with a short ref:
 *
 *   ## main
 *   - heading "Sign in" [h1]
 *   - textbox "Email" [e3] (required)
 *   - button "Sign in" [e7]
 *
 * Refs are stable for the lifetime of an element, so after an action the server
 * can send just the lines that changed (a diff) instead of the whole page again.
 * Every selector parameter in this server accepts a ref (e.g. "e7" or "f1e3").
 */

import type { Frame, Page, ElementHandle } from "playwright";

export interface SnapshotOptions {
  /** "interactive" (default): actionable elements + headings. "full": also text blocks. */
  mode?: "interactive" | "full";
  /** Only elements intersecting the viewport. */
  viewportOnly?: boolean;
  /** Include link targets. */
  urls?: boolean;
  /** Ref prefix for frames (set by the server). */
  prefix?: string;
  /** Max elements to list. */
  limit?: number;
  /** CSS selector: only snapshot inside this element (main frame). */
  root?: string;
  /** Only return lines matching this text (case-insensitive) or /regex/, with their landmarks. */
  find?: string;
}

export interface FrameSnapshot {
  lines: string[];
  total: number;
  truncated: boolean;
  scroll: { y: number; h: number; vh: number };
}

/**
 * Runs inside the page. Must stay self-contained: it is serialized by
 * `frame.evaluate` and executed in the page's JS context.
 */
export function snapshotInPage(opts: SnapshotOptions): FrameSnapshot {
  const w: any = window as any;
  const KEY = Symbol.for("__bmcp_refs");
  let st = w[KEY];
  if (!st) {
    st = { map: new Map<string, any>(), rev: new WeakMap<Element, string>(), n: 0 };
    Object.defineProperty(w, KEY, { value: st, enumerable: false });
  }
  const prefix = opts.prefix || "";
  const mode = opts.mode || "interactive";
  const limit = opts.limit || 400;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const lines: string[] = [];
  let total = 0;

  // Drop refs to elements that are gone.
  for (const [k, ref] of st.map) {
    const el = ref.deref ? ref.deref() : ref;
    if (!el || !el.isConnected) st.map.delete(k);
  }

  function refFor(el: Element): string {
    let r = st.rev.get(el);
    if (!r) {
      r = prefix + "e" + ++st.n;
      st.rev.set(el, r);
    }
    st.map.set(r, typeof (w as any).WeakRef === "function" ? new w.WeakRef(el) : el);
    return r;
  }

  const clip = (s: string, n: number) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const q = (s: string) => '"' + s.replace(/"/g, "'") + '"';

  function labelText(el: Element): string {
    const id = el.getAttribute("id");
    if (id) {
      try {
        const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab) return (lab as HTMLElement).innerText || lab.textContent || "";
      } catch {
        /* invalid id */
      }
    }
    const wrap = el.closest("label");
    if (wrap) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
      return clone.textContent || "";
    }
    return "";
  }

  function name(el: Element, role: string): string {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ");
      if (t.trim()) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const t = (el as HTMLInputElement).type;
      if (t === "submit" || t === "button" || t === "reset") return (el as HTMLInputElement).value || t;
      return labelText(el) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    }
    if (tag === "img") return el.getAttribute("alt") || el.getAttribute("title") || "";
    let t = (el as HTMLElement).innerText;
    if (t == null) t = el.textContent || "";
    if (!t.trim()) {
      const img = el.querySelector("img[alt]");
      if (img) t = img.getAttribute("alt") || "";
      const svgTitle = el.querySelector("svg title");
      if (!t && svgTitle) t = svgTitle.textContent || "";
      if (!t) t = el.getAttribute("title") || "";
    }
    if (!t && role === "link") {
      const href = el.getAttribute("href") || "";
      t = href.replace(/^https?:\/\/[^/]+/, "").slice(0, 40);
    }
    return t;
  }

  const INPUT_ROLE: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    image: "button", range: "slider", number: "spinbutton", search: "searchbox", file: "file",
    color: "colorpicker", date: "date", "datetime-local": "datetime", time: "time", month: "month", week: "week",
  };
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "textbox", "searchbox", "combobox", "slider", "spinbutton", "treeitem", "gridcell",
  ]);
  const LANDMARKS: Record<string, string> = {
    nav: "nav", header: "header", footer: "footer", main: "main", aside: "aside", form: "form", dialog: "dialog",
  };

  function roleOf(el: Element, cs: CSSStyleDeclaration, parentPointer: boolean): string | null {
    const explicit = el.getAttribute("role");
    if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return el.hasAttribute("href") ? "link" : null;
      case "button":
        return "button";
      case "input": {
        const t = ((el as HTMLInputElement).type || "text").toLowerCase();
        if (t === "hidden") return null;
        return INPUT_ROLE[t] || "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "summary":
        return "button";
      case "video":
      case "audio":
        return (el as HTMLMediaElement).controls ? tag : null;
    }
    if ((el as HTMLElement).isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (el.hasAttribute("onclick")) return "clickable";
    if (cs.cursor === "pointer" && !parentPointer) return "clickable";
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) >= 0 && explicit) return explicit;
    return null;
  }

  function states(el: Element, role: string): string {
    const s: string[] = [];
    const input = el as HTMLInputElement;
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const checked = el.getAttribute("aria-checked");
      if (input.checked || checked === "true") s.push("checked");
    }
    if (input.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    const exp = el.getAttribute("aria-expanded");
    if (exp) s.push(exp === "true" ? "expanded" : "collapsed");
    if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) s.push("selected");
    if (input.required) s.push("required");
    if (input.readOnly) s.push("readonly");
    return s.length ? " (" + s.join(", ") + ")" : "";
  }

  function valueOf(el: Element, role: string): string {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      const opts = Array.from(sel.options)
        .slice(0, 8)
        .map((o) => clip(o.text, 20));
      return (opt ? " =" + q(clip(opt.text, 40)) : "") + " options:[" + opts.join("|") + (sel.options.length > 8 ? "|…" : "") + "]";
    }
    if ((tag === "input" || tag === "textarea") && role !== "checkbox" && role !== "radio" && role !== "button") {
      const inp = el as HTMLInputElement;
      if (inp.type === "password") return inp.value ? ' ="••••"' : "";
      return inp.value ? " =" + q(clip(inp.value, 60)) : "";
    }
    if ((el as HTMLElement).isContentEditable) {
      const t = clip(el.textContent || "", 60);
      return t ? " =" + q(t) : "";
    }
    return "";
  }

  function inViewport(r: DOMRect): boolean {
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  function walk(root: Element | ShadowRoot, depth: number, parentPointer: boolean, inInteractive: boolean) {
    const kids = (root as any).children as HTMLCollection;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template" || tag === "head" || tag === "meta" || tag === "link") continue;
      if (el.getAttribute("aria-hidden") === "true" || el.getAttribute("data-mp-annotation")) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none") continue;
      const hidden = cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) === 0;
      const rect = el.getBoundingClientRect();
      const sized = rect.width > 0 && rect.height > 0;
      const pointer = cs.cursor === "pointer";

      let indent = depth;
      const role = !hidden && sized ? roleOf(el, cs, parentPointer || inInteractive) : null;

      // Landmarks give structure without per-node nesting.
      const lm = LANDMARKS[tag] || (el.getAttribute("role") === "dialog" ? "dialog" : null);
      if (lm && !hidden && sized && lines.length < limit) {
        const label = el.getAttribute("aria-label") || (tag === "form" ? el.getAttribute("name") || el.id || "" : "");
        lines.push("  ".repeat(depth) + "## " + lm + (label ? " " + q(clip(label, 40)) : ""));
        indent = depth + 1;
      }

      if (!hidden && sized && (!opts.viewportOnly || inViewport(rect))) {
        if (role && !(role === "clickable" && inInteractive)) {
          total++;
          // An image-only link to a URL that also has a text link is noise (card thumbnails).
          const dupThumb =
            role === "link" && !((el as HTMLElement).innerText || "").trim() && textLinkHrefs.has((el as HTMLAnchorElement).href) && !el.getAttribute("aria-label");
          if (dupThumb) {
            // still reachable via the text link
          } else if (lines.length < limit) {
            const r = refFor(el);
            let line = "- " + role;
            const nm = clip(name(el, role), 80);
            if (nm) line += " " + q(nm);
            line += " [" + r + "]" + valueOf(el, role) + states(el, role);
            const h = headingOf.get(el);
            if (h) line += " (" + h + ")";
            if (opts.urls && role === "link") {
              const href = (el as HTMLAnchorElement).href || "";
              line += " →" + href.replace(location.origin, "").slice(0, 80);
            }
            lines.push("  ".repeat(indent) + line);
          }
        } else if (!inInteractive && (el.getAttribute("role") === "alert" || el.getAttribute("role") === "status" || el.hasAttribute("aria-live"))) {
          // Live regions carry form errors / success messages the agent needs to see.
          const t = clip((el as HTMLElement).innerText || "", 160);
          if (t && lines.length < limit) lines.push("  ".repeat(indent) + "- " + (el.getAttribute("role") || "status") + " " + q(t));
        } else if (/^h[1-6]$/.test(tag) && !inInteractive) {
          const t = clip((el as HTMLElement).innerText || "", 80);
          // <h3><a>Title</a></h3>: print one line — the link, tagged with its heading level.
          const inner = el.querySelector("a[href],button");
          if (inner && clip((inner as HTMLElement).innerText || "", 80) === t) headingOf.set(inner, tag);
          else if (t && lines.length < limit) lines.push("  ".repeat(indent) + "- heading " + q(t) + " [" + tag + "]");
        } else if (mode === "full" && !inInteractive && (tag === "p" || tag === "li" || tag === "td" || tag === "th" || tag === "label" || tag === "blockquote" || tag === "figcaption" || tag === "dd" || tag === "dt")) {
          const t = clip((el as HTMLElement).innerText || "", 160);
          if (t && lines.length < limit && !el.querySelector("a,button,input,select,textarea")) lines.push("  ".repeat(indent) + "- text " + q(t));
        } else if (tag === "img" && mode === "full") {
          const alt = el.getAttribute("alt");
          if (alt && lines.length < limit) lines.push("  ".repeat(indent) + "- img " + q(clip(alt, 60)));
        } else if (tag === "iframe" && lines.length < limit) {
          const label = clip(el.getAttribute("title") || el.getAttribute("name") || (el as HTMLIFrameElement).src || "", 60);
          if (label) lines.push("  ".repeat(indent) + "- iframe " + q(label));
        }
      }

      const childInteractive = inInteractive || (!!role && role !== "clickable");
      const before = lines.length;
      if (el.shadowRoot) walk(el.shadowRoot, indent, pointer, childInteractive);
      walk(el, indent, pointer || (!!role && role === "clickable"), childInteractive);
      // Footers are link farms: keep the first few links, summarize the rest.
      if ((lm === "footer" || el.getAttribute("role") === "contentinfo") && !opts.root && !opts.find) {
        const items = lines.slice(before);
        const links = items.filter((l) => /^\s*- link /.test(l));
        if (links.length > 12) {
          let kept = 0;
          const out = items.filter((l) => !/^\s*- link /.test(l) || kept++ < 8);
          out.push("  ".repeat(indent) + `- … ${links.length - 8} more footer links (snapshot root="footer" to list them)`);
          for (let k = out.length - 2; k >= 0; k--) {
            if (/^\s*- heading /.test(out[k]) && /^\s*- (heading |… )/.test(out[k + 1])) out.splice(k, 1);
          }
          lines.splice(before, items.length, ...out);
        }
      }
    }
  }

  const textLinkHrefs = new Set<string>();
  document.querySelectorAll("a[href]").forEach((a) => {
    if (((a as HTMLElement).innerText || "").trim()) textLinkHrefs.add((a as HTMLAnchorElement).href);
  });
  const headingOf = new WeakMap<Element, string>();
  const start = opts.root ? document.querySelector(opts.root) : document.body;
  if (opts.root && !start) throw new Error(`root selector matched nothing: ${opts.root}`);
  if (start) walk(start, 0, false, false);
  return {
    lines,
    total,
    truncated: total > lines.length,
    scroll: {
      y: Math.round(window.scrollY),
      h: Math.round(document.documentElement.scrollHeight),
      vh: Math.round(vh),
    },
  };
}

// ─── Server side ─────────────────────────────────────────────

const REF_RE = /^(?:f(\d+))?e\d+$/;

export function isRef(s: string): boolean {
  return REF_RE.test(s.trim());
}

interface PageSnapState {
  lines: string[];
  url: string;
  frames: Map<number, Frame>;
}

const frameIds = new WeakMap<Frame, number>();
let nextFrameId = 1;
const lastSnapshots = new WeakMap<Page, PageSnapState>();

function frameId(f: Frame): number {
  let id = frameIds.get(f);
  if (!id) {
    id = nextFrameId++;
    frameIds.set(f, id);
  }
  return id;
}

export interface SnapshotResult {
  text: string;
  lines: string[];
  total: number;
}

export function hasSnapshot(page: Page): boolean {
  return lastSnapshots.has(page);
}

/** Snapshot the page (main frame + child frames), store it for diffs. */
export async function takeSnapshot(page: Page, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const frames = new Map<number, Frame>();
  const all: string[] = [];
  let total = 0;
  let truncated = false;
  let scroll = { y: 0, h: 0, vh: 0 };
  const main = page.mainFrame();
  const list = page.frames().slice(0, 20);
  for (const f of list) {
    if (f.isDetached()) continue;
    const isMain = f === main;
    const id = frameId(f);
    try {
      if (!isMain && opts.root) continue;
      const res = await f.evaluate(snapshotInPage, { ...opts, prefix: isMain ? "" : `f${id}` });
      if (isMain) {
        scroll = res.scroll;
        all.unshift(...res.lines);
      } else {
        if (!res.lines.length) continue;
        frames.set(id, f);
        all.push(`## frame f${id} ${JSON.stringify((f.name() || f.url()).slice(0, 60))}`);
        all.push(...res.lines.map((l) => "  " + l));
      }
      total += res.total;
      truncated = truncated || res.truncated;
    } catch {
      // Frame navigated or is cross-origin and not yet ready — skip it.
    }
  }
  // Only a full default snapshot is a valid baseline for diffs; scoped or partial
  // views would make the next diff report the rest of the page as "added".
  const partial = !!opts.root || !!opts.viewportOnly || (opts.mode ?? "interactive") !== "interactive";
  const prev = lastSnapshots.get(page);
  if (!partial) lastSnapshots.set(page, { lines: all, url: page.url(), frames });
  else if (prev) for (const [k, f] of frames) prev.frames.set(k, f);
  else lastSnapshots.set(page, { lines: [], url: "", frames });
  const more = truncated ? ` (list truncated at ${opts.limit || 400}; use viewportOnly or scroll)` : "";
  const scrollInfo = scroll.h > scroll.vh ? ` scroll:${scroll.y}/${scroll.h - scroll.vh}px` : "";
  const header = `${total} actionable${more}${scrollInfo}`;
  if (opts.find) {
    const found = findLines(all, opts.find);
    return { text: `${found.matches} match(es) for ${JSON.stringify(opts.find)} of ${total} actionable\n${found.lines.join("\n")}`, lines: all, total };
  }
  return { text: header + "\n" + all.join("\n"), lines: all, total };
}

/** Lines matching `query`, each preceded by the landmark headers it sits under. */
export function findLines(lines: string[], query: string): { lines: string[]; matches: number } {
  const re = query.match(/^\/(.+)\/([a-z]*)$/);
  const test = re ? ((s: string) => new RegExp(re[1], re[2] || "i").test(s)) : ((s: string) => s.toLowerCase().includes(query.toLowerCase()));
  const out: string[] = [];
  const emitted = new Set<number>();
  let matches = 0;
  lines.forEach((line, i) => {
    if (/^\s*## /.test(line) || !test(line)) return;
    matches++;
    // Walk back to collect enclosing landmark headers (smaller indent).
    const indent = line.search(/\S/);
    const heads: number[] = [];
    let want = indent;
    for (let j = i - 1; j >= 0 && want > 0; j--) {
      const ind = lines[j].search(/\S/);
      if (/^\s*## /.test(lines[j]) && ind < want) {
        heads.unshift(j);
        want = ind;
      }
    }
    for (const h of heads) if (!emitted.has(h)) (emitted.add(h), out.push(lines[h]));
    out.push(line);
  });
  return { lines: out, matches };
}

/**
 * Snapshot again and return only what changed since the previous snapshot.
 * Returns null when there is no comparable previous snapshot (new document).
 */
export async function diffSnapshot(page: Page, opts: SnapshotOptions = {}, maxLines = 40): Promise<string | null> {
  const prev = lastSnapshots.get(page);
  const cur = await takeSnapshot(page, opts);
  if (!prev || prev.url.split("#")[0] !== page.url().split("#")[0]) return null;
  const count = new Map<string, number>();
  for (const l of prev.lines) count.set(l, (count.get(l) || 0) + 1);
  const added: string[] = [];
  for (const l of cur.lines) {
    const n = count.get(l) || 0;
    if (n > 0) count.set(l, n - 1);
    else added.push(l);
  }
  const removed: string[] = [];
  for (const [l, n] of count) for (let i = 0; i < n; i++) removed.push(l);
  if (!added.length && !removed.length) return "no visible changes";
  const out = [`changes: +${added.length} -${removed.length}`];
  for (const l of added.slice(0, maxLines)) out.push("+ " + l.trim());
  for (const l of removed.slice(0, Math.max(5, maxLines - added.length))) out.push("- " + l.trim());
  if (added.length + removed.length > maxLines) out.push(`… (${added.length + removed.length - maxLines} more; call snapshot)`);
  return out.join("\n");
}

/** Resolve a ref from the latest snapshot to an element handle. */
export async function resolveRef(page: Page, ref: string): Promise<ElementHandle | null> {
  const m = ref.trim().match(REF_RE);
  if (!m) return null;
  let frame: Frame | undefined = page.mainFrame();
  if (m[1]) {
    const state = lastSnapshots.get(page);
    frame = state?.frames.get(parseInt(m[1], 10));
    if (!frame || frame.isDetached()) return null;
  }
  const handle = await frame.evaluateHandle((r: string) => {
    const st = (window as any)[Symbol.for("__bmcp_refs")];
    if (!st) return null;
    const v = st.map.get(r);
    const el = v && v.deref ? v.deref() : v;
    return el && el.isConnected ? el : null;
  }, ref.trim());
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    return null;
  }
  return el as ElementHandle;
}
