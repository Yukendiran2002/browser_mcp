import { z } from "zod";
import { appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "../browser-manager.js";
import { Scraper, formatScrape, type ScrapeOptions, type ScrapeResult } from "../scraper.js";
import { ExtractorStore } from "../extractor-store.js";
import { parseDocument } from "../content/dom.js";
import { extractStructured, ALL_KINDS, type StructuredKind } from "../content/structured.js";
import { learn, applyRules, records, grouped, type ExtractorModel, type Rule } from "../content/dejavu.js";
import { ok, fail, truncate, normalizeInputUrl } from "./helpers.js";

const kindEnum = z.enum(ALL_KINDS as [StructuredKind, ...StructuredKind[]]);
const modeParam = z.enum(["auto", "http", "browser"]).optional().describe("auto: HTTP, browser if needed");

function writeOut(path: string, data: string): string {
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

function json(v: any, max: number): string {
  const s = JSON.stringify(v, null, 1);
  return s.length > max ? s.slice(0, max) + `\n…(truncated; ${s.length} chars — use outputFile to save everything)` : s;
}

function ruleSummary(rules: Rule[], hits: Map<string, string[]>): string {
  return rules
    .map((r) => {
      const vals = hits.get(r.stack_id) || [];
      const last = r.content[r.content.length - 1];
      const cls = Array.isArray(last[1].class) ? "." + last[1].class.join(".") : "";
      const attr = r.wanted_attr ? `@${r.wanted_attr}` : "";
      return `${r.stack_id} [${r.alias || "value"}] <${last[0]}${cls}>${attr} ${vals.length} hits: ${vals
        .slice(0, 3)
        .map((v) => JSON.stringify(truncate(v, 40)))
        .join(", ")}`;
    })
    .join("\n");
}

/** Page source for the current tab: serialized live DOM (what the user sees). */
async function currentDoc(browser: BrowserManager, pageId?: number): Promise<{ doc: any; url: string }> {
  const { page } = await browser.getOrCreatePage(pageId);
  return { doc: parseDocument(await page.content()), url: page.url() };
}

export function registerScrapeTools(server: McpServer, browser: BrowserManager, scraper: Scraper, store: ExtractorStore): void {
  server.tool(
    "scrape",
    "Fetch URL(s) as clean markdown (fast HTTP; background browser only for JS/protected pages). Doesn't touch the active tab.",
    {
      url: z.string().optional(),
      urls: z.array(z.string()).max(100).optional(),
      mode: modeParam,
      query: z.string().optional().describe("Keep only relevant sections"),
      maxChars: z.number().optional().describe("Per page"),
      mainContent: z.boolean().optional(),
      links: z.enum(["inline", "refs", "none"]).optional(),
      images: z.boolean().optional(),
      structured: z.union([z.boolean(), z.array(kindEnum)]).optional().describe("Add extract_structured data"),
      includeLinks: z.boolean().optional(),
      waitFor: z.string().optional().describe("CSS to await (browser)"),
      concurrency: z.number().optional(),
      outputFile: z.string().optional().describe("Save JSONL, return summary"),
    },
    async (a) => {
      const list = [...(a.url ? [a.url] : []), ...(a.urls || [])].map(normalizeInputUrl);
      if (!list.length) return fail("Provide url or urls");
      const opts: ScrapeOptions = {
        mode: a.mode,
        query: a.query,
        maxChars: a.maxChars ?? (list.length > 1 ? 3_000 : 8_000),
        mainContent: a.mainContent,
        links: a.links,
        images: a.images,
        structured: a.structured,
        includeLinks: a.includeLinks,
        waitFor: a.waitFor,
      };
      const results: ScrapeResult[] = new Array(list.length);
      let next = 0;
      const conc = Math.max(1, Math.min(a.concurrency ?? 6, 16));
      await Promise.all(
        Array.from({ length: Math.min(conc, list.length) }, async () => {
          while (next < list.length) {
            const i = next++;
            results[i] = await scraper.scrape(list[i], opts);
          }
        })
      );
      if (a.outputFile) {
        const p = writeOut(a.outputFile, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
        const lines = results.map((r) => (r.error ? `✗ ${r.url}: ${r.error}` : `✓ ${r.finalUrl} · ${r.via} · ${r.ms}ms · ${r.markdown?.length ?? 0} chars · ${truncate(r.title, 60)}`));
        return ok(`Saved ${results.length} page(s) to ${p}\n${lines.join("\n")}`);
      }
      const body = results.map(formatScrape).join("\n\n---\n\n");
      return results.every((r) => r.error) ? fail(body) : ok(body);
    }
  );

  server.tool(
    "crawl",
    "Crawl a site (BFS, same domain, robots.txt) returning each page's markdown, or records if extractor is set.",
    {
      url: z.string(),
      maxPages: z.number().optional().describe("Default 20"),
      maxDepth: z.number().optional().describe("Default 2"),
      include: z.array(z.string()).optional().describe("URL regexes"),
      exclude: z.array(z.string()).optional(),
      sameDomain: z.boolean().optional(),
      mode: modeParam,
      query: z.string().optional(),
      maxCharsPerPage: z.number().optional(),
      extractor: z.string().optional().describe("Learned extractor name"),
      concurrency: z.number().optional(),
      respectRobots: z.boolean().optional(),
      outputFile: z.string().optional().describe("Save JSONL"),
    },
    async (a) => {
      try {
        const model = a.extractor ? store.load(a.extractor) : null;
        const out: string[] = [];
        let budget = 24_000;
        let omitted = 0;
        let totalRecords = 0;
        const file = a.outputFile ? writeOut(a.outputFile, "") : null;
        const stats = await scraper.crawl(
          a.url,
          {
            maxPages: a.maxPages,
            maxDepth: a.maxDepth,
            include: a.include,
            exclude: a.exclude,
            sameDomain: a.sameDomain,
            concurrency: a.concurrency,
            respectRobots: a.respectRobots,
            scrape: { mode: a.mode, query: a.query, maxChars: a.maxCharsPerPage ?? 1_500 },
          },
          (r, doc, depth) => {
            let recs: any[] | undefined;
            if (model && doc) {
              recs = records(applyRules(doc, r.finalUrl, model.stack_list));
              totalRecords += recs.length;
            }
            if (file) {
              const row = recs ? { url: r.finalUrl, title: r.title, depth, records: recs, error: r.error } : { ...r, depth };
              appendFileSync(file, JSON.stringify(row) + "\n");
            }
            const section = r.error
              ? `✗ ${r.url}: ${r.error}`
              : recs
                ? `## ${r.finalUrl} (${recs.length} records)\n${json(recs, 2_000)}`
                : formatScrape(r);
            if (!file && section.length < budget) {
              out.push(section);
              budget -= section.length;
            } else if (!file) omitted++;
            else out.push(r.error ? `✗ ${r.url}` : `✓ d${depth} ${r.finalUrl}${recs ? ` · ${recs.length} records` : ""}`);
          }
        );
        const head = `Crawled ${stats.visited} page(s), ${stats.failed} failed, ${stats.skipped} blocked by robots.txt${model ? `, ${totalRecords} records` : ""}${file ? ` → ${file}` : ""}${omitted ? ` (${omitted} page(s) omitted from output — use outputFile)` : ""}`;
        return ok(head + "\n\n" + out.join(file ? "\n" : "\n\n---\n\n"));
      } catch (e: any) {
        return fail(`crawl failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "map_site",
    "List a site's URLs from sitemaps and homepage links, no crawling. search filters them.",
    {
      url: z.string(),
      search: z.string().optional(),
      limit: z.number().optional(),
      includeSubdomains: z.boolean().optional(),
    },
    async ({ url, search, limit, includeSubdomains }) => {
      try {
        const r = await scraper.map(normalizeInputUrl(url), { search, limit: limit ?? 200, includeSubdomains });
        return ok(`${r.urls.length} URL(s) from ${r.sources.join(", ") || "no sources"}\n${r.urls.join("\n")}`);
      } catch (e: any) {
        return fail(`map_site failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "extract_structured",
    "Structured data without an LLM (current tab or url): metadata, JSON-LD, tables, repeated items like products, pagination, contacts.",
    {
      url: z.string().optional(),
      kinds: z.array(kindEnum).optional(),
      maxItems: z.number().optional(),
      mode: modeParam,
      pageId: z.number().optional(),
      outputFile: z.string().optional(),
    },
    async ({ url, kinds, maxItems, mode, pageId, outputFile }) => {
      try {
        let doc: any;
        let base: string;
        if (url) {
          const f = await scraper.fetch(url, { mode });
          doc = parseDocument(f.html);
          base = f.finalUrl;
        } else {
          ({ doc, url: base } = await currentDoc(browser, pageId));
        }
        const data = extractStructured(doc, base, kinds ?? ALL_KINDS, maxItems ?? 30);
        if (outputFile) return ok(`Saved to ${writeOut(outputFile, JSON.stringify(data, null, 1))} (keys: ${Object.keys(data).join(", ")})`);
        return ok(Object.keys(data).length ? json(data, 20_000) : "No structured data found");
      } catch (e: any) {
        return fail(`extract_structured failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "learn_extractor",
    "Learn a scraper from 1-2 example values per field on a page (current tab or url). run_extractor then scrapes similar pages with no LLM.",
    {
      name: z.string(),
      examples: z
        .union([z.record(z.array(z.string())), z.array(z.string())])
        .describe('e.g. {"title":["iPhone 15"],"price":["$999"]}; /regex/ ok'),
      url: z.string().optional(),
      fuzz: z.number().optional().describe("0-1, default 1 (exact)"),
      update: z.boolean().optional().describe("Add to existing rules"),
      mode: modeParam,
      pageId: z.number().optional(),
    },
    async ({ name, examples, url, fuzz, update, mode, pageId }) => {
      try {
        let doc: any;
        let base: string;
        if (url) {
          const f = await scraper.fetch(url, { mode });
          doc = parseDocument(f.html);
          base = f.finalUrl;
        } else {
          ({ doc, url: base } = await currentDoc(browser, pageId));
        }
        const wanted = Array.isArray(examples) ? { "": examples } : examples;
        const { rules, unmatched } = learn(doc, base, wanted, fuzz ?? 1);
        if (!rules.length) {
          return fail(`No element matched ${unmatched.join(", ")}. Copy values exactly as shown on the page (read_page/snapshot), or set fuzz: 0.8.`);
        }
        let model: ExtractorModel = { stack_list: rules, meta: { name, url: base, fields: Object.keys(wanted), created: new Date().toISOString(), engine: "browser-mcp" } };
        if (update && store.exists(name)) {
          const old = store.load(name);
          const seen = new Set(old.stack_list.map((r) => r.hash + r.alias));
          model = { ...old, stack_list: [...old.stack_list, ...rules.filter((r) => !seen.has(r.hash + r.alias))] };
        }
        const results = applyRules(doc, base, model.stack_list, { heal: false });
        const hits = new Map(results.map((r) => [r.rule.stack_id, r.hits.map((h) => h.value)]));
        const recs = records(results);
        const path = store.save(name, model);
        return ok(
          [
            `Saved extractor "${name}" (${model.stack_list.length} rules) → ${path}`,
            unmatched.length ? `Unmatched examples: ${unmatched.join(", ")}` : null,
            `Rules (drop noisy ones with manage_extractors action=remove_rules):\n${ruleSummary(model.stack_list, hits)}`,
            `Preview: ${recs.length} records\n${json(recs.slice(0, 5), 3_000)}`,
          ]
            .filter(Boolean)
            .join("\n\n")
        );
      } catch (e: any) {
        return fail(`learn_extractor failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "run_extractor",
    "Run a learned extractor on the current tab, url or urls (no LLM). Self-heals after layout changes; can follow pagination.",
    {
      name: z.string().describe("Name or DejavuScraper .json path"),
      url: z.string().optional(),
      urls: z.array(z.string()).max(500).optional(),
      format: z.enum(["records", "grouped"]).optional(),
      exact: z.boolean().optional(),
      followPages: z.number().optional().describe("Extra 'next' pages"),
      mode: modeParam,
      concurrency: z.number().optional(),
      maxItems: z.number().optional(),
      outputFile: z.string().optional().describe(".json or .jsonl"),
      pageId: z.number().optional(),
    },
    async (a) => {
      try {
        const model = store.load(a.name);
        const applyOpts = { mode: a.exact ? ("exact" as const) : ("similar" as const) };
        const all: any[] = [];
        const groupedAll: Record<string, string[]> = {};
        const notes: string[] = [];
        const consume = (doc: any, url: string) => {
          const res = applyRules(doc, url, model.stack_list, applyOpts);
          const healed = res.filter((r) => r.healed).map((r) => r.rule.alias || "value");
          if (healed.length) notes.push(`${url}: rules for [${healed.join(", ")}] no longer matched — used similarity matching (consider re-learning)`);
          if ((a.format ?? "records") === "records") {
            const recs = records(res);
            if (a.urls?.length || a.followPages) for (const r of recs) r._url = url;
            all.push(...recs);
          } else {
            for (const [k, v] of Object.entries(grouped(res))) (groupedAll[k] ||= []).push(...v);
          }
          return res;
        };

        const targets = [...(a.url ? [a.url] : []), ...(a.urls || [])];
        if (!targets.length) {
          const { doc, url } = await currentDoc(browser, a.pageId);
          consume(doc, url);
          let pages = 0;
          let nextUrl = a.followPages ? extractStructured(doc, url, ["pagination"]).pagination?.next : undefined;
          while (nextUrl && pages < (a.followPages ?? 0)) {
            const f = await scraper.fetch(nextUrl, { mode: a.mode });
            const d = parseDocument(f.html);
            consume(d, f.finalUrl);
            pages++;
            nextUrl = extractStructured(d, f.finalUrl, ["pagination"]).pagination?.next;
          }
        } else {
          let next = 0;
          const docs: { url: string; doc: any }[] = [];
          const errors: string[] = [];
          await Promise.all(
            Array.from({ length: Math.min(Math.max(1, a.concurrency ?? 6), targets.length) }, async () => {
              while (next < targets.length) {
                const u = targets[next++];
                try {
                  let f = await scraper.fetch(u, { mode: a.mode });
                  let d = parseDocument(f.html);
                  docs.push({ url: f.finalUrl, doc: d });
                  for (let p = 0; p < (a.followPages ?? 0); p++) {
                    const nu = extractStructured(d, f.finalUrl, ["pagination"]).pagination?.next;
                    if (!nu) break;
                    f = await scraper.fetch(nu, { mode: a.mode });
                    d = parseDocument(f.html);
                    docs.push({ url: f.finalUrl, doc: d });
                  }
                } catch (e: any) {
                  errors.push(`${u}: ${e.message}`);
                }
              }
            })
          );
          const order = new Map(targets.map((t, i) => [t, i]));
          docs.sort((x, y) => (order.get(x.url) ?? 1e9) - (order.get(y.url) ?? 1e9));
          for (const d of docs) consume(d.doc, d.url);
          if (errors.length) notes.push(`failed: ${errors.join("; ")}`);
        }

        const data = (a.format ?? "records") === "records" ? all : groupedAll;
        const count = Array.isArray(data) ? data.length : Object.values(data).reduce((n, v) => n + v.length, 0);
        const noteText = notes.length ? `\n${notes.join("\n")}` : "";
        if (a.outputFile) {
          const p = a.outputFile.endsWith(".jsonl") && Array.isArray(data)
            ? writeOut(a.outputFile, data.map((r) => JSON.stringify(r)).join("\n") + "\n")
            : writeOut(a.outputFile, JSON.stringify(data, null, 1));
          return ok(`Extracted ${count} item(s) → ${p}${noteText}\nSample:\n${json(Array.isArray(data) ? data.slice(0, 3) : data, 1_500)}`);
        }
        const shown = Array.isArray(data) ? data.slice(0, a.maxItems ?? 100) : data;
        return ok(`Extracted ${count} item(s)${noteText}\n${json(shown, 30_000)}`);
      } catch (e: any) {
        return fail(`run_extractor failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "manage_extractors",
    "List/show/delete extractors or prune rules by id.",
    {
      action: z.enum(["list", "show", "delete", "keep_rules", "remove_rules"]),
      name: z.string().optional(),
      rules: z.array(z.string()).optional(),
    },
    async ({ action, name, rules }) => {
      try {
        if (action === "list") {
          const l = store.list();
          return ok(l.length ? l.map((e) => `${e.name}: ${e.rules} rules, fields [${e.aliases.join(", ")}]${e.source ? ` · learned on ${e.source}` : ""} · ${e.updated}`).join("\n") : `No extractors yet (${store.dir})`);
        }
        if (!name) return fail("name is required");
        if (action === "delete") {
          store.delete(name);
          return ok(`Deleted ${name}`);
        }
        const model = store.load(name);
        if (action === "show") {
          return ok(
            `${name}: ${model.stack_list.length} rules${model.meta?.url ? ` (learned on ${model.meta.url})` : ""}\n` +
              model.stack_list
                .map((r) => `${r.stack_id} [${r.alias || "value"}] ${r.content.slice(-3).map((c) => c[0] + (Array.isArray(c[1].class) ? "." + c[1].class.join(".") : "")).join(" > ")}${r.wanted_attr ? " @" + r.wanted_attr : ""}`)
                .join("\n")
          );
        }
        if (!rules?.length) return fail("rules is required");
        const set = new Set(rules);
        const before = model.stack_list.length;
        model.stack_list = model.stack_list.filter((r) => (action === "keep_rules" ? set.has(r.stack_id) : !set.has(r.stack_id)));
        store.save(name, model);
        return ok(`${name}: ${before} → ${model.stack_list.length} rules`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );
}
