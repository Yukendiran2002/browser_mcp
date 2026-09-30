import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
const require = createRequire(import.meta.url);
const c = new Client({ name: "real", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(dirname(require.resolve("chrome-devtools-mcp/package.json")), "build/src/bin/chrome-devtools-mcp.js"), "--headless", "--isolated", "--no-usage-statistics", "--chrome-arg=--no-sandbox", "--acceptInsecureCerts", "--executablePath", process.env.BENCH_CHROME, `--chrome-arg=--proxy-server=${process.env.BENCH_PROXY}`], stderr: "ignore" }));
for (let i = 0; i < 3; i++) {
  const n = await c.callTool({ name: "navigate_page", arguments: { pageId: 1, url: "https://pypi.org/project/httpx/", timeout: 60000 } });
  console.log(n.content[0].text.slice(0, 200));
  await new Promise(r => setTimeout(r, 3000));
  const s = await c.callTool({ name: "take_snapshot", arguments: { pageId: 1 } });
  const t = s.content.map(x => x.text || "").join("\n");
  console.log(t.length, t.slice(0, 300));
  if (t.length > 2000) break;
}
await c.close();
