// End-to-end: a real MCP client drives the server over stdio against a local fixture site.
// Needs a Chromium: uses BROWSER_EXECUTABLE_PATH if set, else Playwright's bundled browser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFixtureServer } from "./fixture-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let site, client;

const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, `${name} failed: ${text(r)}`);
  return text(r);
}

before(async () => {
  site = await startFixtureServer();
  const tmp = mkdtempSync(join(tmpdir(), "bmcp-"));
  writeFileSync(join(tmp, "secrets.env"), "DEMO_PASSWORD=s3cr3t-value\n");
  const args = [
    join(root, "dist/index.js"), "--headless", "--data-dir", tmp, "--secrets", join(tmp, "secrets.env"),
    "--max-response", "6000", "--output-dir", join(tmp, "out"), "--blocked-domains", "blocked.example",
    "--tools", "core,scrape,macros,devtools",
  ];
  if (process.env.BROWSER_EXECUTABLE_PATH) args.push("--executable-path", process.env.BROWSER_EXECUTABLE_PATH);
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, stderr: "ignore" }));
});

after(async () => {
  await client?.close();
  site?.server.close();
});

test("toolset is small", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.length <= 30, `${tools.length} tools`);
  for (const t of ["snapshot", "batch", "scrape", "learn_extractor", "run_extractor"]) assert.ok(tools.some((x) => x.name === t), t);
});

test("snapshot refs, action diffs, batch, iframes", async () => {
  const snap = await call("navigate", { url: `${site.base}/form.html`, returns: "snapshot" });
  assert.match(snap, /textbox "Email" \[e\d+\] \(required\)/);
  assert.match(snap, /combobox "Country" \[e\d+\] ="India"/);
  const email = snap.match(/textbox "Email" \[(e\d+)\]/)[1];

  const typed = await call("type_text", { selector: email, text: "me@x.com" });
  assert.match(typed, /\+ - textbox "Email" \[e\d+\] ="me@x.com"/);

  const menu = await call("click", { selector: "Open menu" });
  assert.match(menu, /\+ - link "Settings"/);

  const out = await call("batch", {
    steps: [
      { action: "fill", selector: "#pw", text: "hunter2" },
      { action: "check", selector: "Remember me" },
      { action: "select", selector: "Country", value: "USA" },
      { action: "click", selector: "button[type=submit]" },
      { action: "wait", text: "Welcome" },
    ],
  });
  assert.match(out, /5\. ✓/);
  assert.ok(!out.includes("hunter2"), "password must not be echoed");
  assert.match(out, /status "Welcome, me@x.com"/);

  const again = await call("snapshot");
  const frameRef = again.match(/button "Frame button" \[(f\d+e\d+)\]/)[1];
  assert.match(await call("click", { selector: frameRef }), /button "clicked"/);
});

test("read_page returns markdown of the current tab", async () => {
  assert.match(await call("read_page"), /Welcome, me@x.com/);
});

test("scrape uses HTTP when possible and a browser when needed", async () => {
  const fast = await call("scrape", { url: `${site.base}/article.html`, query: "GPU compositing" });
  assert.match(fast, /via http/);
  assert.match(fast, /GPU acceleration/);
  const spa = await call("scrape", { url: `${site.base}/spa.html` });
  assert.match(spa, /via browser/);
  assert.match(spa, /Alpha report/);
  // Background scraping must not add tabs to the agent's session.
  const tabs = await call("tabs");
  assert.equal(tabs.trim().split("\n").length, 1, tabs);
});

test("learn once, extract across paginated pages", async () => {
  const learned = await call("learn_extractor", {
    name: "shop",
    url: `${site.base}/list?page=1`,
    examples: { name: ["Item 1"], price: ["$19.00"] },
  });
  assert.match(learned, /Preview: 3 records/);
  const run = await call("run_extractor", { name: "shop", url: `${site.base}/list?page=1`, followPages: 5 });
  assert.match(run, /Extracted 9 item\(s\)/);
  assert.match(run, /"name":"Item 9"/);
});

test("crawl respects robots.txt and applies extractors", async () => {
  const out = await call("crawl", { url: `${site.base}/`, maxPages: 5, maxDepth: 1, extractor: "shop" });
  assert.match(out, /blocked by robots\.txt/);
  assert.match(out, /list\?page=1 \(3 records\)/);
});

test("map_site reads sitemaps", async () => {
  const out = await call("map_site", { url: `${site.base}/` });
  assert.match(out, /sitemap\.xml/);
  assert.match(out, /products\.html/);
});

test("snapshot find and root scoping", async () => {
  await call("navigate", { url: `${site.base}/form.html` });
  const found = await call("snapshot", { find: "Remember" });
  assert.match(found, /1 match/);
  assert.match(found, /## form "login"\n\s+- checkbox "Remember me"/);
  const scoped = await call("snapshot", { root: "form" });
  assert.ok(!scoped.includes('link "Home"'));
});

test("secrets are typed but never returned", async () => {
  await call("navigate", { url: `${site.base}/form.html` });
  await call("type_text", { selector: "#pw", text: "{{secret.DEMO_PASSWORD}}" });
  const v = await call("evaluate_javascript", { script: "document.getElementById('pw').value" });
  assert.equal(v, "{{secret.DEMO_PASSWORD}}");
});

test("macros record refs as stable selectors and replay with variables", async () => {
  const snap = await call("navigate", { url: `${site.base}/form.html`, returns: "snapshot" });
  await call("macro", { action: "clear" });
  const email = snap.match(/textbox "Email" \[(e\d+)\]/)[1];
  const btn = snap.match(/button "Sign in" \[(e\d+)\]/)[1];
  await call("batch", { steps: [{ action: "fill", selector: email, text: "first@x.com" }, { action: "click", selector: btn }] });
  const saved = await call("macro", { action: "save", name: "signin", params: { email: "first@x.com" } });
  assert.match(saved, /"selector":"#email","text":"\{\{email\}\}"/);
  await call("navigate", { url: `${site.base}/form.html` });
  await call("macro", { action: "run", name: "signin", vars: { email: "second@x.com" } });
  assert.match(await call("read_page"), /Welcome, second@x.com/);
});

test("screenshots can be skipped when unchanged", async () => {
  await call("take_screenshot", { ifChanged: true });
  assert.match(await call("take_screenshot", { ifChanged: true }), /unchanged/);
});

test("captured JSON APIs can be called directly with the session's auth headers", async () => {
  await call("navigate", { url: `${site.base}/app.html` });
  await call("wait_for", { text: "Widget 4" });
  const apis = await call("list_apis");
  assert.match(apis, /GET 127\.0\.0\.1:\d+\/api\/products\?page= .*auth header/);
  assert.match(apis, /items:\[4\]\{id:num,name:str,price:num/);
  const r = await call("call_api", { url: `${site.base}/api/products`, query: { page: 3 }, select: "items[*].name" });
  assert.match(r, /\["Widget 9","Widget 10","Widget 11","Widget 12"\]/);
});

test("scrape handles PDFs and infinite scroll", async () => {
  const pdf = await call("scrape", { url: `${site.base}/report.pdf`, query: "supply chain" });
  assert.match(pdf, /Supply chain delays/);
  const feed = await call("scrape", { url: `${site.base}/feed.html`, scroll: 5, maxChars: 20000 });
  assert.match(feed, /Post number 25/);
});

test("CSS schema extraction", async () => {
  const out = await call("extract_structured", {
    url: `${site.base}/products.html`,
    schema: { baseSelector: ".product", fields: [{ name: "name", selector: "h2" }, { name: "price", selector: ".price", type: "number" }] },
  });
  assert.match(out, /4 record\(s\)/);
  assert.match(out, /\{"name":"Google Pixel 8","price":699\}/);
});

test("blocked domains are refused", async () => {
  const r = await client.callTool({ name: "navigate", arguments: { url: "https://blocked.example/" } });
  assert.ok(r.isError);
  assert.match(text(r), /blocked by --blocked-domains/);
});

test("oversized results spill to a file", async () => {
  const r = await call("scrape", { url: `${site.base}/shop`, maxChars: 50000, mainContent: false });
  const m = r.match(/Full output: (\S+\.md)\]/);
  assert.ok(m, "expected spill note");
  assert.ok(readFileSync(m[1], "utf8").length > 6000);
});

test("page_metrics reports vitals", async () => {
  await call("navigate", { url: `${site.base}/products.html` });
  assert.match(await call("page_metrics"), /TTFB \d+ms · FCP/);
});

test("busy page snapshot stays compact", async () => {
  const snap = await call("navigate", { url: `${site.base}/shop`, returns: "snapshot" });
  assert.match(snap, /link "Product 3 Pro Max" \[e\d+\] \(h3\)/);
  assert.ok(!/link "Product 3" \[/.test(snap), "thumbnail link duplicates the title link");
  assert.match(snap, /more footer links/);
  const click = await call("click", { selector: snap.match(/button "Accept all" \[(e\d+)\]/)[1] });
  assert.match(click, /- - button "Accept all"/);
});
