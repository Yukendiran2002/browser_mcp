#!/usr/bin/env node

/**
 * Browser MCP Server
 *
 * A Model Context Protocol server that lets AI agents interact with a
 * real browser — including reusing existing logged-in sessions.
 *
 * Usage:
 *   node dist/index.js                          # auto-detect (CDP → temp browser)
 *   node dist/index.js --cdp http://localhost:9222   # attach to running Chrome
 *   node dist/index.js --user-data-dir "C:/Users/you/AppData/Local/Google/Chrome/User Data"
 */

import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { BrowserManager, BrowserConnectionOptions } from "./browser-manager.js";
import { registerTools } from "./tools.js";
import { registerCoreTools } from "./tools/core.js";
import { registerScrapeTools } from "./tools/scrape.js";
import { registerResources } from "./resources.js";
import { Scraper } from "./scraper.js";
import { ExtractorStore } from "./extractor-store.js";
import { setHumanMode } from "./human.js";
import { filteredServer, resolveToolFilter, TOOL_GROUPS } from "./toolsets.js";
import { registerApiTools } from "./tools/apis.js";
import { registerDevtoolsTools } from "./tools/devtools.js";
import { MacroStore } from "./macros.js";
import { govern, configureGovernor, loadSecrets, secretNames } from "./governor.js";
import { configurePolicy } from "./policy.js";

export const VERSION = "3.0.0";

interface ServerConfig {
  tools?: string;
  dataDir?: string;
  cacheTtlMs?: number;
  poolSize?: number;
  blockResources?: boolean;
  httpPort?: number;
  httpHost?: string;
  token?: string;
  secrets?: string;
  maxResponse?: number;
  outputDir?: string;
  allowedDomains?: string;
  blockedDomains?: string;
  idleTimeoutSec?: number;
  searchUrl?: string;
}

const INSTRUCTIONS = `Browser + scraping tools. To keep cost low:
- Reading/scraping: web_search (scrape=N reads top results), scrape (HTTP fast path, many URLs per call) or read_page for the current tab; pass query= to get only relevant sections. Avoid screenshots unless you need pixels.
- Interacting: call snapshot once (find= to search it), then use its refs (e.g. e12) as selector. Actions return only what changed. Chain steps with batch.
- Data behind a page is often a JSON API: after browsing, list_apis then call_api (next pages, other queries) instead of re-rendering.
- Repeated work: learn_extractor once from 1-2 example values, then run_extractor/crawl extractor= on any number of pages; save interaction flows with macro save and replay them with macro run — no LLM tokens per page.`;

// ─── Parse CLI args ──────────────────────────────────────────

function parseArgs(): { options: BrowserConnectionOptions; config: ServerConfig } {
  const args = process.argv.slice(2);
  const options: BrowserConnectionOptions = {};
  const config: ServerConfig = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--cdp":
        options.cdpUrl = args[++i];
        break;
      case "--user-data-dir":
        options.userDataDir = args[++i];
        break;
      case "--executable-path":
        options.executablePath = args[++i];
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--timeout":
        options.defaultTimeout = parseInt(args[++i], 10);
        break;
      case "--browser":
        options.browser = args[++i] as "chromium" | "firefox" | "webkit";
        break;
      case "--channel":
        options.channel = args[++i];
        break;
      case "--proxy-server":
        options.proxyServer = args[++i];
        break;
      case "--proxy-bypass":
        options.proxyBypass = args[++i];
        break;
      case "--viewport": {
        const [w, h] = args[++i].split("x").map(Number);
        options.viewportWidth = w;
        options.viewportHeight = h;
        break;
      }
      case "--device":
        options.device = args[++i];
        break;
      case "--record-video":
        options.recordVideo = true;
        break;
      case "--video-dir":
        options.videoDir = args[++i];
        break;
      case "--geolocation": {
        const [lat, lng] = args[++i].split(",").map(Number);
        options.geolocation = { latitude: lat, longitude: lng };
        break;
      }
      case "--permissions":
        options.permissions = args[++i].split(",");
        break;
      case "--user-agent":
        options.userAgent = args[++i];
        break;
      case "--locale":
        options.locale = args[++i];
        break;
      case "--timezone":
        options.timezoneId = args[++i];
        break;
      case "--color-scheme":
        options.colorScheme = args[++i] as "light" | "dark" | "no-preference";
        break;
      case "--storage-state":
        options.storageState = args[++i];
        break;
      case "--ignore-https-errors":
        options.ignoreHTTPSErrors = true;
        break;
      case "--block-service-workers":
        options.blockServiceWorkers = true;
        break;
      case "--human":
        options.human = true;
        break;
      case "--tools":
        config.tools = args[++i];
        break;
      case "--data-dir":
        config.dataDir = args[++i];
        break;
      case "--cache-ttl":
        config.cacheTtlMs = parseInt(args[++i], 10) * 1000;
        break;
      case "--pool-size":
        config.poolSize = parseInt(args[++i], 10);
        break;
      case "--no-block-resources":
        config.blockResources = false;
        break;
      case "--http":
        config.httpPort = parseInt(args[++i], 10);
        break;
      case "--host":
        config.httpHost = args[++i];
        break;
      case "--token":
        config.token = args[++i];
        break;
      case "--secrets":
        config.secrets = args[++i];
        break;
      case "--max-response":
        config.maxResponse = parseInt(args[++i], 10);
        break;
      case "--output-dir":
        config.outputDir = args[++i];
        break;
      case "--allowed-domains":
        config.allowedDomains = args[++i];
        break;
      case "--blocked-domains":
        config.blockedDomains = args[++i];
        break;
      case "--idle-timeout":
        config.idleTimeoutSec = parseInt(args[++i], 10);
        break;
      case "--search-url":
        config.searchUrl = args[++i];
        break;
      case "--help":
        console.error(`
Browser MCP Server v${VERSION} — fast, token-efficient browsing and scraping for AI agents

TOOLS:
  --tools <list>              Tool groups or names (default: core,scrape). "all" enables everything.
                              Groups: ${Object.keys(TOOL_GROUPS).join(", ")}
  --human                     Human-like mouse/typing timing (slower, stealthier; default: fast)

SCRAPING:
  --data-dir <path>           Where learned extractors are stored (default: ~/.browser-mcp)
  --cache-ttl <seconds>       Page cache lifetime (default: 300)
  --pool-size <n>             Background browser tabs for scraping (default: 4)
  --no-block-resources        Load images/fonts/media when scraping in the browser

TRANSPORT:
  --http <port>               Serve MCP over Streamable HTTP at http://host:port/mcp (default: stdio)
  --host <addr>               Bind address for --http (default: 127.0.0.1)
  --token <secret>            Require "Authorization: Bearer <secret>" for --http

SAFETY & COST:
  --secrets <file.env>        Secrets typed as {{secret.NAME}}; values never appear in responses
  --max-response <chars>      Larger results are saved to a file, only the head is returned (default 25000, 0 = off)
  --output-dir <path>         Where oversized results are written (default: OS temp dir)
  --allowed-domains <list>    Only these domains (e.g. "example.com,*.example.org")
  --blocked-domains <list>    Never these domains
  --idle-timeout <seconds>    Close a launched browser after inactivity (default 1800, 0 = never)
  --search-url <url>          SearXNG instance for web_search (default: DuckDuckGo; BRAVE_API_KEY uses Brave)

CONNECTION:
  --cdp <url>                 Connect via Chrome DevTools Protocol (e.g. http://localhost:9222)
  --user-data-dir <path>      Launch browser with user profile for session reuse
  --executable-path <path>    Path to Chrome/Edge/Firefox executable

BROWSER:
  --browser <engine>          Browser engine: chromium, firefox, webkit (default: chromium)
  --channel <channel>         Use installed browser: chrome, msedge, chrome-beta, msedge-dev
  --headless                  Run browser in headless mode
  --timeout <ms>              Default action timeout (default: 30000)

VIEWPORT & DEVICE:
  --viewport <WxH>            Viewport size, e.g. 1920x1080
  --device <name>             Emulate device: "iPhone 15", "Pixel 7", "iPad Pro 11"

NETWORK:
  --proxy-server <url>        Proxy URL (http://proxy:8080 or socks5://proxy:1080)
  --proxy-bypass <domains>    Comma-separated domains to bypass proxy
  --ignore-https-errors       Ignore HTTPS certificate errors
  --block-service-workers     Block service workers

CONTEXT:
  --user-agent <string>       Custom user agent string
  --locale <locale>           Browser locale (e.g. en-US, fr-FR)
  --timezone <tz>             Timezone ID (e.g. America/New_York)
  --color-scheme <scheme>     Color scheme: light, dark, no-preference
  --geolocation <lat,lng>     Override geolocation (e.g. 40.7128,-74.0060)
  --permissions <list>        Comma-separated permissions to grant

SESSION:
  --storage-state <path>      Load cookies & localStorage from JSON file

VIDEO:
  --record-video              Record browser session video
  --video-dir <path>          Directory for recorded videos (default: ./videos)

ENVIRONMENT VARIABLES:
  BROWSER_CDP_URL             Same as --cdp
  BROWSER_USER_DATA_DIR       Same as --user-data-dir
  BROWSER_EXECUTABLE_PATH     Same as --executable-path
  BROWSER_ENGINE              Same as --browser
  BROWSER_PROXY               Same as --proxy-server
  BROWSER_MCP_TOOLS           Same as --tools
  BROWSER_MCP_DATA_DIR        Same as --data-dir
  BROWSER_MCP_TOKEN           Same as --token
  BROWSER_HUMAN=1             Same as --human

Examples:
  # Auto-detect running Chrome on port 9222, or launch temp browser
  node dist/index.js

  # Attach to existing Chrome with remote debugging
  chrome --remote-debugging-port=9222
  node dist/index.js --cdp http://localhost:9222

  # Reuse an existing Chrome profile (keeps cookies, logins, etc.)
  node dist/index.js --user-data-dir "C:\\Users\\you\\AppData\\Local\\Google\\Chrome\\User Data"

  # Launch Firefox with device emulation and proxy
  node dist/index.js --browser firefox --device "iPhone 15" --proxy-server http://proxy:8080

  # Launch with geolocation override (New York)
  node dist/index.js --geolocation 40.7128,-74.0060 --timezone America/New_York
`);
        process.exit(0);
    }
  }

  // Also check environment variables
  if (!options.cdpUrl && process.env.BROWSER_CDP_URL) {
    options.cdpUrl = process.env.BROWSER_CDP_URL;
  }
  if (!options.userDataDir && process.env.BROWSER_USER_DATA_DIR) {
    options.userDataDir = process.env.BROWSER_USER_DATA_DIR;
  }
  if (!options.executablePath && process.env.BROWSER_EXECUTABLE_PATH) {
    options.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
  }
  if (!options.browser && process.env.BROWSER_ENGINE) {
    options.browser = process.env.BROWSER_ENGINE as "chromium" | "firefox" | "webkit";
  }
  if (!options.proxyServer && process.env.BROWSER_PROXY) {
    options.proxyServer = process.env.BROWSER_PROXY;
  }
  if (!options.headless && process.env.BROWSER_HEADLESS === "1") options.headless = true;
  if (!options.human && process.env.BROWSER_HUMAN === "1") options.human = true;
  config.tools ??= process.env.BROWSER_MCP_TOOLS;
  config.dataDir ??= process.env.BROWSER_MCP_DATA_DIR;
  config.token ??= process.env.BROWSER_MCP_TOKEN;
  config.secrets ??= process.env.BROWSER_MCP_SECRETS;
  config.searchUrl ??= process.env.BROWSER_MCP_SEARCH_URL;
  config.allowedDomains ??= process.env.BROWSER_MCP_ALLOWED_DOMAINS;
  config.blockedDomains ??= process.env.BROWSER_MCP_BLOCKED_DOMAINS;

  return { options, config };
}

// ─── Main ────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  const { options, config } = parseArgs();
  const browserManager = new BrowserManager(options);
  if (options.human) setHumanMode(true);
  const scraper = new Scraper(browserManager, {
    cacheTtlMs: config.cacheTtlMs,
    poolSize: config.poolSize,
    blockResources: config.blockResources,
  });
  const store = new ExtractorStore(config.dataDir);
  const macros = new MacroStore(config.dataDir);
  const allow = resolveToolFilter(config.tools);
  const nSecrets = loadSecrets(config.secrets);
  configureGovernor({ maxChars: config.maxResponse, outputDir: config.outputDir });
  configurePolicy(config.allowedDomains, config.blockedDomains);
  browserManager.setIdleTimeout((config.idleTimeoutSec ?? 1800) * 1000);
  const searchCfg = { searxUrl: config.searchUrl, braveKey: process.env.BRAVE_API_KEY };
  const instructions = INSTRUCTIONS + (nSecrets ? `\n- Secrets available (type them as {{secret.NAME}}): ${secretNames().join(", ")}` : "");

  /** One MCP server per client session; all share the browser, scraper and store. */
  const buildServer = () => {
    const server = new McpServer({ name: "browser-mcp-server", version: VERSION }, { instructions });
    const filtered = filteredServer(server, allow, govern);
    registerCoreTools(filtered, browserManager, macros);
    registerScrapeTools(filtered, browserManager, scraper, store, searchCfg);
    registerApiTools(filtered, browserManager);
    registerDevtoolsTools(filtered, browserManager);
    registerTools(filtered, browserManager);
    registerResources(server, browserManager);
    return server;
  };

  const shutdown = async () => {
    console.error("[browser-mcp] Shutting down…");
    await scraper.close();
    await browserManager.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (config.httpPort) {
    const host = config.httpHost || "127.0.0.1";
    const port = config.httpPort;
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!loopback && !config.token) {
      console.error("[browser-mcp] WARNING: listening on a non-loopback address without --token; anyone who can reach it controls the browser.");
    }
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const tokenBuf = config.token ? Buffer.from(`Bearer ${config.token}`) : null;
    const http = createHttpServer(async (req, res) => {
      try {
        const path = (req.url || "/").split("?")[0];
        if (path === "/health") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, version: VERSION, sessions: sessions.size }));
          return;
        }
        if (path !== "/mcp") {
          res.writeHead(404).end();
          return;
        }
        if (tokenBuf) {
          const auth = Buffer.from(String(req.headers.authorization || ""));
          if (auth.length !== tokenBuf.length || !timingSafeEqual(auth, tokenBuf)) {
            res.writeHead(401, { "www-authenticate": "Bearer" }).end();
            return;
          }
        }
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const sid = req.headers["mcp-session-id"] as string | undefined;
        let transport = sid ? sessions.get(sid) : undefined;
        if (!transport) {
          if (req.method !== "POST" || sid || !isInitializeRequest(body)) {
            res.writeHead(400, { "content-type": "application/json" }).end(
              JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad request: no valid session" }, id: null })
            );
            return;
          }
          const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, t);
            },
            ...(loopback ? { enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`] } : {}),
          });
          t.onclose = () => {
            if (t.sessionId) sessions.delete(t.sessionId);
          };
          await buildServer().connect(t);
          transport = t;
        }
        await transport.handleRequest(req, res, body);
      } catch (err: any) {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
      }
    });
    http.listen(port, host, () => console.error(`[browser-mcp] v${VERSION} listening on http://${host}:${port}/mcp`));
    return;
  }

  await buildServer().connect(new StdioServerTransport());
  console.error(`[browser-mcp] v${VERSION} started on stdio (tools: ${config.tools || "core,scrape"})`);
}

main().catch((err) => {
  console.error("[browser-mcp] Fatal error:", err);
  process.exit(1);
});
