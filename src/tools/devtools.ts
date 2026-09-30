import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "../browser-manager.js";
import { ok, fail, pageInfo } from "./helpers.js";

/** Runs in the page: Web Vitals + timing + weight, from buffered performance entries. */
function collectMetrics(): Promise<any> {
  return new Promise((resolve) => {
    const out: any = {};
    const nav = performance.getEntriesByType("navigation")[0] as any;
    if (nav) {
      out.ttfb = Math.round(nav.responseStart);
      out.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
      out.load = Math.round(nav.loadEventEnd);
    }
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    if (fcp) out.fcp = Math.round(fcp.startTime);
    let cls = 0;
    let lcp = 0;
    const po = (type: string, cb: (e: any) => void) => {
      try {
        new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true } as any);
      } catch {
        /* unsupported */
      }
    };
    po("largest-contentful-paint", (e) => (lcp = Math.max(lcp, e.startTime)));
    po("layout-shift", (e) => {
      if (!e.hadRecentInput) cls += e.value;
    });
    let longTasks = 0;
    po("longtask", () => longTasks++);
    setTimeout(() => {
      if (lcp) out.lcp = Math.round(lcp);
      out.cls = Math.round(cls * 1000) / 1000;
      out.longTasks = longTasks;
      const res = performance.getEntriesByType("resource") as any[];
      const byType: Record<string, { n: number; kb: number }> = {};
      for (const r of res) {
        const t = r.initiatorType || "other";
        byType[t] ||= { n: 0, kb: 0 };
        byType[t].n++;
        byType[t].kb += (r.transferSize || 0) / 1024;
      }
      out.requests = res.length + 1;
      out.transferKB = Math.round(res.reduce((a, r) => a + (r.transferSize || 0), nav?.transferSize || 0) / 1024);
      out.byType = Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, `${v.n} / ${Math.round(v.kb)}KB`]));
      out.domNodes = document.getElementsByTagName("*").length;
      const mem = (performance as any).memory;
      if (mem) out.jsHeapMB = Math.round(mem.usedJSHeapSize / 1048576);
      resolve(out);
    }, 150);
  });
}

export function registerDevtoolsTools(server: McpServer, browser: BrowserManager): void {
  server.tool(
    "page_metrics",
    "Performance of the current page: TTFB, FCP, LCP, CLS, load timings, long tasks, requests/bytes by type, DOM size, JS heap, console errors, failed requests.",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const m = await page.evaluate(collectMetrics);
        const errors = browser.getConsoleLogs(id).filter((l) => l.type === "error").length;
        const failed = browser.getNetworkLogs(id).filter((l) => !l.status || l.status >= 400);
        const rate = (v: number | undefined, good: number, poor: number) => (v === undefined ? "" : v <= good ? " ✓" : v > poor ? " ✗" : " ~");
        const lines = [
          pageInfo(id, page.url(), await page.title().catch(() => "")),
          `TTFB ${m.ttfb ?? "?"}ms · FCP ${m.fcp ?? "?"}ms${rate(m.fcp, 1800, 3000)} · LCP ${m.lcp ?? "?"}ms${rate(m.lcp, 2500, 4000)} · CLS ${m.cls}${rate(m.cls, 0.1, 0.25)}`,
          `DOMContentLoaded ${m.domContentLoaded ?? "?"}ms · load ${m.load ?? "?"}ms · long tasks ${m.longTasks}`,
          `${m.requests} requests · ${m.transferKB}KB transferred · ${Object.entries(m.byType).map(([k, v]) => `${k} ${v}`).join(", ")}`,
          `DOM nodes ${m.domNodes}${m.jsHeapMB !== undefined ? ` · JS heap ${m.jsHeapMB}MB` : ""} · console errors ${errors} · failed requests ${failed.length}`,
          ...failed.slice(0, 5).map((f) => `  ✗ ${f.status || "failed"} ${f.method} ${f.url.slice(0, 120)}`),
        ];
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail(`page_metrics failed: ${e.message}`);
      }
    }
  );
}
