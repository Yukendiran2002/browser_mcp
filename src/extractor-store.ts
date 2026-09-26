/**
 * On-disk storage for learned extractors (DejavuScraper-compatible JSON).
 * Default location: ~/.browser-mcp/extractors/<name>.json
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, resolve } from "node:path";
import { normalizeModel, type ExtractorModel } from "./content/dejavu.js";

export class ExtractorStore {
  readonly dir: string;

  constructor(dataDir?: string) {
    const base = dataDir || process.env.BROWSER_MCP_DATA_DIR || join(homedir(), ".browser-mcp");
    this.dir = join(base, "extractors");
  }

  private pathFor(name: string): string {
    // Allow loading a DejavuScraper file directly by path.
    if (name.endsWith(".json") && (isAbsolute(name) || name.includes("/") || name.includes("\\"))) return resolve(name);
    if (!/^[\w.-]{1,80}$/.test(name)) throw new Error(`Invalid extractor name "${name}" (use letters, digits, _ . -)`);
    return join(this.dir, `${name}.json`);
  }

  save(name: string, model: ExtractorModel): string {
    const p = this.pathFor(name);
    mkdirSync(this.dir, { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(model, null, 1));
    renameSync(tmp, p);
    return p;
  }

  load(name: string): ExtractorModel {
    const p = this.pathFor(name);
    if (!existsSync(p)) throw new Error(`Extractor "${name}" not found (${p}). Use manage_extractors action=list.`);
    return normalizeModel(JSON.parse(readFileSync(p, "utf-8")));
  }

  exists(name: string): boolean {
    try {
      return existsSync(this.pathFor(name));
    } catch {
      return false;
    }
  }

  list(): { name: string; rules: number; aliases: string[]; source?: string; updated: string }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(this.dir, f);
        try {
          const m = normalizeModel(JSON.parse(readFileSync(p, "utf-8")));
          return {
            name: f.replace(/\.json$/, ""),
            rules: m.stack_list.length,
            aliases: Array.from(new Set(m.stack_list.map((r) => r.alias || "value"))),
            source: m.meta?.url,
            updated: statSync(p).mtime.toISOString().slice(0, 16),
          };
        } catch {
          return { name: f.replace(/\.json$/, ""), rules: 0, aliases: [], updated: "invalid file" };
        }
      });
  }

  delete(name: string): void {
    const p = this.pathFor(name);
    if (existsSync(p)) unlinkSync(p);
  }
}
