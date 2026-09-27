/**
 * Macros: record what the agent does, save it with parameters, replay it later
 * with zero LLM reasoning ("learn once" for interactions, the way learned
 * extractors are for data).
 */

import type { ElementHandle } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Step } from "./tools/actions.js";

/** Runs in the page: a selector that survives reloads (unlike snapshot refs). */
function stableSelectorInPage(el: Element): string {
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const unique = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const tag = el.tagName.toLowerCase();
  if (el.id && !/\d{3,}|^\d|[:.]/.test(el.id) && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
  for (const a of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "placeholder", "title", "alt"]) {
    const v = el.getAttribute(a);
    if (v && v.length < 80) {
      const sel = `${tag}[${a}="${esc(v)}"]`;
      if (unique(sel)) return sel;
    }
  }
  if (tag === "a" && el.getAttribute("href")) {
    const sel = `a[href="${esc(el.getAttribute("href")!)}"]`;
    if (unique(sel)) return sel;
  }
  const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
  if (text && text.length <= 40 && /^(a|button|summary|label|option|li|span|div)$/.test(tag)) {
    // Playwright text engine; exact match of the element's own text.
    const same = Array.from(document.querySelectorAll(tag)).filter((n) => ((n as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() === text);
    if (same.length === 1) return `${tag}:text-is("${esc(text)}")`;
  }
  // Fallback: CSS path with :nth-of-type, anchored at the nearest id.
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 8) {
    if (cur.id && !/\d{3,}|^\d|[:.]/.test(cur.id) && unique("#" + CSS.escape(cur.id))) {
      parts.unshift("#" + CSS.escape(cur.id));
      break;
    }
    const t = cur.tagName.toLowerCase();
    const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(cur) + 1})` : t);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

export async function stableSelector(el: ElementHandle): Promise<string> {
  return el.evaluate(stableSelectorInPage as any);
}

// ─── Recorder ────────────────────────────────────────────────

export const recorder = {
  steps: [] as Step[],
  paused: false,
  push(step: Step) {
    if (this.paused) return;
    if (["wait"].includes(step.action) && step.ms && !step.selector && !step.text && !step.url) return;
    this.steps.push(step);
    if (this.steps.length > 300) this.steps.shift();
  },
};

// ─── Storage ─────────────────────────────────────────────────

export interface Macro {
  name: string;
  params: string[];
  steps: Step[];
  created: string;
  description?: string;
}

export class MacroStore {
  readonly dir: string;
  constructor(dataDir?: string) {
    this.dir = join(dataDir || process.env.BROWSER_MCP_DATA_DIR || join(homedir(), ".browser-mcp"), "macros");
  }
  private path(name: string): string {
    if (!/^[\w.-]{1,80}$/.test(name)) throw new Error(`Invalid macro name "${name}"`);
    return join(this.dir, `${name}.json`);
  }
  save(m: Macro): string {
    mkdirSync(this.dir, { recursive: true });
    const p = this.path(m.name);
    writeFileSync(p, JSON.stringify(m, null, 1));
    return p;
  }
  load(name: string): Macro {
    const p = this.path(name);
    if (!existsSync(p)) throw new Error(`Macro "${name}" not found`);
    return JSON.parse(readFileSync(p, "utf-8"));
  }
  list(): Macro[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf-8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  delete(name: string): void {
    const p = this.path(name);
    if (existsSync(p)) unlinkSync(p);
  }
}

const FIELDS: (keyof Step)[] = ["text", "value", "url", "key", "selector", "to", "script"];

/** Turn concrete example values into {{param}} placeholders. */
export function parameterize(steps: Step[], params: Record<string, string>): Step[] {
  return steps.map((s) => {
    const c: any = { ...s };
    for (const f of FIELDS) {
      if (typeof c[f] !== "string") continue;
      for (const [name, example] of Object.entries(params)) {
        if (example && c[f].includes(example)) c[f] = c[f].split(example).join(`{{${name}}}`);
      }
    }
    return c;
  });
}

/** Fill {{param}} placeholders (leaves {{secret.X}} for the secrets resolver). */
export function instantiate(steps: Step[], vars: Record<string, string>): Step[] {
  return steps.map((s) => {
    const c: any = { ...s };
    for (const f of FIELDS) {
      if (typeof c[f] !== "string") continue;
      c[f] = c[f].replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (all: string, name: string) => {
        if (!(name in vars)) throw new Error(`Missing macro variable "${name}"`);
        return vars[name];
      });
    }
    return c;
  });
}

export function macroParams(steps: Step[]): string[] {
  const out = new Set<string>();
  for (const s of steps) for (const f of FIELDS) {
    const v = (s as any)[f];
    if (typeof v === "string") for (const m of v.matchAll(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g)) out.add(m[1]);
  }
  return [...out];
}
