// Head-to-head benchmark on a local fixture site (no network needed).
//
//   cd bench && npm install && node compare.mjs            # all servers
//   BENCH_CHROME=/path/to/chrome node compare.mjs          # choose the browser binary
//   node compare.mjs --only browser-mcp                    # one server
//
// Every server gets the same four tasks, driven by the call sequence a competent
// agent would use with *that* server's tools. Success is verified server-side
// (fixture site event log) or by checking the returned data, not by trusting
// tool output. Token estimates use chars/4.
//
// Cost model per task: each tool call is one model turn; every turn re-sends the
// tool schemas plus all previous tool results (no prompt caching). This is what
// an agent loop pays on an uncached API.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, events } from "../test/fixture-server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CHROME = process.env.BENCH_CHROME;
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const tok = (s) => Math.round(s.length / 4);
const text = (r) => (r.content || []).map((c) => (c.type === "text" ? c.text : `[${c.type} ${c.data?.length ?? 0}b]`)).join("\n");

// ─── Servers ─────────────────────────────────────────────────

const SERVERS = {
  "browser-mcp": () => ({
    args: [join(here, "../dist/index.js"), "--headless", "--data-dir", mkdtempSync(join(tmpdir(), "bm-")), ...(CHROME ? ["--executable-path", CHROME] : [])],
  }),
  "playwright-mcp": () => ({
    args: [join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js"), "--headless", "--isolated", "--no-sandbox", ...(CHROME ? ["--executable-path", CHROME] : [])],
  }),
  "chrome-devtools-mcp": () => ({
    args: [
      join(dirname(require.resolve("chrome-devtools-mcp/package.json")), "build/src/bin/chrome-devtools-mcp.js"),
      "--headless", "--isolated", "--no-usage-statistics", "--chrome-arg=--no-sandbox", ...(CHROME ? ["--executablePath", CHROME] : []),
    ],
  }),
};

async function open(name) {
  const c = new Client({ name: "bench", version: "1" });
  const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: SERVERS[name]().args, cwd, stderr: "ignore" }));
  const tools = (await c.listTools()).tools;
  const schemaTokens = tok(JSON.stringify(tools));
  const log = [];
  const call = async (tool, args = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name: tool, arguments: args });
    const out = text(r);
    log.push({ tool, argTokens: tok(JSON.stringify(args)), respTokens: tok(out), ms: Date.now() - t0, error: !!r.isError });
    if (r.isError) throw new Error(`${tool}: ${out.slice(0, 300)}`);
    return out;
  };
  return { c, call, log, schemaTokens, toolCount: tools.length };
}

// ─── Snapshot parsing helpers (each server has its own format) ───

/** Ref of the first line matching `pattern` after the line matching `anchor` (or anywhere). */
function refAfter(snapshot, pattern, anchor, refRe) {
  const lines = snapshot.split("\n");
  let i = 0;
  if (anchor) {
    i = lines.findIndex((l) => anchor.test(l));
    if (i < 0) throw new Error(`anchor not found: ${anchor}`);
  }
  for (; i < lines.length; i++) if (pattern.test(lines[i])) {
    const m = lines[i].match(refRe);
    if (m) return m[1];
  }
  throw new Error(`not found: ${pattern}`);
}
const ours = (s, p, a) => refAfter(s, p, a, /\[((?:f\d+)?e\d+)\]/);
const pw = (s, p, a) => refAfter(s, p, a, /\[ref=([\w]+)\]/);
const cd = (s, p, a) => refAfter(s, p, a, /uid=(\S+)/);

// ─── Tasks ───────────────────────────────────────────────────
// T1 shop:    open a busy store page, dismiss cookie banner, add product 3 to cart, confirm the cart count.
// T2 login:   fill email/password/checkbox/country, submit, confirm the welcome message.
// T3 extract: names + prices of all products on 3 store pages (72 items).
// T4 read:    answer "what makes compositing fast?" from an article.

const PLANS = {
  "browser-mcp": {
    async shop({ call }, base) {
      const snap = await call("navigate", { url: `${base}/shop`, returns: "snapshot" });
      await call("click", { selector: ours(snap, /button "Accept all"/) });
      const r = await call("click", { selector: ours(snap, /button "Add to cart"/, /"Product 3 Pro Max"/) });
      return /Cart \(1\)/.test(r);
    },
    async login({ call }, base) {
      const snap = await call("navigate", { url: `${base}/form.html`, returns: "snapshot" });
      const r = await call("batch", {
        steps: [
          { action: "fill", selector: ours(snap, /textbox "Email"/), text: "me@x.com" },
          { action: "fill", selector: ours(snap, /textbox "Password"/), text: "hunter2" },
          { action: "check", selector: ours(snap, /checkbox "Remember me"/) },
          { action: "select", selector: ours(snap, /combobox "Country"/), text: "USA" },
          { action: "click", selector: ours(snap, /button "Sign in"/) },
        ],
      });
      return /Welcome, me@x.com/.test(r);
    },
    async extract({ call }, base) {
      // Learn once from one example product (values the agent saw on page 1), then run on all pages.
      await call("learn_extractor", { name: "shop", url: `${base}/shop?page=1`, examples: { name: ["Product 1 Pro Max"], price: ["$7.50"] } });
      return call("run_extractor", { name: "shop", urls: [1, 2, 3].map((p) => `${base}/shop?page=${p}`) });
    },
    async read({ call }, base) {
      return call("scrape", { url: `${base}/article.html`, query: "what makes compositing fast" });
    },
  },

  "playwright-mcp": {
    async shop({ call }, base) {
      await call("browser_navigate", { url: `${base}/shop` });
      const snap = await call("browser_snapshot");
      await call("browser_click", { element: "Accept all", target: pw(snap, /button "Accept all"/) });
      await call("browser_click", { element: "Add to cart", target: pw(snap, /button "Add to cart"/, /Product 3 Pro Max/) });
      const r = await call("browser_find", { text: "Cart (" });
      return /Cart \(1\)/.test(r);
    },
    async login({ call }, base) {
      await call("browser_navigate", { url: `${base}/form.html` });
      const snap = await call("browser_snapshot");
      await call("browser_fill_form", {
        fields: [
          { name: "Email", type: "textbox", target: pw(snap, /textbox "Email"/), value: "me@x.com" },
          { name: "Password", type: "textbox", target: pw(snap, /textbox "Password"/), value: "hunter2" },
          { name: "Remember me", type: "checkbox", target: pw(snap, /checkbox "Remember me"/), value: "true" },
          { name: "Country", type: "combobox", target: pw(snap, /combobox "Country"/), value: "USA" },
        ],
      });
      await call("browser_click", { element: "Sign in", target: pw(snap, /button "Sign in"/) });
      const r = await call("browser_find", { text: "Welcome" });
      return /Welcome, me@x.com/.test(r);
    },
    async extract({ call }, base) {
      // Look at page 1 once to learn the structure, then read every page with a small script.
      await call("browser_navigate", { url: `${base}/shop?page=1` });
      await call("browser_snapshot");
      const fn = "() => [...document.querySelectorAll('.card')].map(c => ({name: c.querySelector('.title').innerText, price: c.querySelector('.price').innerText}))";
      const out = [await call("browser_evaluate", { function: fn })];
      for (const p of [2, 3]) {
        await call("browser_navigate", { url: `${base}/shop?page=${p}` });
        out.push(await call("browser_evaluate", { function: fn }));
      }
      return out.join("\n");
    },
    async read({ call }, base) {
      await call("browser_navigate", { url: `${base}/article.html` });
      return call("browser_snapshot");
    },
  },

  "chrome-devtools-mcp": {
    async shop({ call }, base) {
      await call("navigate_page", { pageId: 1, url: `${base}/shop` });
      const snap = await call("take_snapshot", { pageId: 1 });
      await call("click", { pageId: 1, uid: cd(snap, /button "Accept all"/) });
      await call("click", { pageId: 1, uid: cd(snap, /button "Add to cart"/, /Product 3 Pro Max/) });
      const r = await call("take_snapshot", { pageId: 1 });
      return /Cart \(1\)/.test(r);
    },
    async login({ call }, base) {
      await call("navigate_page", { pageId: 1, url: `${base}/form.html` });
      const snap = await call("take_snapshot", { pageId: 1 });
      await call("fill_form", {
        pageId: 1,
        elements: [
          { uid: cd(snap, /textbox "Email"/), value: "me@x.com" },
          { uid: cd(snap, /textbox "Password/), value: "hunter2" },
          { uid: cd(snap, /checkbox .*Remember me/), value: "true" },
          { uid: cd(snap, /combobox "Country"/), value: "USA" },
        ],
      });
      await call("click", { pageId: 1, uid: cd(snap, /button "Sign in"/) });
      const r = await call("wait_for", { pageId: 1, text: ["Welcome"] });
      return /Welcome, me@x.com/.test(r);
    },
    async extract({ call }, base) {
      await call("navigate_page", { pageId: 1, url: `${base}/shop?page=1` });
      await call("take_snapshot", { pageId: 1 });
      const fn = "() => [...document.querySelectorAll('.card')].map(c => ({name: c.querySelector('.title').innerText, price: c.querySelector('.price').innerText}))";
      const out = [await call("evaluate_script", { pageId: 1, function: fn })];
      for (const p of [2, 3]) {
        await call("navigate_page", { pageId: 1, url: `${base}/shop?page=${p}` });
        out.push(await call("evaluate_script", { pageId: 1, function: fn }));
      }
      return out.join("\n");
    },
    async read({ call }, base) {
      await call("navigate_page", { pageId: 1, url: `${base}/article.html` });
      return call("take_snapshot", { pageId: 1 });
    },
  },
};

// ─── Runner ──────────────────────────────────────────────────

function cost(log, schemaTokens) {
  const PROMPT = 60; // task instruction
  let context = PROMPT;
  let input = 0;
  for (const e of log) {
    input += schemaTokens + context; // the turn that decides this call
    context += e.argTokens + e.respTokens;
  }
  input += schemaTokens + context; // final answer turn
  return input;
}

const CHECKS = {
  shop: (ok) => ok && events.some((e) => e.type === "cart" && e.id === "3"),
  login: (ok) => ok && events.some((e) => e.type === "login" && e.email === "me@x.com" && e.pw === "hunter2" && e.remember === "true" && e.country === "USA"),
  extract: (out) => [1, 24, 25, 48, 49, 72].every((i) => out.includes(`Product ${i} Pro Max`)) && out.includes("540.00"),
  read: (out) => /GPU acceleration/.test(out),
};

const { server, base } = await startFixtureServer();
const results = [];
for (const name of Object.keys(SERVERS)) {
  if (only && name !== only) continue;
  for (const task of Object.keys(CHECKS)) {
    events.length = 0;
    let s;
    try {
      s = await open(name);
    } catch (e) {
      results.push({ server: name, task, error: `could not start: ${e.message}` });
      continue;
    }
    const t0 = Date.now();
    let success = false;
    let error;
    try {
      const out = await PLANS[name][task](s, base);
      await new Promise((r) => setTimeout(r, 300)); // let beacons land
      success = CHECKS[task](out);
    } catch (e) {
      error = e.message;
    }
    const ms = Date.now() - t0;
    results.push({
      server: name,
      task,
      success,
      error,
      calls: s.log.length,
      respTokens: s.log.reduce((a, e) => a + e.respTokens, 0),
      inputTokens: cost(s.log, s.schemaTokens),
      schemaTokens: s.schemaTokens,
      tools: s.toolCount,
      ms,
    });
    await s.c.close().catch(() => {});
    process.stderr.write(`${name} ${task}: ${success ? "ok" : "FAIL"}${error ? " " + error : ""}\n`);
  }
}
server.close();

// ─── Report ──────────────────────────────────────────────────
const rows = [["server", "task", "ok", "calls", "result tokens", "est. input tokens", "time (ms)"]];
for (const r of results) rows.push([r.server, r.task, r.success ? "✓" : "✗", r.calls ?? "-", r.respTokens ?? "-", r.inputTokens ?? "-", r.ms ?? "-"]);
const totals = {};
for (const r of results) {
  const t = (totals[r.server] ||= { ok: 0, n: 0, calls: 0, resp: 0, input: 0, ms: 0, schema: r.schemaTokens, tools: r.tools });
  t.n++;
  t.ok += r.success ? 1 : 0;
  t.calls += r.calls || 0;
  t.resp += r.respTokens || 0;
  t.input += r.inputTokens || 0;
  t.ms += r.ms || 0;
}
const md = [
  "| " + rows[0].join(" | ") + " |",
  "|" + rows[0].map(() => "---").join("|") + "|",
  ...rows.slice(1).map((r) => "| " + r.join(" | ") + " |"),
  "",
  "| server | tools | schema tokens | success | calls | result tokens | est. input tokens | time (ms) |",
  "|---|---|---|---|---|---|---|---|",
  ...Object.entries(totals).map(([k, t]) => `| ${k} | ${t.tools} | ${t.schema} | ${t.ok}/${t.n} | ${t.calls} | ${t.resp} | ${t.input} | ${t.ms} |`),
].join("\n");
console.log(md);
writeFileSync(join(here, "results.md"), md + "\n");
writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 1));
