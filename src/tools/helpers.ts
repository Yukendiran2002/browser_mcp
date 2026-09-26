import type { Page, ElementHandle, Request, Frame } from "playwright";
import { BrowserManager } from "../browser-manager.js";
import { diffSnapshot, takeSnapshot, hasSnapshot } from "../snapshot.js";
import { humanClick, humanType, isHumanMode, microDelay, humanDelay } from "../human.js";

export type ToolResult = { content: any[]; isError?: boolean };

export const ok = (text: string): ToolResult => ({ content: [{ type: "text" as const, text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text" as const, text }], isError: true });

/** Accept "example.com", "localhost:3000", full URLs and about:/data:/file: URLs. */
export function normalizeInputUrl(url: string): string {
  const u = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|file|chrome|javascript|blob):/i.test(u)) return u;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/i.test(u);
  return (local ? "http://" : "https://") + u;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export function pageInfo(id: number, url: string, title: string): string {
  return `[${id}] ${title} | ${url}`;
}

/** Wait for the DOM to go quiet (no mutations for `quiet` ms), capped at `max` ms. Runs in page. */
function domQuiet(a: { quiet: number; max: number }): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: any;
    const done = () => {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve(true);
    };
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, a.quiet);
    });
    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, a.quiet);
    const cap = setTimeout(done, a.max);
  });
}

/**
 * Let the page settle after an action: waits for DOM mutations to stop, and if
 * the action started a navigation, for the new document to load.
 */
export async function settle(page: Page, run: () => Promise<any>): Promise<{ navigated: boolean; result: any }> {
  let navRequested = false;
  let navCommitted = false;
  const main = page.mainFrame();
  const onReq = (r: Request) => {
    try {
      if (r.isNavigationRequest() && r.frame() === main) navRequested = true;
    } catch {
      /* frame detached */
    }
  };
  const onNav = (f: Frame) => {
    if (f === main) navCommitted = true;
  };
  page.on("request", onReq);
  page.on("framenavigated", onNav);
  try {
    const result = await run();
    await page.evaluate(domQuiet, { quiet: isHumanMode() ? 250 : 120, max: 1500 }).catch(() => {});
    if (navRequested && !navCommitted) {
      await page.waitForEvent("framenavigated", { predicate: (f) => f === main, timeout: 10_000 }).catch(() => {});
    }
    if (navRequested || navCommitted) {
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    }
    return { navigated: navCommitted, result };
  } finally {
    page.off("request", onReq);
    page.off("framenavigated", onNav);
  }
}

export type SnapshotReturn = "diff" | "full" | "none";

/**
 * Compact report of what an action changed: navigation, new tabs, dialogs, and
 * (when a snapshot exists for this page) the snapshot lines that changed.
 */
export async function actionReport(
  browser: BrowserManager,
  page: Page,
  pageId: number,
  navigated: boolean,
  mode: SnapshotReturn = "diff"
): Promise<string> {
  const parts: string[] = [];
  const dialog = browser.takeDialogNote(page);
  if (dialog) parts.push(`dialog ${dialog}`);
  const active = browser.getActivePageId();
  if (active !== null && active !== pageId) {
    const { page: np } = await browser.getOrCreatePage(active);
    await np.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    parts.push(`opened new tab ${pageInfo(active, np.url(), await np.title().catch(() => ""))} (now active)`);
    return parts.join("\n");
  }
  if (navigated) {
    parts.push(`→ ${pageInfo(pageId, page.url(), await page.title().catch(() => ""))}`);
    if (mode === "full" || (mode === "diff" && hasSnapshot(page))) {
      const snap = await takeSnapshot(page, {}).catch(() => null);
      if (snap) parts.push(truncate(snap.text, 6000));
    }
    return parts.join("\n");
  }
  if (mode === "full") {
    const snap = await takeSnapshot(page, {}).catch(() => null);
    if (snap) parts.push(truncate(snap.text, 8000));
  } else if (mode === "diff" && hasSnapshot(page)) {
    const d = await diffSnapshot(page, {}).catch(() => null);
    if (d) parts.push(d);
  }
  return parts.join("\n");
}

/** Click an element: Playwright actionability in fast mode, Bezier mouse in human mode. */
export async function clickHandle(
  page: Page,
  el: ElementHandle,
  opts: { button?: "left" | "right" | "middle"; clickCount?: number } = {}
): Promise<string> {
  if (isHumanMode()) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const box = await el.boundingBox();
    if (box) {
      await humanClick(page, box.x + box.width / 2, box.y + box.height / 2, opts);
      return "";
    }
  }
  try {
    await el.click({ button: opts.button ?? "left", clickCount: opts.clickCount ?? 1, timeout: 5_000 });
    return "";
  } catch (e: any) {
    // Covered by an overlay / not "stable": fall back to a DOM click.
    if (/intercepts pointer events|not stable|not visible|outside of the viewport|Timeout/i.test(e.message)) {
      await el.dispatchEvent("click");
      return " (DOM click — element was covered or not visible)";
    }
    throw e;
  }
}

/** Type into an element (or the focused element when `el` is null). */
export async function typeInto(
  page: Page,
  el: ElementHandle | null,
  text: string,
  opts: { clear?: boolean; submit?: boolean } = {}
): Promise<void> {
  if (isHumanMode()) {
    if (el) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const box = await el.boundingBox();
      if (box) await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
      else await el.focus();
    }
    if (opts.clear) {
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await microDelay();
    }
    await humanType(page, text);
  } else if (el) {
    let filled = false;
    if (opts.clear) {
      try {
        await el.fill(text, { timeout: 5_000 });
        filled = true;
      } catch {
        /* not fillable — fall back to keystrokes */
      }
    }
    if (!filled) {
      await el.click({ timeout: 5_000 }).catch(() => el.focus());
      if (opts.clear) {
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(text);
    }
  } else {
    if (opts.clear) {
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.type(text);
  }
  if (opts.submit) {
    await humanDelay(100, 300);
    await page.keyboard.press("Enter");
  }
}

/** Short human-readable description of an element for action confirmations. */
export async function describe(el: ElementHandle): Promise<string> {
  try {
    return await el.evaluate((n: any) => {
      const tag = n.tagName.toLowerCase();
      // Never echo field values (could be passwords).
      const field = tag === "input" || tag === "textarea" || tag === "select";
      const label = (
        n.getAttribute("aria-label") ||
        (field ? n.getAttribute("placeholder") || n.getAttribute("name") || n.id : n.innerText) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      return `<${tag}>${label ? ` "${label.slice(0, 40)}"` : ""}`;
    });
  } catch {
    return "element";
  }
}
