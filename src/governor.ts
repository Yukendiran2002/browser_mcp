/**
 * Response governor: every tool result passes through here before it reaches
 * the model.
 *
 *  - Secrets: values from --secrets (dotenv) or BROWSER_SECRET_* env vars can be
 *    typed as {{secret.NAME}}; the real value never appears in any response.
 *  - Size cap: a result larger than --max-response chars is written to a file
 *    and only its head plus the file path is returned, so one huge page can't
 *    flood the context window.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const secrets = new Map<string, string>();

export function loadSecrets(file?: string): number {
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BROWSER_SECRET_") && v) secrets.set(k.slice("BROWSER_SECRET_".length), v);
  }
  if (file) {
    if (!existsSync(file)) throw new Error(`Secrets file not found: ${file}`);
    for (const raw of readFileSync(file, "utf-8").split(/\r?\n/)) {
      const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v) secrets.set(m[1], v);
    }
  }
  return secrets.size;
}

export function secretNames(): string[] {
  return [...secrets.keys()];
}

/** Replace {{secret.NAME}} placeholders with real values (for typing into pages). */
export function resolveSecrets(text: string): string {
  return text.replace(/\{\{\s*secret\.([A-Za-z_]\w*)\s*\}\}/g, (all, name) => {
    const v = secrets.get(name);
    if (v === undefined) throw new Error(`Unknown secret "${name}". Known: ${secretNames().join(", ") || "(none)"}`);
    return v;
  });
}

/** Replace any secret value in outgoing text with its placeholder. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [name, value] of secrets) {
    if (value.length >= 4 && out.includes(value)) out = out.split(value).join(`{{secret.${name}}}`);
  }
  return out;
}

export interface GovernorOptions {
  maxChars: number;
  outputDir: string;
}

let opts: GovernorOptions = { maxChars: 25_000, outputDir: join(tmpdir(), "browser-mcp-output") };

export function configureGovernor(o: Partial<GovernorOptions>): void {
  opts = { ...opts, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
}

let seq = 0;

/** Post-process a tool result: mask secrets, spill oversized text to a file. */
export function govern(toolName: string, result: any): any {
  if (!result || !Array.isArray(result.content)) return result;
  const content = result.content.map((c: any) => (c.type === "text" && typeof c.text === "string" ? { ...c, text: maskSecrets(c.text) } : c));
  const total = content.reduce((n: number, c: any) => n + (c.type === "text" ? c.text.length : 0), 0);
  if (opts.maxChars > 0 && total > opts.maxChars) {
    const full = content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    mkdirSync(opts.outputDir, { recursive: true });
    const file = resolve(opts.outputDir, `${Date.now()}-${++seq}-${toolName}.md`);
    writeFileSync(file, full);
    const head = full.slice(0, opts.maxChars);
    const cut = head.lastIndexOf("\n") > opts.maxChars * 0.8 ? head.slice(0, head.lastIndexOf("\n")) : head;
    const note = `\n\n…[response was ${full.length} chars (~${Math.round(full.length / 4)} tokens); showing the first ${cut.length}. Full output: ${file}]`;
    return { ...result, content: [{ type: "text", text: cut + note }, ...content.filter((c: any) => c.type !== "text")] };
  }
  return { ...result, content };
}
