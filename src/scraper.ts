/**
 * Scraping engine: fast HTTP path first, real browser only when needed.
 *
 *  - HTTP fast path (undici): no browser, ~10-50x faster and cheaper per page.
 *  - Automatic escalation to the browser for JS-rendered pages or bot walls;
 *    the decision is remembered per domain so later pages skip the probe.
 *  - Browser path uses a pool of background tabs in the same context (shares
 *    cookies/logins with the agent's session) with images/fonts/media/trackers
 *    blocked for speed.
 *  - Short-lived response cache so repeated reads cost nothing.
 */

import { fetch as undiciFetch, ProxyAgent, EnvHttpProxyAgent, type Dispatcher } from "undici";
import type { Page, Route } from "playwright";
import { BrowserManager, chromeUserAgent } from "./browser-manager.js";
import { assertAllowed } from "./policy.js";
import { parseDocument } from "./content/dom.js";
import { htmlToMarkdown, type MarkdownOptions } from "./content/markdown.js";
import { filterByQuery } from "./content/bm25.js";
import { extractStructured, type StructuredKind, ALL_KINDS } from "./content/structured.js";

export type FetchMode = "auto" | "http" | "browser";

export interface Fetched {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  via: "http" | "browser";
  ms: number;
  cached?: boolean;
  /** Markdown computed in-page (browser path) — respects CSS visibility. */
  inPageMarkdown?: { title: string; markdown: string };
}

export interface ScrapeOptions {
  mode?: FetchMode;
  mainContent?: boolean;
  links?: "inline" | "refs" | "none";
  images?: boolean;
  query?: string;
  maxChars?: number;
  waitFor?: string;
  /** Browser only: scroll to the bottom up to N times to load infinite-scroll / lazy content. */
  scroll?: number;
  timeout?: number;
  structured?: StructuredKind[] | boolean;
  includeHtml?: boolean;
  includeLinks?: boolean;
  noCache?: boolean;
}

export interface ScrapeResult {
  url: string;
  finalUrl: string;
  status: number;
  via: string;
  ms: number;
  title: string;
  markdown?: string;
  totalChars?: number;
  html?: string;
  links?: string[];
  structured?: Record<string, any>;
  note?: string;
  error?: string;
}

const BLOCK_TYPES = new Set(["image", "media", "font"]);
const TRACKERS =
  /(google-analytics|googletagmanager|doubleclick|facebook\.net|connect\.facebook|hotjar|segment\.(io|com)|mixpanel|amplitude|clarity\.ms|adservice|adsystem|taboola|outbrain|criteo|scorecardresearch|quantserve|newrelic|nr-data|fullstory|intercom|optimizely)/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|bmp|avif|mp4|webm|mov|mp3|wav|ogg|pdf|zip|gz|tgz|rar|7z|exe|dmg|msi|apk|css|js|mjs|woff2?|ttf|eot|xml|rss|json|csv|xlsx?|docx?|pptx?)(\?|$)/i;

export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    return url.href;
  } catch {
    return u;
  }
}

function estimateTokens(chars: number): string {
  const t = Math.round(chars / 4);
  return t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t);
}

export function formatScrape(r: ScrapeResult): string {
  if (r.error) return `✗ ${r.url} — ${r.error}`;
  const head = [
    `# ${r.title || "(untitled)"}`,
    `url: ${r.finalUrl} · ${r.status} · via ${r.via} · ${r.ms}ms${r.markdown != null ? ` · ~${estimateTokens(r.markdown.length)} tokens` : ""}${
      r.totalChars && r.markdown && r.totalChars > r.markdown.length ? ` (of ~${estimateTokens(r.totalChars)})` : ""
    }`,
  ];
  if (r.note) head.push(`note: ${r.note}`);
  const parts = [head.join("\n")];
  if (r.markdown != null) parts.push(r.markdown || "(no text content)");
  if (r.structured && Object.keys(r.structured).length) parts.push("```json\n" + JSON.stringify(r.structured, null, 1) + "\n```");
  if (r.links?.length) parts.push("links:\n" + r.links.join("\n"));
  if (r.html) parts.push("```html\n" + r.html + "\n```");
  return parts.join("\n\n");
}

/** Simple counting semaphore. */
class Semaphore {
  private queue: (() => void)[] = [];
  constructor(private n: number) {}
  async acquire(): Promise<void> {
    if (this.n > 0) {
      this.n--;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.n++;
  }
}

export class Scraper {
  private cache = new Map<string, { at: number; data: Fetched }>();
  /** Per-host history of HTTP successes vs. escalations to the browser. */
  private hostStats = new Map<string, { ok: number; escalated: number }>();
  private idlePages: Page[] = [];
  private browserSlots: Semaphore;
  private dispatcher: Dispatcher | undefined;
  private robots = new Map<string, string[]>();
  cacheTtlMs: number;
  poolSize: number;
  blockResources = true;

  constructor(
    private browser: BrowserManager,
    opts: { cacheTtlMs?: number; poolSize?: number; blockResources?: boolean } = {}
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
    this.poolSize = opts.poolSize ?? 4;
    if (opts.blockResources === false) this.blockResources = false;
    this.browserSlots = new Semaphore(this.poolSize);
    const proxy = browser.options.proxyServer;
    if (proxy && /^https?:/.test(proxy)) this.dispatcher = new ProxyAgent(proxy);
    else if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
      this.dispatcher = new EnvHttpProxyAgent();
    }
  }

  /** SOCKS proxies can't be used by the HTTP client, so everything goes through the browser. */
  private httpAllowed(): boolean {
    const proxy = this.browser.options.proxyServer;
    return !proxy || /^https?:/.test(proxy);
  }

  // ─── HTTP fast path ────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      "user-agent": this.browser.options.userAgent || chromeUserAgent("140"),
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": this.browser.options.locale ? `${this.browser.options.locale},en;q=0.8` : "en-US,en;q=0.9",
      "upgrade-insecure-requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      ...(this.browser.options.extraHTTPHeaders || {}),
    };
  }

  async fetchHttp(url: string, timeout = 15_000): Promise<Fetched> {
    const t0 = Date.now();
    const res = await undiciFetch(url, {
      headers: this.headers(),
      redirect: "follow",
      signal: AbortSignal.timeout(timeout),
      dispatcher: this.dispatcher,
    } as any);
    const contentType = res.headers.get("content-type") || "";
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    if (len > 15_000_000) throw new Error(`Response too large (${len} bytes)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (/application\/pdf/i.test(contentType) || buf.subarray(0, 5).toString("latin1") === "%PDF-") {
      return { url, finalUrl: res.url || url, status: res.status, contentType: "text/markdown; source=pdf", html: await pdfToMarkdown(buf), via: "http", ms: Date.now() - t0 };
    }
    let charset = (contentType.match(/charset=([\w-]+)/i) || [])[1];
    if (!charset) {
      const head = buf.subarray(0, 2048).toString("latin1");
      charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    }
    let html: string;
    try {
      html = new TextDecoder(charset || "utf-8").decode(buf);
    } catch {
      html = buf.toString("utf8");
    }
    return { url, finalUrl: res.url || url, status: res.status, contentType, html, via: "http", ms: Date.now() - t0 };
  }

  /** Does an HTTP response look like it needs a real browser (JS app shell, bot wall)? */
  needsBrowser(f: Fetched): string | null {
    const html = f.html;
    if (!/html|xml/i.test(f.contentType) && f.contentType) return null;
    if ([403, 429, 503].includes(f.status) && /cf-chl|challenge-platform|just a moment|captcha|access denied|attention required|perimeterx|px-captcha|datadome/i.test(html)) {
      return `bot protection (${f.status})`;
    }
    if (f.status >= 400 && f.status !== 404 && f.status !== 410) return `HTTP ${f.status}`;
    const doc = parseDocument(html);
    const body = doc.body;
    const text = (body?.textContent || "").replace(/\s+/g, " ").trim();
    const scripts = doc.querySelectorAll("script").length;
    if (text.length < 250 && scripts > 0) return "little static text (JS-rendered page)";
    const mount = doc.querySelector("#root, #app, #__next, #__nuxt, [data-reactroot], app-root, #svelte");
    if (mount && (mount.textContent || "").trim().length < 50 && text.length < 1500) return "empty app mount point";
    if (/enable javascript|javascript is (disabled|required)|requires javascript/i.test(text) && text.length < 2000) return "page requires JavaScript";
    return null;
  }

  // ─── Browser path ──────────────────────────────────────────

  private async acquirePage(): Promise<Page> {
    await this.browserSlots.acquire();
    try {
      let page = this.idlePages.pop();
      while (page && page.isClosed()) page = this.idlePages.pop();
      if (page) return page;
      page = await this.browser.newInternalPage();
      if (this.blockResources) {
        await page.route("**/*", (route: Route) => {
          const req = route.request();
          if (BLOCK_TYPES.has(req.resourceType()) || TRACKERS.test(req.url())) return route.abort();
          return route.fallback();
        });
      }
      return page;
    } catch (e) {
      this.browserSlots.release();
      throw e;
    }
  }

  private releasePage(page: Page): void {
    if (!page.isClosed()) {
      if (this.idlePages.length < this.poolSize) this.idlePages.push(page);
      else page.close().catch(() => {});
    }
    this.browserSlots.release();
  }

  async fetchBrowser(url: string, opts: ScrapeOptions = {}, md?: MarkdownOptions): Promise<Fetched> {
    const t0 = Date.now();
    const page = await this.acquirePage();
    try {
      const timeout = opts.timeout ?? 30_000;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      // Interstitial bot checks (Cloudflare, Fastly, …) usually solve themselves and reload.
      const challenge = /just a moment|client challenge|checking your browser|attention required|verify you are human/i;
      if (challenge.test(await page.title().catch(() => ""))) {
        await page
          .waitForFunction((src: string) => !new RegExp(src, "i").test(document.title), challenge.source, { timeout: 15_000, polling: 500 })
          .catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
      if (opts.scroll) {
        // Infinite scroll / lazy loading: scroll until the page stops growing.
        for (let i = 0; i < Math.min(opts.scroll, 50); i++) {
          const h0 = await page.evaluate(() => document.documentElement.scrollHeight);
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          const grew = await page
            .waitForFunction((h: number) => document.documentElement.scrollHeight > h, h0, { timeout: 2_500, polling: 100 })
            .then(() => true)
            .catch(() => false);
          if (!grew) break;
        }
      }
      if (opts.waitFor) {
        await page.waitForSelector(opts.waitFor, { timeout: Math.min(timeout, 15_000) }).catch(() => {});
      } else {
        // Give client-side rendering a moment; don't wait for long-polling to stop.
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
      }
      const out: Fetched = {
        url,
        finalUrl: page.url(),
        status: resp?.status() ?? 200,
        contentType: resp?.headers()["content-type"] || "text/html",
        html: "",
        via: "browser",
        ms: 0,
      };
      if (md) out.inPageMarkdown = await page.evaluate(htmlToMarkdown, { ...md, visibleOnly: true });
      out.html = await page.content();
      out.ms = Date.now() - t0;
      return out;
    } finally {
      this.releasePage(page);
    }
  }

  // ─── Unified fetch ─────────────────────────────────────────

  async fetch(url: string, opts: ScrapeOptions = {}, md?: MarkdownOptions): Promise<Fetched & { note?: string }> {
    assertAllowed(url);
    const key = normalizeUrl(url);
    if (!opts.noCache) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < this.cacheTtlMs && (opts.mode !== "browser" || hit.data.via === "browser")) {
        return { ...hit.data, cached: true, ms: 0 };
      }
    }
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }
    })();
    const mode = opts.mode ?? "auto";
    let result: Fetched & { note?: string };
    const stats = this.hostStats.get(host) || { ok: 0, escalated: 0 };
    this.hostStats.set(host, stats);
    // Skip the HTTP probe for hosts that keep needing a browser.
    const preferBrowser = stats.escalated >= 2 && stats.escalated > stats.ok;
    if (mode === "browser" || opts.scroll || !this.httpAllowed() || (mode === "auto" && preferBrowser)) {
      result = await this.fetchBrowser(url, opts, md);
    } else {
      let http: Fetched | null = null;
      let reason: string | null = null;
      try {
        http = await this.fetchHttp(url, opts.timeout ?? 15_000);
        reason = mode === "auto" ? this.needsBrowser(http) : null;
      } catch (e: any) {
        if (mode === "http") throw e;
        reason = `HTTP fetch failed: ${e.message}`;
      }
      if (reason && mode === "auto") {
        stats.escalated++;
        result = { ...(await this.fetchBrowser(url, opts, md)), note: `used browser: ${reason}` };
      } else {
        stats.ok++;
        result = http!;
      }
    }
    this.cache.set(key, { at: Date.now(), data: { ...result, inPageMarkdown: undefined } });
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }

  /** Fetch + convert a URL into agent-friendly output. */
  async scrape(url: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    return (await this.scrapeDoc(url, opts)).result;
  }

  /** Like scrape(), but also returns the parsed document for further extraction. */
  async scrapeDoc(url: string, opts: ScrapeOptions = {}): Promise<{ result: ScrapeResult; doc: any | null }> {
    const t0 = Date.now();
    const mdOpts: MarkdownOptions = {
      mainContent: opts.mainContent ?? true,
      links: opts.links ?? "inline",
      images: opts.images ?? false,
    };
    try {
      const f = await this.fetch(url, opts, mdOpts);
      const res: ScrapeResult = { url, finalUrl: f.finalUrl, status: f.status, via: f.cached ? `${f.via} (cached)` : f.via, ms: Date.now() - t0, title: "", note: f.note };
      if (f.contentType && !/html|xml/i.test(f.contentType)) {
        // PDF (already converted), JSON, plain text — return as text, still query-filterable.
        let text = f.html;
        const max = opts.maxChars ?? 8000;
        res.totalChars = text.length;
        if (/source=pdf/.test(f.contentType)) res.title = decodeURIComponent(new URL(f.finalUrl).pathname.split("/").pop() || "PDF");
        if (opts.query) {
          const filtered = filterByQuery(text, opts.query, max);
          text = filtered.markdown || "(no section matched the query)";
          res.note = [res.note, `query kept ${filtered.kept}/${filtered.total} sections`].filter(Boolean).join("; ");
        }
        res.markdown = text.length > max ? text.slice(0, max) + `\n…(truncated, ${res.totalChars} chars total)` : text;
        return { result: res, doc: null };
      }
      const doc = parseDocument(f.html);
      const md = f.inPageMarkdown ?? htmlToMarkdown({ ...mdOpts, baseUrl: f.finalUrl }, doc);
      res.title = md.title;
      let text = md.markdown;
      res.totalChars = text.length;
      const max = opts.maxChars ?? 8000;
      if (opts.query) {
        const filtered = filterByQuery(text, opts.query, max);
        text = filtered.markdown || "(no section matched the query)";
        res.note = [res.note, `query kept ${filtered.kept}/${filtered.total} sections`].filter(Boolean).join("; ");
      }
      if (text.length > max) text = text.slice(0, max) + `\n…(truncated, ${res.totalChars} chars total — use query= or maxChars=)`;
      res.markdown = text;
      if (opts.structured) {
        const kinds = opts.structured === true ? ALL_KINDS : opts.structured;
        res.structured = extractStructured(doc, f.finalUrl, kinds);
      }
      if (opts.includeLinks) res.links = this.linksOf(doc, f.finalUrl).slice(0, 200);
      if (opts.includeHtml) res.html = f.html.slice(0, max * 3);
      res.ms = Date.now() - t0;
      return { result: res, doc };
    } catch (e: any) {
      return { result: { url, finalUrl: url, status: 0, via: "-", ms: Date.now() - t0, title: "", error: e.message }, doc: null };
    }
  }

  /** Links with their anchor text (first text seen per URL). */
  linksWithText(doc: any, base: string): { url: string; text: string }[] {
    const out = new Map<string, string>();
    const as = doc.querySelectorAll("a[href]");
    for (let i = 0; i < as.length; i++) {
      const href = as[i].getAttribute("href");
      if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) continue;
      try {
        const u = new URL(href, base);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        const key = normalizeUrl(u.href);
        if (!out.has(key)) out.set(key, (as[i].textContent || "").replace(/\s+/g, " ").trim().slice(0, 120));
      } catch {
        /* ignore */
      }
    }
    return [...out].map(([url, text]) => ({ url, text }));
  }

  linksOf(doc: any, base: string): string[] {
    const out = new Set<string>();
    const as = doc.querySelectorAll("a[href]");
    for (let i = 0; i < as.length; i++) {
      const href = as[i].getAttribute("href");
      if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) continue;
      try {
        const u = new URL(href, base);
        if (u.protocol === "http:" || u.protocol === "https:") out.add(normalizeUrl(u.href));
      } catch {
        /* ignore */
      }
    }
    return [...out];
  }

  // ─── Robots / crawl / map ──────────────────────────────────

  private async disallowed(url: string): Promise<boolean> {
    const u = new URL(url);
    let rules = this.robots.get(u.origin);
    if (!rules) {
      rules = [];
      try {
        const f = await this.fetchHttp(`${u.origin}/robots.txt`, 8_000);
        if (f.status === 200) {
          let applies = false;
          for (const raw of f.html.split("\n")) {
            const line = raw.split("#")[0].trim();
            const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
            if (!m) continue;
            const k = m[1].toLowerCase();
            if (k === "user-agent") applies = m[2] === "*";
            else if (k === "disallow" && applies && m[2]) rules.push(m[2]);
          }
        }
      } catch {
        /* no robots.txt */
      }
      this.robots.set(u.origin, rules);
    }
    const path = u.pathname + u.search;
    return rules.some((r) => {
      const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      return re.test(path);
    });
  }

  async crawl(
    start: string,
    opts: {
      maxPages?: number;
      maxDepth?: number;
      sameDomain?: boolean;
      include?: string[];
      exclude?: string[];
      concurrency?: number;
      respectRobots?: boolean;
      scrape?: ScrapeOptions;
      /** Best-first: visit links whose anchor text / URL match these words first. */
      prioritize?: string;
    },
    onPage: (r: ScrapeResult, doc: any | null, depth: number) => Promise<void> | void
  ): Promise<{ visited: number; failed: number; skipped: number }> {
    const maxPages = Math.min(opts.maxPages ?? 20, 1000);
    const maxDepth = opts.maxDepth ?? 2;
    const origin = new URL(start);
    const inc = (opts.include || []).map((p) => new RegExp(p, "i"));
    const exc = (opts.exclude || []).map((p) => new RegExp(p, "i"));
    const seen = new Set<string>([normalizeUrl(start)]);
    const queue: { url: string; depth: number; score: number }[] = [{ url: normalizeUrl(start), depth: 0, score: 0 }];
    const terms = (opts.prioritize || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
    const scoreLink = (url: string, text: string) => {
      if (!terms.length) return 0;
      const hay = (text + " " + decodeURIComponent(url)).toLowerCase();
      return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    };
    let visited = 0;
    let failed = 0;
    let skipped = 0;
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 16));

    let claimed = 0;
    let active = 0;

    const worker = async () => {
      while (claimed < maxPages) {
        const item = queue.shift();
        if (!item) {
          // Queue empty: wait while other workers may still discover links.
          if (active === 0) return;
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        claimed++;
        active++;
        try {
          if (opts.respectRobots !== false && (await this.disallowed(item.url).catch(() => false))) {
            skipped++;
            claimed--;
            continue;
          }
          const { result: r, doc } = await this.scrapeDoc(item.url, { ...(opts.scrape || {}) });
          if (!r.error && r.status >= 400) r.error = `HTTP ${r.status}`;
          if (r.error) {
            failed++;
            await onPage(r, null, item.depth);
            continue;
          }
          visited++;
          if (doc && item.depth < maxDepth) {
            for (const { url: link, text } of this.linksWithText(doc, r.finalUrl)) {
              if (seen.has(link) || SKIP_EXT.test(new URL(link).pathname)) continue;
              const lu = new URL(link);
              if (opts.sameDomain !== false && lu.host !== origin.host) continue;
              if (inc.length && !inc.some((re) => re.test(link))) continue;
              if (exc.some((re) => re.test(link))) continue;
              seen.add(link);
              queue.push({ url: link, depth: item.depth + 1, score: scoreLink(link, text) });
            }
            if (terms.length) {
              // Best-first: most relevant links next, shallower first on ties.
              queue.sort((a, b) => b.score - a.score || a.depth - b.depth);
            }
          }
          await onPage(r, doc, item.depth);
        } finally {
          active--;
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { visited, failed, skipped };
  }

  async map(start: string, opts: { search?: string; limit?: number; includeSubdomains?: boolean } = {}): Promise<{ urls: string[]; sources: string[] }> {
    const u = new URL(start);
    const limit = opts.limit ?? 500;
    const found = new Set<string>();
    const sources: string[] = [];
    const sameSite = (x: string) => {
      try {
        const h = new URL(x).host;
        return h === u.host || (opts.includeSubdomains && h.endsWith("." + u.host.replace(/^www\./, "")));
      } catch {
        return false;
      }
    };
    const sitemaps: string[] = [];
    try {
      const robots = await this.fetchHttp(`${u.origin}/robots.txt`, 8_000);
      if (robots.status === 200) for (const m of robots.html.matchAll(/^\s*sitemap:\s*(\S+)/gim)) sitemaps.push(m[1]);
    } catch {
      /* ignore */
    }
    if (!sitemaps.length) sitemaps.push(`${u.origin}/sitemap.xml`, `${u.origin}/sitemap_index.xml`);
    const visitedMaps = new Set<string>();
    while (sitemaps.length && visitedMaps.size < 25 && found.size < limit * 4) {
      const sm = sitemaps.shift()!;
      if (visitedMaps.has(sm) || /\.gz$/i.test(sm)) continue;
      visitedMaps.add(sm);
      try {
        const f = await this.fetchHttp(sm, 15_000);
        if (f.status !== 200) continue;
        sources.push(sm);
        const locs = [...f.html.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
        if (/<sitemapindex/i.test(f.html)) sitemaps.push(...locs);
        else for (const l of locs) if (sameSite(l)) found.add(normalizeUrl(l));
      } catch {
        /* ignore */
      }
    }
    // Always add links from the start page (catches sites without sitemaps).
    try {
      const f = await this.fetch(start, { mode: "auto" });
      sources.push(`links on ${start}`);
      for (const l of this.linksOf(parseDocument(f.html), f.finalUrl)) if (sameSite(l)) found.add(l);
    } catch {
      /* ignore */
    }
    let urls = [...found];
    if (opts.search) {
      const terms = opts.search.toLowerCase().split(/\s+/).filter(Boolean);
      urls = urls
        .map((x) => ({ x, s: terms.filter((t) => x.toLowerCase().includes(t)).length }))
        .filter((e) => e.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((e) => e.x);
    }
    return { urls: urls.slice(0, limit), sources };
  }

  async close(): Promise<void> {
    for (const p of this.idlePages) await p.close().catch(() => {});
    this.idlePages = [];
  }
}

/** Extract text from a PDF as markdown with page headings. */
export async function pdfToMarkdown(buf: Buffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => `## Page ${i + 1}\n\n${t.replace(/[ \t]+\n/g, "\n").trim()}`);
  return `(PDF, ${totalPages} pages)\n\n` + pages.join("\n\n");
}
