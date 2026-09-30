import type { Page, ElementHandle } from "playwright";
import { mustLocate, locate } from "../utils.js";
import { isRef } from "../snapshot.js";
import { stableSelector } from "../macros.js";
import { clickHandle, typeInto, describe, truncate, normalizeInputUrl } from "./helpers.js";
import { resolveSecrets } from "../governor.js";
import { assertAllowed } from "../policy.js";
import { humanHover, humanScroll, isHumanMode } from "../human.js";

/** One browser action. Used by the individual tools and by `batch`. */
export interface Step {
  action: string;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  key?: string;
  ms?: number;
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom";
  amount?: number;
  clear?: boolean;
  submit?: boolean;
  button?: "left" | "right" | "middle";
  double?: boolean;
  files?: string[];
  to?: string;
  script?: string;
  gone?: boolean;
  timeout?: number;
}

export const STEP_ACTIONS = [
  "navigate", "back", "forward", "reload", "click", "type", "fill", "select", "check", "uncheck", "hover",
  "press", "scroll", "wait", "upload", "drag", "eval",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function need<T>(v: T | undefined, name: string, action: string): T {
  if (v === undefined || v === null || (v as any) === "") throw new Error(`${action}: "${name}" is required`);
  return v;
}

/** Perform a step and return a one-line confirmation. Throws on failure. */
type Finder = (selector: string, timeout: number, required?: boolean) => Promise<ElementHandle | null>;

/**
 * Perform a step and return a one-line confirmation. Throws on failure.
 * `record` receives a replayable copy of the step: snapshot refs (which only live
 * as long as the page) are swapped for stable selectors, so the step can be saved
 * in a macro and replayed later.
 */
export async function performStep(page: Page, s: Step, defaultTimeout = 5_000, record?: (step: Step) => void): Promise<string> {
  const stable = new Map<string, string>();
  const find: Finder = async (sel, timeout, required = true) => {
    const el = required ? await mustLocate(page, sel, timeout) : await locate(page, sel, timeout);
    if (el && record && isRef(sel)) stable.set(sel, await stableSelector(el));
    return el;
  };
  const text = await runStep(page, s, defaultTimeout, find);
  if (record) {
    const r: Step = { ...s };
    if (s.selector) r.selector = stable.get(s.selector) ?? s.selector;
    if (s.to) r.to = stable.get(s.to) ?? s.to;
    record(r);
  }
  return text;
}

async function runStep(page: Page, s: Step, defaultTimeout: number, find: Finder): Promise<string> {
  const t = s.timeout ?? defaultTimeout;
  switch (s.action) {
    case "navigate": {
      const url = normalizeInputUrl(resolveSecrets(need(s.url, "url", "navigate")));
      assertAllowed(url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: s.timeout ?? 30_000 });
      return `navigated ${page.url()}`;
    }
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded" });
      return `back ${page.url()}`;
    case "forward":
      await page.goForward({ waitUntil: "domcontentloaded" });
      return `forward ${page.url()}`;
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded" });
      return "reloaded";
    case "click": {
      const el = (await find(need(s.selector, "selector", "click"), t))!;
      const what = await describe(el);
      const note = await clickHandle(page, el, { button: s.button, clickCount: s.double ? 2 : 1 });
      return `clicked ${what}${note}`;
    }
    case "type":
    case "fill": {
      const text = need(s.text ?? s.value, "text", s.action);
      const el = s.selector ? (await find(s.selector, t))! : null;
      const secret = el ? await el.evaluate((n: any) => n.type === "password").catch(() => false) : false;
      await typeInto(page, el, resolveSecrets(text), { clear: s.action === "fill" || !!s.clear, submit: s.submit });
      const shown = secret && !/\{\{\s*secret\./.test(text) ? "••••" : truncate(text, 40);
      return `typed "${shown}"${el ? ` into ${await describe(el)}` : ""}${s.submit ? " + Enter" : ""}`;
    }
    case "select": {
      const el = (await find(need(s.selector, "selector", "select"), t))!;
      const v = need(s.value ?? s.text, "value", "select");
      let picked: string[] = [];
      try {
        picked = await el.selectOption({ label: v }, { timeout: 2_000 });
      } catch {
        picked = await el.selectOption(v, { timeout: 2_000 }).catch(() => []);
      }
      if (!picked.length) {
        // Custom dropdowns: open it and click the option by text.
        await clickHandle(page, el);
        const opt = await locate(page, v, 3_000);
        if (!opt) throw new Error(`Option "${v}" not found`);
        await clickHandle(page, opt);
        return `selected "${v}" (custom dropdown)`;
      }
      return `selected "${v}"`;
    }
    case "check":
    case "uncheck": {
      const el = (await find(need(s.selector, "selector", s.action), t))!;
      try {
        if (s.action === "check") await el.check({ timeout: 3_000 });
        else await el.uncheck({ timeout: 3_000 });
      } catch {
        await clickHandle(page, el);
      }
      return `${s.action}ed ${await describe(el)}`;
    }
    case "hover": {
      const el = (await find(need(s.selector, "selector", "hover"), t))!;
      if (isHumanMode()) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        const box = await el.boundingBox();
        if (box) await humanHover(page, box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await el.hover({ timeout: t });
      }
      return `hovering ${await describe(el)}`;
    }
    case "press": {
      const key = need(s.key ?? s.text, "key", "press");
      if (s.selector) await ((await find(s.selector, t))!).focus();
      await page.keyboard.press(key);
      return `pressed ${key}`;
    }
    case "scroll": {
      if (s.selector && !s.direction) {
        const el = (await find(s.selector, t))!;
        await el.scrollIntoViewIfNeeded();
        return `scrolled to ${await describe(el)}`;
      }
      const dir = s.direction ?? "down";
      if (dir === "top" || dir === "bottom") {
        await page.evaluate((d) => window.scrollTo({ top: d === "top" ? 0 : document.documentElement.scrollHeight }), dir);
        return `scrolled to ${dir}`;
      }
      const px = s.amount ?? 600;
      const dx = dir === "right" ? px : dir === "left" ? -px : 0;
      const dy = dir === "down" ? px : dir === "up" ? -px : 0;
      if (s.selector) {
        const el = (await find(s.selector, t))!;
        await el.evaluate((n: Element, d: { dx: number; dy: number }) => n.scrollBy(d.dx, d.dy), { dx, dy });
      } else {
        await humanScroll(page, dy, dx);
      }
      const y = await page.evaluate(() => [Math.round(scrollY), document.documentElement.scrollHeight - innerHeight]);
      return `scrolled ${dir} ${px}px (at ${y[0]}/${Math.max(0, y[1])})`;
    }
    case "wait": {
      if (s.ms && !s.selector && !s.text && !s.url) {
        await sleep(Math.min(s.ms, 60_000));
        return `waited ${s.ms}ms`;
      }
      const timeout = s.timeout ?? 15_000;
      if (s.text) {
        await page.getByText(s.text).first().waitFor({ state: s.gone ? "hidden" : "visible", timeout });
        return `text ${s.gone ? "gone" : "visible"}: "${truncate(s.text, 40)}"`;
      }
      if (s.selector) {
        if (s.gone) {
          const el = await find(s.selector, 0, false);
          if (el) await el.waitForElementState("hidden", { timeout });
          return `gone: ${s.selector}`;
        }
        const el = await find(s.selector, timeout, false);
        if (!el) throw new Error(`Timed out waiting for ${s.selector}`);
        return `found: ${s.selector}`;
      }
      if (s.url) {
        const u = s.url;
        await page.waitForURL((x) => x.href.includes(u) || new RegExp(u.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(x.href), { timeout });
        return `url: ${page.url()}`;
      }
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
      return "network idle";
    }
    case "upload": {
      const el = (await find(need(s.selector, "selector", "upload"), t))!;
      const files = need(s.files, "files", "upload");
      await el.setInputFiles(files);
      return `uploaded ${files.length} file(s)`;
    }
    case "drag": {
      const src = (await find(need(s.selector, "selector", "drag"), t))!;
      const dst = (await find(need(s.to, "to", "drag"), t))!;
      const a = await src.boundingBox();
      const b = await dst.boundingBox();
      if (!a || !b) throw new Error("drag: element not visible");
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: isHumanMode() ? 20 : 5 });
      await page.mouse.up();
      return "dragged";
    }
    case "eval": {
      const r = await page.evaluate(need(s.script, "script", "eval"));
      const out = typeof r === "string" ? r : JSON.stringify(r);
      return `eval → ${truncate(out ?? "undefined", 300)}`;
    }
    default:
      throw new Error(`Unknown action "${s.action}". Use one of: ${STEP_ACTIONS.join(", ")}`);
  }
}
