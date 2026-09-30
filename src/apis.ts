/**
 * API discovery: most sites load their data from JSON endpoints. Capturing those
 * responses while the agent browses lets it call the endpoint directly next time
 * (next page, other query) — no rendering, no DOM, a fraction of the tokens.
 */

import type { Page, Response } from "playwright";

export interface ApiCall {
  method: string;
  url: string;
  status: number;
  size: number;
  contentType: string;
  requestBody?: string;
  /** Request headers worth replaying (auth tokens, custom x-* headers). Never shown to the model. */
  headers: Record<string, string>;
  body: string;
  at: number;
}

const MAX_BODY = 2_000_000;
const KEEP_HEADERS = /^(authorization|x-[\w-]+|content-type|accept|apollographql-[\w-]+)$/i;

/** Start capturing JSON XHR/fetch responses of a page into `store`. */
export function captureApis(page: Page, store: ApiCall[]): void {
  page.on("response", async (res: Response) => {
    try {
      const req = res.request();
      const type = req.resourceType();
      if (type !== "xhr" && type !== "fetch") return;
      const ct = res.headers()["content-type"] || "";
      if (!/json|graphql/i.test(ct)) return;
      const len = parseInt(res.headers()["content-length"] || "0", 10);
      if (len > MAX_BODY) return;
      const body = await res.text();
      if (body.length > MAX_BODY) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(await req.allHeaders())) if (KEEP_HEADERS.test(k)) headers[k] = v;
      const entry: ApiCall = {
        method: req.method(),
        url: req.url(),
        status: res.status(),
        size: body.length,
        contentType: ct,
        requestBody: req.postData() ?? undefined,
        headers,
        body,
        at: Date.now(),
      };
      // Keep the latest call per method+url+body.
      const key = (c: ApiCall) => `${c.method} ${c.url} ${c.requestBody ?? ""}`;
      const i = store.findIndex((c) => key(c) === key(entry));
      if (i >= 0) store.splice(i, 1);
      store.push(entry);
      if (store.length > 150) store.shift();
    } catch {
      /* body unavailable (navigation, redirect) */
    }
  });
}

/** "/api/items/123?page=2" → "/api/items/{id}?page=" — groups calls to the same endpoint. */
export function endpointTemplate(method: string, url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? "{id}" : seg))
      .join("/");
    const q = [...u.searchParams.keys()].map((k) => `${k}=`).join("&");
    return `${method} ${u.host}${path}${q ? "?" + q : ""}`;
  } catch {
    return `${method} ${url}`;
  }
}

/** Compact structural summary of JSON: {items:[24]{id:num,name:str},total:num}. */
export function jsonShape(v: any, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[${v.length}]${depth < 4 ? jsonShape(v[0], depth + 1) : ""}`;
  }
  switch (typeof v) {
    case "string":
      return "str";
    case "number":
      return "num";
    case "boolean":
      return "bool";
    case "object": {
      if (depth >= 4) return "{…}";
      const keys = Object.keys(v);
      const parts = keys.slice(0, 12).map((k) => `${k}:${jsonShape(v[k], depth + 1)}`);
      return `{${parts.join(",")}${keys.length > 12 ? `,…+${keys.length - 12}` : ""}}`;
    }
    default:
      return typeof v;
  }
}

/**
 * Tiny path selector: "data.items[*].name", "items[0]", "items[*].{name,price}", "results[*]".
 * Enough to pull just the fields an agent needs out of a large payload.
 */
export function selectJson(data: any, path: string): any {
  const tokens = path.match(/\{[^}]*\}|\[\*\]|\[\d+\]|[^.[\]{}]+/g) || [];
  let cur: any[] = [data];
  let spread = false;
  for (const t of tokens) {
    const next: any[] = [];
    for (const v of cur) {
      if (v == null) continue;
      if (t === "[*]") {
        spread = true;
        if (Array.isArray(v)) next.push(...v);
        else if (typeof v === "object") next.push(...Object.values(v));
      } else if (/^\[\d+\]$/.test(t)) {
        next.push(v[parseInt(t.slice(1), 10)]);
      } else if (t.startsWith("{")) {
        const keys = t.slice(1, -1).split(",").map((k) => k.trim()).filter(Boolean);
        const o: any = {};
        for (const k of keys) o[k] = selectPath(v, k);
        next.push(o);
      } else {
        next.push(v[t]);
      }
    }
    cur = next;
  }
  return spread ? cur : cur[0];
}

function selectPath(v: any, path: string): any {
  let cur = v;
  for (const k of path.split(".")) cur = cur == null ? undefined : cur[k];
  return cur;
}
