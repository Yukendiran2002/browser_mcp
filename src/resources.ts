import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "./browser-manager.js";

/**
 * Register MCP resources so agents can inspect browser state declaratively.
 */
export function registerResources(server: McpServer, browser: BrowserManager): void {
  // Dynamic resource: current page info
  server.resource(
    "current-page",
    "browser://current-page",
    {
      description: "Information about the currently active browser page (URL, title)",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const { id, page } = await browser.getOrCreatePage();
        const title = await page.title();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ pageId: id, url: page.url(), title }, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "No active page" }),
            },
          ],
        };
      }
    }
  );

  // Dynamic resource: open pages list
  server.resource(
    "open-pages",
    "browser://open-pages",
    {
      description: "List of all open browser pages/tabs",
      mimeType: "application/json",
    },
    async (uri) => {
      const pages = await browser.listPagesWithTitles();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(pages, null, 2),
          },
        ],
      };
    }
  );

  // Dynamic resource: cookies
  server.resource(
    "cookies",
    "browser://cookies",
    {
      description: "All cookies in the current browser context",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const ctx = browser.getContext();
        const cookies = await ctx.cookies();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(cookies, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "No browser context" }),
            },
          ],
        };
      }
    }
  );

  // Dynamic resource: console logs
  server.resource(
    "console-logs",
    "browser://console-logs",
    {
      description: "Console log messages from the active page (auto-captured)",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const { id } = await browser.getOrCreatePage();
        const logs = browser.getConsoleLogs(id);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(logs.slice(-100), null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "No active page" }),
            },
          ],
        };
      }
    }
  );

  // Dynamic resource: network log
  server.resource(
    "network-log",
    "browser://network-log",
    {
      description: "Network request/response log from the active page (auto-captured)",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const { id } = await browser.getOrCreatePage();
        const logs = browser.getNetworkLogs(id);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(logs.slice(-100), null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "No active page" }),
            },
          ],
        };
      }
    }
  );

  // Dynamic resource: browser info
  server.resource(
    "browser-info",
    "browser://browser-info",
    {
      description: "Browser configuration and connection details",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const info = browser.getBrowserInfo();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(info, null, 2),
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Browser not connected" }),
            },
          ],
        };
      }
    }
  );
}
