/**
 * Web search without API keys by default.
 *   - SearXNG instance (--search-url / BROWSER_MCP_SEARCH_URL): JSON API
 *   - Brave Search API (BRAVE_API_KEY)
 *   - DuckDuckGo HTML results (default; fetched through the scraper so it can
 *     fall back to the browser)
 */

import { fetch as undiciFetch } from "undici";
import { Scraper } from "./scraper.js";
import { parseDocument } from "./content/dom.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchConfig {
  searxUrl?: string;
  braveKey?: string;
}

/** Parse DuckDuckGo's HTML endpoint (html.duckduckgo.com/html). */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const doc = parseDocument(html);
  const out: SearchResult[] = [];
  const blocks = doc.querySelectorAll(".result");
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (/result--ad/.test(b.getAttribute("class") || "")) continue;
    const a = b.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    // Result links are redirects: //duckduckgo.com/l/?uddg=<encoded target>
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) href = decodeURIComponent(m[1]);
    else if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/.test(href)) continue;
    const snippet = b.querySelector(".result__snippet");
    out.push({
      title: (a.textContent || "").replace(/\s+/g, " ").trim(),
      url: href,
      snippet: (snippet?.textContent || "").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

export async function webSearch(scraper: Scraper, query: string, limit: number, cfg: SearchConfig): Promise<{ results: SearchResult[]; provider: string }> {
  if (cfg.searxUrl) {
    const u = new URL("/search", cfg.searxUrl);
    u.searchParams.set("q", query);
    u.searchParams.set("format", "json");
    const res = await undiciFetch(u.href, { signal: AbortSignal.timeout(15_000) } as any);
    if (!res.ok) throw new Error(`SearXNG ${res.status}`);
    const data: any = await res.json();
    return {
      provider: "searxng",
      results: (data.results || []).slice(0, limit).map((r: any) => ({ title: r.title || "", url: r.url, snippet: r.content || "" })),
    };
  }
  if (cfg.braveKey) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.searchParams.set("q", query);
    u.searchParams.set("count", String(Math.min(limit, 20)));
    const res = await undiciFetch(u.href, {
      headers: { accept: "application/json", "x-subscription-token": cfg.braveKey },
      signal: AbortSignal.timeout(15_000),
    } as any);
    if (!res.ok) throw new Error(`Brave Search ${res.status}`);
    const data: any = await res.json();
    return {
      provider: "brave",
      results: (data.web?.results || []).slice(0, limit).map((r: any) => ({ title: r.title || "", url: r.url, snippet: (r.description || "").replace(/<[^>]+>/g, "") })),
    };
  }
  const f = await scraper.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { mode: "auto", noCache: false });
  return { provider: "duckduckgo", results: parseDuckDuckGo(f.html).slice(0, limit) };
}
