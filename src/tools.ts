import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserManager } from "./browser-manager.js";
import { getDevicePreset, listDeviceNames, DEVICE_PRESETS } from "./devices.js";
import {
  buildSelector,
  waitForStable,
  getAccessibilityTree,
  getPageText,
  getFormElements,
  getPageLinks,
} from "./utils.js";
import {
  humanClick,
  humanType,
  humanScroll,
  humanHover,
  humanDelay,
  humanMouseMove,
  beforeAction,
  thinkingPause,
  microDelay,
} from "./human.js";

// Load the mark_page.js script once at startup
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MARK_PAGE_SCRIPT = readFileSync(join(__dirname, "mark_page.js"), "utf-8");

// Store the last marked element coordinates per page
const markedElements = new Map<number, any[]>();

/** Compact page info — saves tokens vs verbose descriptions. */
function pageInfo(id: number, url: string, title: string): string {
  return `[${id}] ${title} | ${url}`;
}

/** Truncate text to max length with … indicator. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/**
 * Register every browser-interaction tool on the MCP server.
 * 70 tools: human-like behavior, token-optimized outputs,
 * multi-browser, device emulation, network monitoring, and more.
 */
export function registerTools(server: McpServer, browser: BrowserManager): void {
  // ══════════════════════════════════════════════════════════
  //  1. CONNECTION
  // ══════════════════════════════════════════════════════════

  server.tool(
    "browser_connect",
    "Connect to a browser. Supports Chromium/Firefox/WebKit, device emulation, proxy, geolocation. Use cdpUrl to reuse existing Chrome sessions with all logins intact.",
    {
      cdpUrl: z.string().optional().describe("CDP URL, e.g. http://localhost:9222"),
      userDataDir: z.string().optional().describe("Chrome user-data-dir for session reuse"),
      executablePath: z.string().optional().describe("Chrome/Edge executable path"),
      headless: z.boolean().optional().describe("Run headless (default: false)"),
      browserEngine: z.enum(["chromium", "firefox", "webkit"]).optional().describe("Browser engine"),
      channel: z.string().optional().describe("Use installed browser: chrome, msedge, chrome-beta, msedge-dev"),
      proxyServer: z.string().optional().describe("Proxy URL (http://proxy:8080 or socks5://proxy:1080)"),
      device: z.string().optional().describe("Device preset (e.g. 'iPhone 15', 'Pixel 7')"),
      viewportWidth: z.number().optional(),
      viewportHeight: z.number().optional(),
    },
    async ({ cdpUrl, userDataDir, executablePath, headless, browserEngine, channel, proxyServer, device, viewportWidth, viewportHeight }) => {
      try {
        const opts: any = {};
        if (cdpUrl) opts.cdpUrl = cdpUrl;
        if (userDataDir) opts.userDataDir = userDataDir;
        if (executablePath) opts.executablePath = executablePath;
        if (headless !== undefined) opts.headless = headless;
        if (browserEngine) opts.browser = browserEngine;
        if (channel) opts.channel = channel;
        if (proxyServer) opts.proxyServer = proxyServer;
        if (device) opts.device = device;
        if (viewportWidth) opts.viewportWidth = viewportWidth;
        if (viewportHeight) opts.viewportHeight = viewportHeight;
        if (Object.keys(opts).length > 0) {
          browser.options = { ...browser.options, ...opts };
        }
        const msg = await browser.connect();
        const pages = await browser.listPagesWithTitles();
        const pageList = pages.map((p) => `  ${pageInfo(p.id, p.url, p.title)}`).join("\n");
        return {
          content: [{ type: "text" as const, text: `${msg}\nPages(${pages.length}):\n${pageList || "  (none)"}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Connection failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  2. NAVIGATION
  // ══════════════════════════════════════════════════════════

  server.tool(
    "navigate",
    "Navigate to a URL.",
    {
      url: z.string().describe("URL to navigate to"),
      pageId: z.number().optional(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
    },
    async ({ url, pageId, waitUntil }) => {
      try {
        await beforeAction();
        const { id, page } = await browser.getOrCreatePage(pageId);
        await page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded", timeout: 30_000 });
        await humanDelay(200, 500);
        const title = await page.title();
        return { content: [{ type: "text" as const, text: pageInfo(id, url, title) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Nav failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool("go_back", "Go back in browser history.", { pageId: z.number().optional() },
    async ({ pageId }) => {
      await beforeAction();
      const { id, page } = await browser.getOrCreatePage(pageId);
      await page.goBack({ waitUntil: "domcontentloaded" });
      await humanDelay(100, 300);
      return { content: [{ type: "text" as const, text: `[${id}] back: ${page.url()}` }] };
    }
  );

  server.tool("go_forward", "Go forward in browser history.", { pageId: z.number().optional() },
    async ({ pageId }) => {
      await beforeAction();
      const { id, page } = await browser.getOrCreatePage(pageId);
      await page.goForward({ waitUntil: "domcontentloaded" });
      await humanDelay(100, 300);
      return { content: [{ type: "text" as const, text: `[${id}] fwd: ${page.url()}` }] };
    }
  );

  server.tool("reload", "Reload the page.", { pageId: z.number().optional() },
    async ({ pageId }) => {
      const { id, page } = await browser.getOrCreatePage(pageId);
      await page.reload({ waitUntil: "domcontentloaded" });
      return { content: [{ type: "text" as const, text: `[${id}] reloaded` }] };
    }
  );

  server.tool(
    "wait_for_navigation",
    "Wait for page navigation to complete.",
    {
      pageId: z.number().optional(),
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      timeout: z.number().optional(),
    },
    async ({ pageId, waitUntil, timeout }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        await page.waitForLoadState((waitUntil as any) ?? "domcontentloaded", { timeout: timeout ?? 30_000 });
        return { content: [{ type: "text" as const, text: `[${id}] nav done: ${page.url()}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  3. PAGE / TAB MANAGEMENT
  // ══════════════════════════════════════════════════════════

  server.tool("list_pages", "List open tabs.", {},
    async () => {
      const pages = await browser.listPagesWithTitles();
      return {
        content: [{
          type: "text" as const,
          text: pages.length
            ? pages.map((p) => pageInfo(p.id, p.url, p.title)).join("\n")
            : "(no pages)",
        }],
      };
    }
  );

  server.tool("new_page", "Open new tab.", { url: z.string().optional() },
    async ({ url }) => {
      const { id } = await browser.newPage(url);
      return { content: [{ type: "text" as const, text: `+ [${id}]${url ? ` ${url}` : ""}` }] };
    }
  );

  server.tool("close_page", "Close a tab.", { pageId: z.number().describe("Page ID to close") },
    async ({ pageId }) => {
      await browser.closePage(pageId);
      return { content: [{ type: "text" as const, text: `x [${pageId}] closed` }] };
    }
  );

  server.tool("focus_page", "Bring a tab to front/focus.", { pageId: z.number() },
    async ({ pageId }) => {
      try {
        await browser.focusPage(pageId);
        return { content: [{ type: "text" as const, text: `Focused [${pageId}]` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Focus failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  4. INTERACTION (Human-Like)
  // ══════════════════════════════════════════════════════════

  server.tool(
    "click",
    "Click an element with human-like mouse movement and timing.",
    {
      selector: z.string().describe("CSS selector, XPath, or visible text"),
      pageId: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
    },
    async ({ selector, pageId, button, doubleClick }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const sel = buildSelector(selector);
        const el = await page.$(sel);
        if (!el) return { content: [{ type: "text" as const, text: `Not found: ${selector}` }], isError: true };

        const box = await el.boundingBox();
        if (box) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          await humanClick(page, cx, cy, { button: button ?? "left", clickCount: doubleClick ? 2 : 1 });
        } else {
          await page.click(sel, { button: button ?? "left", clickCount: doubleClick ? 2 : 1 });
        }
        await waitForStable(page);
        return { content: [{ type: "text" as const, text: `Clicked: ${truncate(selector, 60)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Click failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "type_text",
    "Type text with human-like keystroke timing and natural delays.",
    {
      text: z.string().describe("Text to type"),
      selector: z.string().optional().describe("Element selector to focus first"),
      pageId: z.number().optional(),
      clearFirst: z.boolean().optional().describe("Clear field first (default: false)"),
      pressEnter: z.boolean().optional().describe("Press Enter after (default: false)"),
    },
    async ({ text, selector, pageId, clearFirst, pressEnter }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);

        if (selector) {
          const sel = buildSelector(selector);
          const el = await page.$(sel);
          if (el) {
            const box = await el.boundingBox();
            if (box) {
              await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
            }
          }
          if (clearFirst) {
            await page.fill(sel, "");
            await microDelay();
          }
        } else if (clearFirst) {
          await page.keyboard.down("Control");
          await page.keyboard.press("a");
          await page.keyboard.up("Control");
          await page.keyboard.press("Backspace");
          await microDelay();
        }

        await humanType(page, text);

        if (pressEnter) {
          await humanDelay(100, 300);
          await page.keyboard.press("Enter");
          await waitForStable(page);
        }

        return { content: [{ type: "text" as const, text: `Typed: "${truncate(text, 40)}"${pressEnter ? " + Enter" : ""}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Type failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "fill_form",
    "Fill multiple form fields with human-like pauses between fields.",
    {
      fields: z.array(z.object({
        selector: z.string(),
        value: z.string(),
      })),
      pageId: z.number().optional(),
      submit: z.boolean().optional(),
    },
    async ({ fields, pageId, submit }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        for (const { selector, value } of fields) {
          const sel = buildSelector(selector);
          const el = await page.$(sel);
          if (el) {
            const box = await el.boundingBox();
            if (box) {
              await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
            }
          }
          await page.fill(sel, value);
          await humanDelay(200, 500);
        }
        if (submit) {
          await humanDelay(300, 700);
          await page.keyboard.press("Enter");
          await waitForStable(page);
        }
        return { content: [{ type: "text" as const, text: `Filled ${fields.length} fields${submit ? " + submitted" : ""}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Fill failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "select_option",
    "Select dropdown option.",
    {
      selector: z.string(),
      value: z.string().optional(),
      label: z.string().optional(),
      pageId: z.number().optional(),
    },
    async ({ selector, value, label, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await beforeAction();
        const sel = buildSelector(selector);
        if (label) await page.selectOption(sel, { label });
        else if (value) await page.selectOption(sel, value);
        await microDelay();
        return { content: [{ type: "text" as const, text: `Selected: ${label || value}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Select failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "check_checkbox",
    "Check/uncheck a checkbox or radio.",
    {
      selector: z.string(),
      checked: z.boolean().optional().describe("true=check, false=uncheck (default: true)"),
      pageId: z.number().optional(),
    },
    async ({ selector, checked, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await beforeAction();
        const sel = buildSelector(selector);
        if (checked === false) await page.uncheck(sel);
        else await page.check(sel);
        await microDelay();
        return { content: [{ type: "text" as const, text: `${checked === false ? "Unchecked" : "Checked"}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Check failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "hover",
    "Hover over element with natural mouse movement.",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const el = await page.$(buildSelector(selector));
        if (el) {
          const box = await el.boundingBox();
          if (box) {
            await humanHover(page, box.x + box.width / 2, box.y + box.height / 2);
            return { content: [{ type: "text" as const, text: `Hovering: ${truncate(selector, 60)}` }] };
          }
        }
        await page.hover(buildSelector(selector));
        return { content: [{ type: "text" as const, text: `Hovering: ${truncate(selector, 60)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Hover failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "press_key",
    "Press a key or combo (Enter, Control+C, ArrowDown, Tab, Escape).",
    { key: z.string(), pageId: z.number().optional() },
    async ({ key, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await beforeAction();
        await page.keyboard.press(key);
        return { content: [{ type: "text" as const, text: `Key: ${key}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Key failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "scroll",
    "Scroll with human-like smooth motion.",
    {
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Pixels (default: 500)"),
      selector: z.string().optional().describe("Scroll within specific element"),
      pageId: z.number().optional(),
    },
    async ({ direction, amount, selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const px = amount ?? 500;
        const deltaX = direction === "right" ? px : direction === "left" ? -px : 0;
        const deltaY = direction === "down" ? px : direction === "up" ? -px : 0;

        if (selector) {
          const el = await page.$(buildSelector(selector));
          if (el) {
            await el.evaluate((node, { dx, dy }) => node.scrollBy(dx, dy), { dx: deltaX, dy: deltaY });
          }
        } else {
          await humanScroll(page, deltaY, deltaX);
        }
        return { content: [{ type: "text" as const, text: `Scrolled ${direction} ${px}px` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Scroll failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "scroll_to_element",
    "Scroll element into view with human-like motion.",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const sel = buildSelector(selector);
        const el = await page.$(sel);
        if (!el) return { content: [{ type: "text" as const, text: `Not found: ${selector}` }], isError: true };
        await el.scrollIntoViewIfNeeded();
        await humanDelay(100, 300);
        return { content: [{ type: "text" as const, text: `Scrolled to: ${truncate(selector, 60)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Scroll failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "wait_for_element",
    "Wait for element to appear.",
    {
      selector: z.string(),
      state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
      timeout: z.number().optional(),
      pageId: z.number().optional(),
    },
    async ({ selector, state, timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.waitForSelector(buildSelector(selector), { state: state ?? "visible", timeout: timeout ?? 30_000 });
        return { content: [{ type: "text" as const, text: `Found: ${truncate(selector, 60)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "wait_for_text",
    "Wait for specific text to appear on the page.",
    {
      text: z.string().describe("Text to wait for"),
      timeout: z.number().optional(),
      pageId: z.number().optional(),
    },
    async ({ text, timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.waitForSelector(`text="${text}"`, { state: "visible", timeout: timeout ?? 30_000 });
        return { content: [{ type: "text" as const, text: `Text found: "${truncate(text, 40)}"` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "drag_and_drop",
    "Drag element to target with human-like mouse motion.",
    {
      sourceSelector: z.string(),
      targetSelector: z.string(),
      pageId: z.number().optional(),
    },
    async ({ sourceSelector, targetSelector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const src = await page.$(buildSelector(sourceSelector));
        const tgt = await page.$(buildSelector(targetSelector));
        if (src && tgt) {
          const srcBox = await src.boundingBox();
          const tgtBox = await tgt.boundingBox();
          if (srcBox && tgtBox) {
            const srcX = srcBox.x + srcBox.width / 2;
            const srcY = srcBox.y + srcBox.height / 2;
            const tgtX = tgtBox.x + tgtBox.width / 2;
            const tgtY = tgtBox.y + tgtBox.height / 2;
            await humanMouseMove(page, srcX, srcY);
            await microDelay();
            await page.mouse.down();
            await humanDelay(100, 200);
            await humanMouseMove(page, tgtX, tgtY);
            await microDelay();
            await page.mouse.up();
          } else {
            await page.dragAndDrop(buildSelector(sourceSelector), buildSelector(targetSelector));
          }
        } else {
          await page.dragAndDrop(buildSelector(sourceSelector), buildSelector(targetSelector));
        }
        return { content: [{ type: "text" as const, text: `Dragged to target` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Drag failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "upload_file",
    "Upload file(s) to input.",
    {
      selector: z.string(),
      filePaths: z.union([z.string(), z.array(z.string())]).describe("Absolute path(s) to file(s)"),
      pageId: z.number().optional(),
    },
    async ({ selector, filePaths, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.setInputFiles(buildSelector(selector), filePaths);
        const count = Array.isArray(filePaths) ? filePaths.length : 1;
        return { content: [{ type: "text" as const, text: `Uploaded ${count} file(s)` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Upload failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "handle_dialog",
    "Accept or dismiss browser dialog.",
    {
      action: z.enum(["accept", "dismiss"]),
      promptText: z.string().optional(),
      pageId: z.number().optional(),
    },
    async ({ action, promptText, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        page.once("dialog", async (dialog) => {
          if (action === "accept") await dialog.accept(promptText);
          else await dialog.dismiss();
        });
        return { content: [{ type: "text" as const, text: `Will ${action} next dialog` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Dialog failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  5. READING / OBSERVATION (Token-Optimized)
  // ══════════════════════════════════════════════════════════

  server.tool(
    "get_page_content",
    "Get visible text content (token-optimized, default 4000 chars).",
    {
      pageId: z.number().optional(),
      maxLength: z.number().optional().describe("Max chars (default: 4000)"),
    },
    async ({ pageId, maxLength }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const text = await getPageText(page, maxLength ?? 4000);
        const title = await page.title();
        return {
          content: [{ type: "text" as const, text: `${pageInfo(id, page.url(), title)}\n\n${text}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_page_html",
    "Get HTML (truncated by default to save tokens).",
    {
      selector: z.string().optional(),
      pageId: z.number().optional(),
      maxLength: z.number().optional().describe("Max chars (default: 20000)"),
    },
    async ({ selector, pageId, maxLength }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const max = maxLength ?? 20_000;
        let html: string;
        if (selector) {
          const el = await page.$(buildSelector(selector));
          if (!el) return { content: [{ type: "text" as const, text: `Not found: ${selector}` }], isError: true };
          html = await el.evaluate((e) => e.outerHTML);
        } else {
          html = await page.content();
        }
        return { content: [{ type: "text" as const, text: truncate(html, max) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_element_text",
    "Get element text.",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const text = await page.textContent(buildSelector(selector));
        return { content: [{ type: "text" as const, text: truncate(text ?? "(empty)", 2000) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_element_attribute",
    "Get element attribute.",
    { selector: z.string(), attribute: z.string(), pageId: z.number().optional() },
    async ({ selector, attribute, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const value = await page.getAttribute(buildSelector(selector), attribute);
        return { content: [{ type: "text" as const, text: value ?? "(none)" }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_element_value",
    "Get form element value (input, textarea, select).",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const value = await page.inputValue(buildSelector(selector));
        return { content: [{ type: "text" as const, text: value || "(empty)" }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "element_exists",
    "Quick check if element exists (returns true/false).",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const el = await page.$(buildSelector(selector));
        return { content: [{ type: "text" as const, text: el ? "true" : "false" }] };
      } catch {
        return { content: [{ type: "text" as const, text: "false" }] };
      }
    }
  );

  server.tool(
    "element_count",
    "Count elements matching selector.",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const els = await page.$$(buildSelector(selector));
        return { content: [{ type: "text" as const, text: `${els.length}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_bounding_box",
    "Get element position and size.",
    { selector: z.string(), pageId: z.number().optional() },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const el = await page.$(buildSelector(selector));
        if (!el) return { content: [{ type: "text" as const, text: `Not found: ${selector}` }], isError: true };
        const box = await el.boundingBox();
        if (!box) return { content: [{ type: "text" as const, text: "Not visible" }], isError: true };
        return {
          content: [{ type: "text" as const, text: `x:${Math.round(box.x)} y:${Math.round(box.y)} w:${Math.round(box.width)} h:${Math.round(box.height)}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "take_screenshot",
    "Screenshot page or element.",
    {
      pageId: z.number().optional(),
      selector: z.string().optional(),
      fullPage: z.boolean().optional(),
      path: z.string().optional(),
    },
    async ({ pageId, selector, fullPage, path }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        let buffer: Buffer;
        if (selector) {
          const el = await page.$(buildSelector(selector));
          if (!el) return { content: [{ type: "text" as const, text: `Not found: ${selector}` }], isError: true };
          buffer = await el.screenshot({ path, type: "png" });
        } else {
          buffer = await page.screenshot({ path, fullPage: fullPage ?? false, type: "png" });
        }
        if (path) return { content: [{ type: "text" as const, text: `Saved: ${path}` }] };
        return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Screenshot failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_accessibility_tree",
    "Get compact accessibility tree.",
    {
      pageId: z.number().optional(),
      maxLength: z.number().optional().describe("Max chars (default: 4000)"),
    },
    async ({ pageId, maxLength }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const tree = await getAccessibilityTree(page);
        return { content: [{ type: "text" as const, text: truncate(tree, maxLength ?? 4000) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_form_elements",
    "List form elements (compact one-line-per-element format).",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const elements = await getFormElements(page);
        const lines = elements.map((el: any) => {
          let desc = `[${el.index}] <${el.tag}`;
          if (el.type) desc += ` type=${el.type}`;
          desc += `>`;
          if (el.name) desc += ` name="${el.name}"`;
          if (el.id) desc += ` #${el.id}`;
          if (el.placeholder) desc += ` "${el.placeholder}"`;
          if (el.text) desc += ` "${truncate(el.text, 30)}"`;
          if (el.value) desc += ` val="${truncate(el.value, 20)}"`;
          return desc;
        });
        return { content: [{ type: "text" as const, text: `${lines.length} elements:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_links",
    "List page links (compact, deduplicated).",
    {
      pageId: z.number().optional(),
      maxLinks: z.number().optional().describe("Max links (default: 30)"),
    },
    async ({ pageId, maxLinks }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const links = await getPageLinks(page, maxLinks ?? 30);
        const seen = new Set<string>();
        const unique = links.filter((l) => {
          if (seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        });
        const lines = unique.map((l) => `${truncate(l.text || "-", 40)} -> ${l.href}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_table_data",
    "Extract table data as structured JSON. Returns rows with header-based keys.",
    {
      selector: z.string().optional().describe("Table selector (default: first table)"),
      pageId: z.number().optional(),
    },
    async ({ selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const sel = selector ? buildSelector(selector) : "table";
        const data = await page.evaluate((s) => {
          const table = document.querySelector(s);
          if (!table) return null;
          const rows = Array.from(table.querySelectorAll("tr"));
          if (rows.length === 0) return [];
          const headers = Array.from(rows[0].querySelectorAll("th,td")).map(
            (c) => (c as HTMLElement).innerText?.trim() || `col${Array.from(rows[0].children).indexOf(c)}`
          );
          return rows.slice(1).map((row) => {
            const cells = Array.from(row.querySelectorAll("td,th"));
            const obj: Record<string, string> = {};
            cells.forEach((cell, i) => {
              obj[headers[i] || `col${i}`] = (cell as HTMLElement).innerText?.trim() || "";
            });
            return obj;
          });
        }, sel);
        if (data === null) return { content: [{ type: "text" as const, text: "No table found" }], isError: true };
        return { content: [{ type: "text" as const, text: truncate(JSON.stringify(data, null, 1), 4000) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  6. JAVASCRIPT
  // ══════════════════════════════════════════════════════════

  server.tool(
    "evaluate_javascript",
    "Run JavaScript in page context.",
    { script: z.string(), pageId: z.number().optional() },
    async ({ script, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const result = await page.evaluate(script);
        const output = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text: truncate(output ?? "(void)", 4000) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `JS error: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  7. COOKIES & STORAGE (Compact)
  // ══════════════════════════════════════════════════════════

  server.tool(
    "get_cookies",
    "Get cookies (compact: name=value [domain]).",
    { url: z.string().optional() },
    async ({ url }) => {
      try {
        const ctx = browser.getContext();
        const cookies = url ? await ctx.cookies(url) : await ctx.cookies();
        const lines = cookies.map((c) => `${c.name}=${truncate(c.value, 40)} [${c.domain}]`);
        return { content: [{ type: "text" as const, text: `${cookies.length} cookies:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_cookies",
    "Set cookies.",
    {
      cookies: z.array(z.object({
        name: z.string(), value: z.string(),
        url: z.string().optional(), domain: z.string().optional(),
        path: z.string().optional(), httpOnly: z.boolean().optional(), secure: z.boolean().optional(),
      })),
    },
    async ({ cookies }) => {
      try {
        const ctx = browser.getContext();
        await ctx.addCookies(cookies as any);
        return { content: [{ type: "text" as const, text: `Set ${cookies.length} cookies` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "clear_cookies",
    "Clear all cookies in the browser context.",
    {},
    async () => {
      try {
        const ctx = browser.getContext();
        await ctx.clearCookies();
        return { content: [{ type: "text" as const, text: `Cookies cleared` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_local_storage",
    "Get localStorage (compact).",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const data = await page.evaluate(() => {
          const items: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) items[key] = localStorage.getItem(key) || "";
          }
          return items;
        });
        const entries = Object.entries(data);
        const lines = entries.map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + "..." : v}`);
        return { content: [{ type: "text" as const, text: `${entries.length} items:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_local_storage",
    "Set localStorage key-value pairs.",
    {
      items: z.record(z.string()).describe("Object of key-value pairs"),
      pageId: z.number().optional(),
    },
    async ({ items, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            localStorage.setItem(key, value);
          }
        }, items);
        return { content: [{ type: "text" as const, text: `Set ${Object.keys(items).length} localStorage items` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_session_storage",
    "Get sessionStorage (compact).",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const data = await page.evaluate(() => {
          const items: Record<string, string> = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) items[key] = sessionStorage.getItem(key) || "";
          }
          return items;
        });
        const entries = Object.entries(data);
        const lines = entries.map(([k, v]) => `${k}=${v.length > 60 ? v.slice(0, 60) + "..." : v}`);
        return { content: [{ type: "text" as const, text: `${entries.length} items:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_session_storage",
    "Set sessionStorage key-value pairs.",
    {
      items: z.record(z.string()).describe("Object of key-value pairs"),
      pageId: z.number().optional(),
    },
    async ({ items, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.evaluate((data) => {
          for (const [key, value] of Object.entries(data)) {
            sessionStorage.setItem(key, value);
          }
        }, items);
        return { content: [{ type: "text" as const, text: `Set ${Object.keys(items).length} sessionStorage items` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "clear_storage",
    "Clear localStorage, sessionStorage, or both.",
    {
      target: z.enum(["local", "session", "both"]).optional().describe("What to clear (default: both)"),
      pageId: z.number().optional(),
    },
    async ({ target, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const t = target ?? "both";
        await page.evaluate((which) => {
          if (which === "local" || which === "both") localStorage.clear();
          if (which === "session" || which === "both") sessionStorage.clear();
        }, t);
        return { content: [{ type: "text" as const, text: `Cleared ${t} storage` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "save_storage_state",
    "Save cookies + localStorage to a JSON file for session persistence.",
    { filePath: z.string().describe("Path to save state JSON") },
    async ({ filePath }) => {
      try {
        await browser.saveStorageState(filePath);
        return { content: [{ type: "text" as const, text: `State saved: ${filePath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "load_storage_state",
    "Load cookies + localStorage from a saved JSON file.",
    { filePath: z.string().describe("Path to state JSON file") },
    async ({ filePath }) => {
      try {
        await browser.loadStorageState(filePath);
        return { content: [{ type: "text" as const, text: `State loaded: ${filePath}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  8. NETWORK MONITORING & CONTROL
  // ══════════════════════════════════════════════════════════

  server.tool(
    "wait_for_network_idle",
    "Wait for network idle.",
    { timeout: z.number().optional(), pageId: z.number().optional() },
    async ({ timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.waitForLoadState("networkidle", { timeout: timeout ?? 30_000 });
        return { content: [{ type: "text" as const, text: `Network idle` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "wait_for_url",
    "Wait for URL to match pattern.",
    { urlPattern: z.string(), timeout: z.number().optional(), pageId: z.number().optional() },
    async ({ urlPattern, timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.waitForURL(urlPattern, { timeout: timeout ?? 30_000 });
        return { content: [{ type: "text" as const, text: `URL: ${page.url()}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "wait_for_response",
    "Wait for a network response matching URL pattern.",
    {
      urlPattern: z.string().describe("URL substring or glob pattern to match"),
      timeout: z.number().optional(),
      pageId: z.number().optional(),
    },
    async ({ urlPattern, timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const response = await page.waitForResponse(
          (resp) => resp.url().includes(urlPattern),
          { timeout: timeout ?? 30_000 }
        );
        return {
          content: [{
            type: "text" as const,
            text: `${response.status()} ${response.url().slice(0, 100)}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "wait_for_request",
    "Wait for a network request matching URL pattern.",
    {
      urlPattern: z.string().describe("URL substring to match"),
      timeout: z.number().optional(),
      pageId: z.number().optional(),
    },
    async ({ urlPattern, timeout, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const request = await page.waitForRequest(
          (req) => req.url().includes(urlPattern),
          { timeout: timeout ?? 30_000 }
        );
        return {
          content: [{
            type: "text" as const,
            text: `${request.method()} ${request.url().slice(0, 100)}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Wait failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_network_log",
    "Get captured network requests/responses (auto-captured since page load).",
    {
      pageId: z.number().optional(),
      filter: z.string().optional().describe("Filter by URL substring"),
      resourceType: z.string().optional().describe("Filter by type: document, xhr, fetch, script, stylesheet, image, font"),
      maxEntries: z.number().optional().describe("Max entries (default: 50)"),
    },
    async ({ pageId, filter, resourceType, maxEntries }) => {
      try {
        const { id } = await browser.getOrCreatePage(pageId);
        let logs = browser.getNetworkLogs(id);
        if (filter) logs = logs.filter((l) => l.url.includes(filter));
        if (resourceType) logs = logs.filter((l) => l.resourceType === resourceType);
        logs = logs.slice(-(maxEntries ?? 50));
        const lines = logs.map(
          (l) => `${l.method} ${l.status || "..."} ${l.resourceType} ${truncate(l.url, 80)}${l.duration ? ` ${l.duration}ms` : ""}`
        );
        return { content: [{ type: "text" as const, text: `${logs.length} requests:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_console_logs",
    "Get captured browser console messages (auto-captured since page load).",
    {
      pageId: z.number().optional(),
      level: z.enum(["log", "warning", "error", "info", "debug", "all"]).optional(),
      maxEntries: z.number().optional().describe("Max entries (default: 50)"),
    },
    async ({ pageId, level, maxEntries }) => {
      try {
        const { id } = await browser.getOrCreatePage(pageId);
        let logs = browser.getConsoleLogs(id);
        if (level && level !== "all") logs = logs.filter((l) => l.type === level);
        logs = logs.slice(-(maxEntries ?? 50));
        const lines = logs.map(
          (l) => `[${l.type}] ${truncate(l.text, 120)}`
        );
        return { content: [{ type: "text" as const, text: `${logs.length} messages:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "block_urls",
    "Block network requests matching URL patterns (ads, trackers, images, etc.).",
    {
      patterns: z.array(z.string()).describe("URL patterns to block (glob or substring)"),
    },
    async ({ patterns }) => {
      try {
        const ctx = browser.getContext();
        for (const pattern of patterns) {
          browser.addBlockedPattern(pattern);
          await ctx.route(pattern, (route) => route.abort());
        }
        return { content: [{ type: "text" as const, text: `Blocking ${patterns.length} patterns` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "set_extra_headers",
    "Set custom HTTP headers for all subsequent requests.",
    {
      headers: z.record(z.string()).describe("Header name-value pairs"),
    },
    async ({ headers }) => {
      try {
        await browser.setExtraHTTPHeaders(headers);
        return { content: [{ type: "text" as const, text: `Set ${Object.keys(headers).length} headers` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  9. DEVICE & VIEWPORT
  // ══════════════════════════════════════════════════════════

  server.tool(
    "set_viewport",
    "Set viewport size. Useful for responsive testing.",
    {
      width: z.number().describe("Viewport width in pixels"),
      height: z.number().describe("Viewport height in pixels"),
      pageId: z.number().optional(),
    },
    async ({ width, height, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.setViewportSize({ width, height });
        return { content: [{ type: "text" as const, text: `Viewport: ${width}x${height}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "emulate_device",
    "Emulate a device (viewport, user-agent, touch, scale). Supports 50+ presets.",
    {
      device: z.string().describe("Device name (e.g. 'iPhone 15', 'Pixel 7', 'iPad Pro 11', 'Desktop Chrome')"),
      pageId: z.number().optional(),
    },
    async ({ device, pageId }) => {
      try {
        const preset = getDevicePreset(device);
        if (!preset) {
          const available = listDeviceNames().join(", ");
          return { content: [{ type: "text" as const, text: `Unknown device: "${device}"\nAvailable: ${available}` }], isError: true };
        }
        const { page } = await browser.getOrCreatePage(pageId);
        await page.setViewportSize(preset.viewport);
        // Note: userAgent and deviceScaleFactor can only be set at context level
        // We set viewport here; for full emulation, use device option in browser_connect
        return {
          content: [{
            type: "text" as const,
            text: `Emulating: ${preset.name} (${preset.viewport.width}x${preset.viewport.height}${preset.isMobile ? " mobile" : ""})`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_devices",
    "List all available device emulation presets.",
    {},
    async () => {
      const devices = Object.values(DEVICE_PRESETS).map(
        (d) => `${d.name}: ${d.viewport.width}x${d.viewport.height} ${d.isMobile ? "mobile" : "desktop"} ${d.hasTouch ? "touch" : ""}`
      );
      return { content: [{ type: "text" as const, text: `${devices.length} devices:\n${devices.join("\n")}` }] };
    }
  );

  // ══════════════════════════════════════════════════════════
  //  10. GEOLOCATION & PERMISSIONS
  // ══════════════════════════════════════════════════════════

  server.tool(
    "set_geolocation",
    "Override browser geolocation. Grant geolocation permission automatically.",
    {
      latitude: z.number().describe("Latitude (-90 to 90)"),
      longitude: z.number().describe("Longitude (-180 to 180)"),
      accuracy: z.number().optional().describe("Accuracy in meters (default: 100)"),
    },
    async ({ latitude, longitude, accuracy }) => {
      try {
        await browser.grantPermissions(["geolocation"]);
        await browser.setGeolocation(latitude, longitude, accuracy);
        return { content: [{ type: "text" as const, text: `Geolocation: ${latitude}, ${longitude}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "grant_permissions",
    "Grant browser permissions.",
    {
      permissions: z.array(z.string()).describe("Permissions: geolocation, clipboard-read, clipboard-write, notifications, camera, microphone"),
      origin: z.string().optional().describe("Origin to grant for (e.g. https://example.com)"),
    },
    async ({ permissions, origin }) => {
      try {
        await browser.grantPermissions(permissions, origin);
        return { content: [{ type: "text" as const, text: `Granted: ${permissions.join(", ")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "clear_permissions",
    "Clear all granted permissions.",
    {},
    async () => {
      try {
        await browser.clearPermissions();
        return { content: [{ type: "text" as const, text: `Permissions cleared` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  11. FRAME / IFRAME SUPPORT
  // ══════════════════════════════════════════════════════════

  server.tool(
    "list_frames",
    "List all frames (iframes) on the page.",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        const frames = page.frames();
        const lines = frames.map((f, i) =>
          `[${i}] ${f.name() || "(unnamed)"} ${truncate(f.url(), 80)}`
        );
        return { content: [{ type: "text" as const, text: `${frames.length} frames:\n${lines.join("\n")}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "execute_in_frame",
    "Execute JavaScript in a specific frame/iframe.",
    {
      frameIndex: z.number().optional().describe("Frame index from list_frames"),
      frameName: z.string().optional().describe("Frame name"),
      frameUrl: z.string().optional().describe("Frame URL substring to match"),
      script: z.string().describe("JavaScript to execute"),
      pageId: z.number().optional(),
    },
    async ({ frameIndex, frameName, frameUrl, script, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        let frame;
        if (frameIndex !== undefined) {
          frame = page.frames()[frameIndex];
        } else if (frameName) {
          frame = page.frame(frameName);
        } else if (frameUrl) {
          frame = page.frames().find((f) => f.url().includes(frameUrl));
        }
        if (!frame) return { content: [{ type: "text" as const, text: "Frame not found" }], isError: true };
        const result = await frame.evaluate(script);
        const output = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text: truncate(output ?? "(void)", 4000) }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "click_in_frame",
    "Click an element inside a frame/iframe.",
    {
      frameIndex: z.number().optional(),
      frameName: z.string().optional(),
      frameUrl: z.string().optional(),
      selector: z.string(),
      pageId: z.number().optional(),
    },
    async ({ frameIndex, frameName, frameUrl, selector, pageId }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        let frame;
        if (frameIndex !== undefined) frame = page.frames()[frameIndex];
        else if (frameName) frame = page.frame(frameName);
        else if (frameUrl) frame = page.frames().find((f) => f.url().includes(frameUrl));
        if (!frame) return { content: [{ type: "text" as const, text: "Frame not found" }], isError: true };
        await frame.click(buildSelector(selector));
        return { content: [{ type: "text" as const, text: `Clicked in frame: ${truncate(selector, 60)}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  12. PDF
  // ══════════════════════════════════════════════════════════

  server.tool(
    "save_as_pdf",
    "Save page as PDF.",
    {
      path: z.string(),
      pageId: z.number().optional(),
      format: z.enum(["Letter", "Legal", "Tabloid", "Ledger", "A0", "A1", "A2", "A3", "A4", "A5", "A6"]).optional(),
    },
    async ({ path, pageId, format }) => {
      try {
        const { page } = await browser.getOrCreatePage(pageId);
        await page.pdf({ path, format: format ?? "A4" });
        return { content: [{ type: "text" as const, text: `PDF: ${path}` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `PDF failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  13. MARK PAGE (Token-Saving Element Annotation)
  // ══════════════════════════════════════════════════════════

  server.tool(
    "mark_page",
    "Annotate page with numbered boxes on interactive elements. Returns ultra-compact element list. Use click_element/type_into_element by index. Huge token savings vs full HTML.",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const elements = await page.evaluate(MARK_PAGE_SCRIPT + "\nmarkPage();");
        markedElements.set(id, elements as any[]);

        const lines = (elements as any[]).map((el: any) => {
          const parts = [`[${el.index}]<${el.type}>`];
          if (el.text) parts.push(`"${truncate(el.text, 25)}"`);
          else if (el.ariaLabel) parts.push(`"${truncate(el.ariaLabel, 25)}"`);
          else if (el.placeholder) parts.push(`"${truncate(el.placeholder, 25)}"`);
          if (el.id) parts.push(`#${el.id}`);
          return parts.join(" ");
        });

        return {
          content: [{ type: "text" as const, text: `${(elements as any[]).length} elements:\n${lines.join("\n")}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Mark failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool("unmark_page", "Remove annotations.", { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        await page.evaluate(MARK_PAGE_SCRIPT + "\nunmarkPage();");
        markedElements.delete(id);
        return { content: [{ type: "text" as const, text: `Unmarked [${id}]` }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Unmark failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "click_element",
    "Click element by index (from mark_page) with human-like mouse movement.",
    {
      index: z.number().describe("Element index from mark_page"),
      pageId: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    },
    async ({ index, pageId, button }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const elements = markedElements.get(id);
        if (!elements) return { content: [{ type: "text" as const, text: "Call mark_page first" }], isError: true };
        const el = elements[index];
        if (!el) return { content: [{ type: "text" as const, text: `[${index}] not found (0-${elements.length - 1})` }], isError: true };

        await page.evaluate(MARK_PAGE_SCRIPT + "\nunmarkPage();");
        await humanClick(page, el.x, el.y, { button: button ?? "left" });
        await waitForStable(page);

        return {
          content: [{ type: "text" as const, text: `Clicked [${index}] <${el.type}> "${truncate(el.text || el.ariaLabel || "", 30)}"` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Click failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "type_into_element",
    "Type into element by index (from mark_page) with human-like typing.",
    {
      index: z.number(),
      text: z.string(),
      pageId: z.number().optional(),
      clearFirst: z.boolean().optional().describe("Clear first (default: true)"),
      pressEnter: z.boolean().optional(),
    },
    async ({ index, text, pageId, clearFirst, pressEnter }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const elements = markedElements.get(id);
        if (!elements) return { content: [{ type: "text" as const, text: "Call mark_page first" }], isError: true };
        const el = elements[index];
        if (!el) return { content: [{ type: "text" as const, text: `[${index}] not found (0-${elements.length - 1})` }], isError: true };

        await page.evaluate(MARK_PAGE_SCRIPT + "\nunmarkPage();");
        await humanClick(page, el.x, el.y);
        await microDelay();

        if (clearFirst !== false) {
          await page.keyboard.down("Control");
          await page.keyboard.press("a");
          await page.keyboard.up("Control");
          await microDelay();
        }
        await humanType(page, text);

        if (pressEnter) {
          await humanDelay(100, 300);
          await page.keyboard.press("Enter");
          await waitForStable(page);
        }

        return {
          content: [{ type: "text" as const, text: `Typed "${truncate(text, 30)}" -> [${index}]${pressEnter ? " + Enter" : ""}` }],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Type failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "mark_page_and_screenshot",
    "Mark page + screenshot. Best for visual agents.",
    { pageId: z.number().optional(), fullPage: z.boolean().optional() },
    async ({ pageId, fullPage }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const elements = await page.evaluate(MARK_PAGE_SCRIPT + "\nmarkPage();");
        markedElements.set(id, elements as any[]);
        const buffer = await page.screenshot({ fullPage: fullPage ?? false, type: "png" });

        const lines = (elements as any[]).map((el: any) => {
          const parts = [`[${el.index}]<${el.type}>`];
          if (el.text) parts.push(`"${truncate(el.text, 20)}"`);
          else if (el.ariaLabel) parts.push(`"${truncate(el.ariaLabel, 20)}"`);
          return parts.join(" ");
        });

        return {
          content: [
            { type: "text" as const, text: `${(elements as any[]).length} elements:\n${lines.join("\n")}` },
            { type: "image" as const, data: buffer.toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  14. SMART TOOLS (Token-Saving Helpers)
  // ══════════════════════════════════════════════════════════

  server.tool(
    "get_page_summary",
    "Ultra-compact page summary: title, URL, headings, element counts. Minimal tokens.",
    { pageId: z.number().optional() },
    async ({ pageId }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const summary = await page.evaluate(() => {
          const title = document.title;
          const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map(
            (h) => `${"  ".repeat(parseInt(h.tagName[1]) - 1)}${h.textContent?.trim().slice(0, 60)}`
          ).slice(0, 15);
          const linkCount = document.querySelectorAll("a[href]").length;
          const formCount = document.querySelectorAll("form").length;
          const inputCount = document.querySelectorAll("input,textarea,select").length;
          const imgCount = document.querySelectorAll("img").length;
          const btnCount = document.querySelectorAll("button,[role=button]").length;
          const meta = document.querySelector('meta[name="description"]')?.getAttribute("content") || "";
          return { title, headings, linkCount, formCount, inputCount, imgCount, btnCount, meta };
        });

        const parts = [
          pageInfo(id, page.url(), summary.title),
          summary.meta ? `Meta: ${truncate(summary.meta, 80)}` : null,
          `Links:${summary.linkCount} Forms:${summary.formCount} Inputs:${summary.inputCount} Btns:${summary.btnCount} Imgs:${summary.imgCount}`,
          summary.headings.length ? `Headings:\n${summary.headings.join("\n")}` : null,
        ].filter(Boolean);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "smart_action",
    "Natural language browser action with human-like behavior. Examples: 'click Login', 'type hello into search', 'scroll down'.",
    {
      action: z.string().describe("Natural language action"),
      pageId: z.number().optional(),
    },
    async ({ action, pageId }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pageId);
        const actionLower = action.toLowerCase();

        // Parse: click/press
        if (actionLower.startsWith("click ") || actionLower.startsWith("press ") || actionLower.startsWith("tap ")) {
          const target = action.replace(/^(click|press|tap)\s+/i, "").replace(/^(the|a|an)\s+/i, "").replace(/\s*button\s*$/i, "");
          const el = await page.$(`text="${target}"`)
            || await page.$(`[aria-label="${target}"]`)
            || await page.$(`button:has-text("${target}")`)
            || await page.$(`a:has-text("${target}")`)
            || await page.$(`[title="${target}"]`)
            || await page.$(`input[value="${target}"]`);
          if (el) {
            const box = await el.boundingBox();
            if (box) {
              await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
              await waitForStable(page);
              return { content: [{ type: "text" as const, text: `Clicked "${target}"` }] };
            }
          }
          return { content: [{ type: "text" as const, text: `Not found: "${target}". Use mark_page to see elements.` }], isError: true };
        }

        // Parse: type X into Y
        if (actionLower.startsWith("type ") || actionLower.startsWith("enter ") || actionLower.startsWith("input ")) {
          const match = action.match(/^(?:type|enter|input)\s+"?([^"]+)"?\s+(?:into|in|on|to)\s+(.+)$/i);
          if (match) {
            const text = match[1];
            const target = match[2].replace(/^(the|a|an)\s+/i, "");
            const el = await page.$(`[placeholder*="${target}" i]`)
              || await page.$(`[aria-label*="${target}" i]`)
              || await page.$(`input[name*="${target}" i]`)
              || await page.$(`textarea[name*="${target}" i]`)
              || await page.$(`label:has-text("${target}") + input`)
              || await page.$(`label:has-text("${target}") + textarea`);
            if (el) {
              const box = await el.boundingBox();
              if (box) {
                await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
                await page.keyboard.down("Control");
                await page.keyboard.press("a");
                await page.keyboard.up("Control");
                await humanType(page, text);
                return { content: [{ type: "text" as const, text: `Typed "${truncate(text, 30)}" into "${target}"` }] };
              }
            }
            return { content: [{ type: "text" as const, text: `Not found: "${target}". Use mark_page.` }], isError: true };
          }
        }

        // Parse: scroll
        if (actionLower.includes("scroll")) {
          if (actionLower.includes("bottom") || actionLower.includes("end")) {
            await humanScroll(page, 3000);
          } else if (actionLower.includes("top") || actionLower.includes("beginning")) {
            await humanScroll(page, -3000);
          } else if (actionLower.includes("down")) {
            await humanScroll(page, 500);
          } else if (actionLower.includes("up")) {
            await humanScroll(page, -500);
          } else if (actionLower.includes("left")) {
            await humanScroll(page, 0, -500);
          } else if (actionLower.includes("right")) {
            await humanScroll(page, 0, 500);
          }
          return { content: [{ type: "text" as const, text: `Done: ${action}` }] };
        }

        // Parse: wait
        if (actionLower.startsWith("wait ")) {
          const match = action.match(/wait\s+(?:for\s+)?(\d+)\s*(?:s|sec|seconds|ms|milliseconds)?/i);
          if (match) {
            const ms = parseInt(match[1]) * (action.includes("ms") ? 1 : 1000);
            await new Promise((r) => setTimeout(r, ms));
            return { content: [{ type: "text" as const, text: `Waited ${ms}ms` }] };
          }
        }

        // Parse: go back/forward
        if (actionLower === "go back" || actionLower === "back") {
          await page.goBack({ waitUntil: "domcontentloaded" });
          return { content: [{ type: "text" as const, text: `Back: ${page.url()}` }] };
        }
        if (actionLower === "go forward" || actionLower === "forward") {
          await page.goForward({ waitUntil: "domcontentloaded" });
          return { content: [{ type: "text" as const, text: `Forward: ${page.url()}` }] };
        }

        return { content: [{ type: "text" as const, text: `Unknown action. Try: "click X", "type X into Y", "scroll down", "wait 3s", "go back"` }], isError: true };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Action failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  15. BROWSER INFO & CONFIG
  // ══════════════════════════════════════════════════════════

  server.tool(
    "get_browser_info",
    "Get browser configuration, connection details, and capabilities.",
    {},
    async () => {
      try {
        const info = browser.getBrowserInfo();
        const lines = Object.entries(info).map(([k, v]) => `${k}: ${v}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ══════════════════════════════════════════════════════════
  //  16. CLOSE BROWSER
  // ══════════════════════════════════════════════════════════

  server.tool("close_browser", "Close browser and cleanup.", {},
    async () => {
      await browser.close();
      return { content: [{ type: "text" as const, text: "Browser closed" }] };
    }
  );
}
