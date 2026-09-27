import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "../browser-manager.js";
import { endpointTemplate, jsonShape, selectJson, type ApiCall } from "../apis.js";
import { assertAllowed } from "../policy.js";
import { resolveSecrets } from "../governor.js";
import { ok, fail, truncate } from "./helpers.js";

function parse(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function registerApiTools(server: McpServer, browser: BrowserManager): void {
  server.tool(
    "list_apis",
    "JSON APIs the site called while you browsed (XHR/fetch), with response shapes. Use call_api to hit them directly — far cheaper than rendering pages.",
    {
      filter: z.string().optional().describe("URL substring"),
      pageId: z.number().optional().describe("Default: all tabs"),
    },
    async ({ filter, pageId }) => {
      const calls = (pageId !== undefined ? browser.getApiCalls(pageId) : browser.getAllApiCalls()).filter((c) => !filter || c.url.includes(filter));
      if (!calls.length) return ok("No JSON API calls captured yet. Navigate/interact first (APIs are recorded automatically).");
      const groups = new Map<string, ApiCall[]>();
      for (const c of calls) {
        const k = endpointTemplate(c.method, c.url);
        groups.set(k, [...(groups.get(k) || []), c]);
      }
      const lines: string[] = [];
      for (const [tpl, list] of groups) {
        const last = list[list.length - 1];
        const data = parse(last.body);
        const auth = Object.keys(last.headers).some((h) => /authorization|x-.*(token|key|auth)/i.test(h)) ? " · auth header" : "";
        lines.push(
          `${tpl} ×${list.length} → ${last.status} ${Math.round(last.size / 1024)}KB${auth}\n  e.g. ${truncate(last.url, 160)}${
            last.requestBody ? `\n  body: ${truncate(last.requestBody, 160)}` : ""
          }\n  shape: ${truncate(jsonShape(data), 300)}`
        );
      }
      return ok(`${groups.size} endpoint(s):\n${lines.join("\n")}`);
    }
  );

  server.tool(
    "call_api",
    "Call a JSON endpoint with the browser session's cookies (and auth headers captured for that endpoint). select extracts fields, e.g. items[*].{name,price}.",
    {
      url: z.string(),
      method: z.string().optional().describe("Default GET"),
      query: z.record(z.union([z.string(), z.number()])).optional().describe("Override query params"),
      body: z.string().optional().describe("Request body (JSON string)"),
      headers: z.record(z.string()).optional(),
      select: z.string().optional().describe("Path, e.g. data.items[*].{id,title}"),
      maxChars: z.number().optional(),
    },
    async ({ url, method, query, body, headers, select, maxChars }) => {
      try {
        const u = new URL(resolveSecrets(url));
        for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
        assertAllowed(u.href);
        const m = (method || "GET").toUpperCase();
        // Reuse headers (e.g. bearer tokens set by the site's JS) from a captured call to the same endpoint.
        const tpl = endpointTemplate(m, u.href);
        const seen = browser.getAllApiCalls().filter((c) => endpointTemplate(c.method, c.url) === tpl || new URL(c.url).host === u.host);
        const captured = seen.reverse().find((c) => endpointTemplate(c.method, c.url) === tpl) || seen[0];
        const ctx = await browser.ensureContext();
        const t0 = Date.now();
        const res = await ctx.request.fetch(u.href, {
          method: m,
          headers: { ...(captured?.headers || {}), ...(headers || {}) },
          data: body !== undefined ? resolveSecrets(body) : undefined,
          timeout: 30_000,
        });
        const text = await res.text();
        const ms = Date.now() - t0;
        const data = parse(text);
        let out: string;
        if (data === undefined) out = text;
        else if (select) out = JSON.stringify(selectJson(data, select));
        else out = JSON.stringify(data);
        const max = maxChars ?? 8_000;
        const head = `${res.status()} ${m} ${u.href} · ${ms}ms · ${text.length} bytes${data !== undefined && !select ? ` · shape ${truncate(jsonShape(data), 200)}` : ""}`;
        return (res.ok() ? ok : fail)(`${head}\n${out.length > max ? out.slice(0, max) + `…(truncated, ${out.length} chars; use select or maxChars)` : out}`);
      } catch (e: any) {
        return fail(`call_api failed: ${e.message}`);
      }
    }
  );
}
