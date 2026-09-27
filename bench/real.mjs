// Snapshot size of one real page across servers: node real.mjs <url>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const url = process.argv[2] || "https://pypi.org/project/httpx/";
const CH = process.env.BENCH_CHROME ? [process.env.BENCH_CHROME] : [];
const PROXY = process.env.BENCH_PROXY;
const runs = {
  "browser-mcp": {
    args: [join(here, "../dist/index.js"), "--headless", ...(CH.length ? ["--executable-path", CH[0]] : []), ...(PROXY ? ["--proxy-server", PROXY, "--ignore-https-errors"] : [])],
    steps: [["navigate", { url }], ["snapshot", {}], ["snapshot", { viewportOnly: true }], ["read_page", {}]],
  },
  "playwright-mcp": {
    args: [join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js"), "--headless", "--isolated", "--no-sandbox", ...(CH.length ? ["--executable-path", CH[0]] : []), ...(PROXY ? ["--proxy-server", PROXY, "--ignore-https-errors"] : [])],
    steps: [["browser_navigate", { url }], ["browser_snapshot", {}]],
  },
  "chrome-devtools-mcp": {
    args: [join(dirname(require.resolve("chrome-devtools-mcp/package.json")), "build/src/bin/chrome-devtools-mcp.js"), "--headless", "--isolated", "--no-usage-statistics", "--chrome-arg=--no-sandbox", "--acceptInsecureCerts", ...(CH.length ? ["--executablePath", CH[0]] : []), ...(PROXY ? [`--chrome-arg=--proxy-server=${PROXY}`] : [])],
    steps: [["navigate_page", { pageId: 1, url, timeout: 60000 }], ["take_snapshot", { pageId: 1 }]],
  },
};
for (const [name, r] of Object.entries(runs)) {
  const c = new Client({ name: "real", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: r.args, stderr: "ignore" }));
  const sizes = [];
  for (const [tool, args] of r.steps) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await c.callTool({ name: tool, arguments: args });
      const t = res.content.map((x) => (x.type === "text" ? x.text : "")).join("\n");
      if (res.isError && attempt < 2) continue;
      if (args.url) await new Promise((r) => setTimeout(r, 3000)); // let the page settle before snapshotting
      sizes.push(`${tool}${Object.keys(args).length && !args.url ? JSON.stringify(args) : ""}: ${t.length} chars (~${Math.round(t.length / 4)} tokens)${res.isError ? " ERROR " + t.slice(0, 80) : ""}`);
      break;
    }
  }
  console.log(`${name}\n  ${sizes.join("\n  ")}`);
  await c.close();
}
