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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BrowserManager, BrowserConnectionOptions } from "./browser-manager.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

// ─── Parse CLI args ──────────────────────────────────────────

function parseArgs(): BrowserConnectionOptions {
  const args = process.argv.slice(2);
  const options: BrowserConnectionOptions = {};

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
      case "--help":
        console.error(`
Browser MCP Server v2.0 — let AI agents drive a real browser with human-like behavior

CONNECTION:
  --cdp <url>                 Connect via Chrome DevTools Protocol (e.g. http://localhost:9222)
  --user-data-dir <path>      Launch browser with user profile for session reuse
  --executable-path <path>    Path to Chrome/Edge/Firefox executable

BROWSER:
  --browser <engine>          Browser engine: chromium, firefox, webkit (default: chromium)
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

  return options;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const options = parseArgs();
  const browserManager = new BrowserManager(options);

  // Create MCP server
  const server = new McpServer({
    name: "browser-mcp-server",
    version: "2.0.0",
  });

  // Register all tools & resources
  registerTools(server, browserManager);
  registerResources(server, browserManager);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.error("[browser-mcp] Shutting down…");
    await browserManager.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await browserManager.close();
    process.exit(0);
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[browser-mcp] Server started — listening on stdio");
  console.error(`[browser-mcp] Config: ${JSON.stringify(options)}`);
}

main().catch((err) => {
  console.error("[browser-mcp] Fatal error:", err);
  process.exit(1);
});
