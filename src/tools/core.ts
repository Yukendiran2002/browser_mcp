import { z } from "zod";
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "../browser-manager.js";
import { takeSnapshot } from "../snapshot.js";
import { htmlToMarkdown } from "../content/markdown.js";
import { filterByQuery } from "../content/bm25.js";
import { setHumanMode } from "../human.js";
import { assertAllowed } from "../policy.js";
import { isRef } from "../snapshot.js";
import { recorder, MacroStore, parameterize, instantiate, macroParams } from "../macros.js";
import { mustLocate } from "../utils.js";
import { performStep, STEP_ACTIONS, type Step } from "./actions.js";
import { ok, fail, settle, actionReport, pageInfo, truncate, normalizeInputUrl, type SnapshotReturn, type ToolResult } from "./helpers.js";

const pageId = z.number().optional().describe("Tab id");
const selector = z.string().describe("Ref (e12), CSS, XPath or text");
const snapshotParam = z.enum(["diff", "full", "none"]).optional().describe("Result: diff (default)");

/**
 * Core browsing tools: ref-based snapshots, actions that report their own effects,
 * and batching so multi-step flows cost one round trip.
 */
const lastShot = new WeakMap<Page, string>();

export function registerCoreTools(server: McpServer, browser: BrowserManager, macros: MacroStore): void {
  /** Run one action with settle + effect report. */
  const record = (s: Step) => recorder.push(s);

  async function act(pid: number | undefined, step: Step, snap: SnapshotReturn | undefined): Promise<ToolResult> {
    try {
      const { id, page } = await browser.getOrCreatePage(pid);
      const { navigated, result } = await settle(page, () => performStep(page, step, 5_000, record));
      const report = await actionReport(browser, page, id, navigated || step.action === "navigate", snap ?? "diff");
      return ok(report ? `${result}\n${report}` : result);
    } catch (e: any) {
      return fail(`${step.action} failed: ${e.message.split("\n")[0]}`);
    }
  }

  /** Run steps in order with settle + effect report (used by batch and macro run). */
  async function runSteps(pid: number | undefined, steps: Step[], continueOnError: boolean, snapshot?: SnapshotReturn): Promise<ToolResult> {
    try {
      const { id, page: first } = await browser.getOrCreatePage(pid);
      let page = first;
      let navigated = false;
      const lines: string[] = [];
      let failed = false;
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        try {
          const r = await settle(page, () => performStep(page, step, 5_000, record));
          navigated = navigated || r.navigated || step.action === "navigate";
          lines.push(`${i + 1}. ✓ ${r.result}`);
          // Follow a tab the step opened.
          const active = browser.getActivePageId();
          if (active !== null && active !== id && pid === undefined) {
            page = (await browser.getOrCreatePage(active)).page;
          }
        } catch (e: any) {
          failed = true;
          lines.push(`${i + 1}. ✗ ${step.action}: ${e.message.split("\n")[0]}`);
          if (!continueOnError) {
            if (i < steps.length - 1) lines.push(`(stopped; ${steps.length - i - 1} step(s) not run)`);
            break;
          }
        }
      }
      const report = await actionReport(browser, page, browser.getActivePageId() ?? id, navigated, snapshot ?? "diff");
      const out = lines.join("\n") + (report ? "\n" + report : "");
      return failed && !continueOnError ? fail(out) : ok(out);
    } catch (e: any) {
      return fail(`batch failed: ${e.message}`);
    }
  }

  server.tool(
    "browser_connect",
    "(Re)connect the browser. Optional: tools auto-connect. cdpUrl/userDataDir reuse a logged-in Chrome.",
    {
      cdpUrl: z.string().optional(),
      userDataDir: z.string().optional(),
      executablePath: z.string().optional(),
      headless: z.boolean().optional(),
      browserEngine: z.enum(["chromium", "firefox", "webkit"]).optional(),
      channel: z.string().optional().describe("chrome, msedge…"),
      proxyServer: z.string().optional(),
      device: z.string().optional().describe("e.g. iPhone 15"),
      viewportWidth: z.number().optional(),
      viewportHeight: z.number().optional(),
      human: z.boolean().optional().describe("Human-like timing (slower, stealthier)"),
    },
    async (args) => {
      try {
        const map: Record<string, string> = { browserEngine: "browser" };
        const opts: any = {};
        for (const [k, v] of Object.entries(args)) if (v !== undefined) opts[map[k] || k] = v;
        browser.options = { ...browser.options, ...opts };
        if (args.human !== undefined) setHumanMode(args.human);
        const msg = await browser.connect();
        const pages = await browser.listPagesWithTitles();
        const list = pages.map((p) => `  ${pageInfo(p.id, p.url, p.title)}`).join("\n");
        return ok(`${msg}${args.human ? " (human mode)" : ""}\nTabs(${pages.length}):\n${list || "  (none)"}`);
      } catch (e: any) {
        return fail(`Connection failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "navigate",
    "Open a URL in the active tab; optionally return its snapshot or markdown too.",
    {
      url: z.string(),
      pageId,
      waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
      returns: z.enum(["info", "snapshot", "markdown"]).optional(),
    },
    async ({ url, pageId: pid, waitUntil, returns }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pid);
        url = normalizeInputUrl(url);
        assertAllowed(url);
        const resp = await page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded", timeout: 30_000 });
        const status = resp ? ` · ${resp.status()}` : "";
        const head = pageInfo(id, page.url(), await page.title().catch(() => "")) + status;
        if (returns === "snapshot") {
          await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
          return ok(`${head}\n${truncate((await takeSnapshot(page)).text, 12_000)}`);
        }
        if (returns === "markdown") {
          await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
          const md = await page.evaluate(htmlToMarkdown, { mainContent: true, visibleOnly: true });
          return ok(`${head}\n\n${truncate(md.markdown, 8_000)}`);
        }
        return ok(head);
      } catch (e: any) {
        return fail(`Navigation failed: ${e.message.split("\n")[0]}`);
      }
    }
  );

  server.tool("go_back", "Go back in history.", { pageId }, async ({ pageId: pid }) => act(pid, { action: "back" }, "none"));
  server.tool("go_forward", "Go forward in history.", { pageId }, async ({ pageId: pid }) => act(pid, { action: "forward" }, "none"));
  server.tool("reload", "Reload the page.", { pageId }, async ({ pageId: pid }) => act(pid, { action: "reload" }, "none"));

  server.tool(
    "snapshot",
    "List actionable elements with refs ([e12]) plus headings. Pass refs as selector to other tools.",
    {
      pageId,
      mode: z.enum(["interactive", "full"]).optional().describe("full adds text blocks"),
      viewportOnly: z.boolean().optional(),
      urls: z.boolean().optional().describe("Show link targets"),
      find: z.string().optional().describe("Only lines matching text or /regex/"),
      root: z.string().optional().describe("CSS region to snapshot"),
      maxChars: z.number().optional(),
    },
    async ({ pageId: pid, mode, viewportOnly, urls, find, root, maxChars }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pid);
        const snap = await takeSnapshot(page, { mode, viewportOnly, urls, find, root });
        const head = pageInfo(id, page.url(), await page.title().catch(() => ""));
        return ok(`${head}\n${truncate(snap.text, maxChars ?? 12_000)}`);
      } catch (e: any) {
        return fail(`Snapshot failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "click",
    "Click an element; returns what changed.",
    {
      selector,
      pageId,
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
      snapshot: snapshotParam,
    },
    async ({ selector: sel, pageId: pid, button, doubleClick, snapshot }) =>
      act(pid, { action: "click", selector: sel, button, double: doubleClick }, snapshot)
  );

  server.tool(
    "type_text",
    "Type into an element (or the focused one).",
    {
      text: z.string(),
      selector: selector.optional(),
      pageId,
      clearFirst: z.boolean().optional(),
      pressEnter: z.boolean().optional(),
      snapshot: snapshotParam,
    },
    async ({ text, selector: sel, pageId: pid, clearFirst, pressEnter, snapshot }) =>
      act(pid, { action: "type", selector: sel, text, clear: clearFirst, submit: pressEnter }, snapshot)
  );

  server.tool(
    "fill_form",
    "Fill inputs, selects and checkboxes (value true/false) in one call.",
    {
      fields: z.array(z.object({ selector: z.string(), value: z.string() })),
      pageId,
      submit: z.boolean().optional().describe("Enter in last field"),
      snapshot: snapshotParam,
    },
    async ({ fields, pageId: pid, submit, snapshot }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pid);
        const { navigated, result } = await settle(page, async () => {
          const done: string[] = [];
          for (let i = 0; i < fields.length; i++) {
            const f = fields[i];
            const el = await mustLocate(page, f.selector);
            const kind = await el.evaluate((n: any) => (n.tagName === "SELECT" ? "select" : n.type === "checkbox" || n.type === "radio" ? "check" : "text"));
            const last = i === fields.length - 1;
            if (kind === "select") done.push(await performStep(page, { action: "select", selector: f.selector, value: f.value }, 5_000, record));
            else if (kind === "check") done.push(await performStep(page, { action: /^(false|0|off|no)$/i.test(f.value) ? "uncheck" : "check", selector: f.selector }, 5_000, record));
            else done.push(await performStep(page, { action: "fill", selector: f.selector, text: f.value, submit: submit && last }, 5_000, record));
          }
          return `filled ${fields.length} field(s)${submit ? " + submitted" : ""}`;
        });
        const report = await actionReport(browser, page, id, navigated, snapshot ?? "diff");
        return ok(report ? `${result}\n${report}` : result);
      } catch (e: any) {
        return fail(`fill_form failed: ${e.message.split("\n")[0]}`);
      }
    }
  );

  server.tool(
    "select_option",
    "Pick an option (label or value) in a select or custom dropdown.",
    { selector, value: z.string(), pageId },
    async ({ selector: sel, value, pageId: pid }) => act(pid, { action: "select", selector: sel, value }, "diff")
  );

  server.tool(
    "hover",
    "Hover an element (menus, tooltips).",
    { selector, pageId },
    async ({ selector: sel, pageId: pid }) => act(pid, { action: "hover", selector: sel }, "diff")
  );

  server.tool(
    "press_key",
    "Press a key/combo (Enter, Escape, ArrowDown, ControlOrMeta+A), optionally on an element.",
    { key: z.string(), selector: selector.optional(), pageId },
    async ({ key, selector: sel, pageId: pid }) => act(pid, { action: "press", key, selector: sel }, "diff")
  );

  server.tool(
    "scroll",
    "Scroll page/element by direction, or pass only selector to scroll it into view.",
    {
      direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
      amount: z.number().optional().describe("px, default 600"),
      selector: selector.optional(),
      pageId,
    },
    async ({ direction, amount, selector: sel, pageId: pid }) => act(pid, { action: "scroll", direction, amount, selector: sel }, "none")
  );

  server.tool(
    "wait_for",
    "Wait for text/element to appear (or vanish: gone), a URL, network idle, or ms.",
    {
      text: z.string().optional(),
      selector: selector.optional(),
      url: z.string().optional(),
      ms: z.number().optional(),
      gone: z.boolean().optional(),
      timeout: z.number().optional(),
      pageId,
    },
    async ({ pageId: pid, ...rest }) => act(pid, { action: "wait", ...rest }, "none")
  );

  server.tool(
    "upload_file",
    "Set file(s) on a file input.",
    { selector, files: z.array(z.string()).describe("Absolute file paths"), pageId },
    async ({ selector: sel, files, pageId: pid }) => act(pid, { action: "upload", selector: sel, files }, "none")
  );

  server.tool(
    "drag_and_drop",
    "Drag one element onto another.",
    { selector, to: z.string().describe("Target element (ref/selector)"), pageId, snapshot: snapshotParam },
    async ({ selector: sel, to, pageId: pid, snapshot }) => act(pid, { action: "drag", selector: sel, to }, snapshot)
  );

  server.tool(
    "handle_dialog",
    "Answer the next alert/confirm/prompt (default: alerts accepted, confirms dismissed).",
    { action: z.enum(["accept", "dismiss"]), promptText: z.string().optional(), pageId },
    async ({ action, promptText, pageId: pid }) => {
      try {
        const { page } = await browser.getOrCreatePage(pid);
        browser.setNextDialog(page, action, promptText);
        return ok(`Will ${action} the next dialog`);
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.tool(
    "batch",
    `Run many actions in one call; stops at first failure. E.g. [{"action":"fill","selector":"e3","text":"a@b.c"},{"action":"click","selector":"e7"},{"action":"wait","text":"Welcome"}]`,
    {
      steps: z
        .array(
          z.object({
            action: z.enum(STEP_ACTIONS),
            selector: z.string().optional(),
            text: z.string().optional(),
            value: z.string().optional(),
            url: z.string().optional(),
            key: z.string().optional(),
            ms: z.number().optional(),
            direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
            amount: z.number().optional(),
            submit: z.boolean().optional(),
            to: z.string().optional(),
            files: z.array(z.string()).optional(),
            script: z.string().optional(),
            gone: z.boolean().optional(),
          })
        )
        .min(1)
        .max(50),
      pageId,
      continueOnError: z.boolean().optional(),
      snapshot: snapshotParam,
    },
    async ({ steps, pageId: pid, continueOnError, snapshot }) => runSteps(pid, steps as Step[], !!continueOnError, snapshot)
  );

  server.tool(
    "macro",
    "Replay flows without LLM reasoning. Your actions are recorded automatically: save turns recent steps into a named macro (params turns example values into variables); run replays it with vars.",
    {
      action: z.enum(["save", "run", "list", "show", "delete", "clear"]),
      name: z.string().optional(),
      last: z.number().optional().describe("save: only the last N recorded steps"),
      params: z.record(z.string()).optional().describe('save: {"query":"laptops"} → {{query}}'),
      vars: z.record(z.string()).optional().describe("run: values for params"),
      pageId,
    },
    async ({ action, name, last, params, vars, pageId: pid }) => {
      try {
        if (action === "clear") {
          recorder.steps = [];
          return ok("Recording cleared");
        }
        if (action === "list") {
          const l = macros.list();
          return ok(l.length ? l.map((m) => `${m.name}(${m.params.join(", ")}): ${m.steps.length} steps`).join("\n") : `No macros (${macros.dir})`);
        }
        if (action === "show" && !name) {
          return ok(recorder.steps.length ? recorder.steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n") : "Nothing recorded yet");
        }
        if (!name) return fail("name is required");
        if (action === "save") {
          const steps = last ? recorder.steps.slice(-last) : recorder.steps.slice();
          if (!steps.length) return fail("Nothing recorded yet — perform the flow first (navigate/click/type/batch).");
          const unstable = steps.filter((s) => (s.selector && isRef(s.selector)) || (s.to && isRef(s.to)));
          const p = parameterize(steps, params || {});
          const m = { name, params: macroParams(p), steps: p, created: new Date().toISOString() };
          const path = macros.save(m);
          return ok(
            `Saved macro "${name}" (${p.length} steps, params: ${m.params.join(", ") || "none"}) → ${path}` +
              (unstable.length ? `\nwarning: ${unstable.length} step(s) inside iframes kept snapshot refs and may not replay` : "") +
              `\n${p.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n")}`
          );
        }
        if (action === "show") {
          const m = macros.load(name);
          return ok(`${m.name}(${m.params.join(", ")})\n${m.steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`).join("\n")}`);
        }
        if (action === "delete") {
          macros.delete(name);
          return ok(`Deleted macro ${name}`);
        }
        const m = macros.load(name);
        const steps = instantiate(m.steps, vars || {});
        recorder.paused = true;
        try {
          return await runSteps(pid, steps, false, "none");
        } finally {
          recorder.paused = false;
        }
      } catch (e: any) {
        return fail(`macro ${action} failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "tabs",
    "List (default), open, close or focus tabs.",
    {
      action: z.enum(["list", "new", "close", "focus"]).optional(),
      pageId: z.number().optional(),
      url: z.string().optional(),
    },
    async ({ action, pageId: pid, url }) => {
      try {
        await browser.ensureContext();
        if (action === "new") {
          const { id, page } = await browser.newPage(url);
          return ok(`+ ${pageInfo(id, page.url(), await page.title().catch(() => ""))} (active)`);
        }
        if (action === "close") {
          if (pid === undefined) return fail("pageId required");
          await browser.closePage(pid);
        }
        if (action === "focus") {
          if (pid === undefined) return fail("pageId required");
          await browser.focusPage(pid);
        }
        const active = browser.getActivePageId();
        const pages = await browser.listPagesWithTitles();
        return ok(pages.map((p) => `${p.id === active ? "*" : " "}${pageInfo(p.id, p.url, p.title)}`).join("\n") || "(no tabs)");
      } catch (e: any) {
        return fail(e.message);
      }
    }
  );

  server.tool(
    "take_screenshot",
    "Screenshot viewport/full page/element (JPEG). Prefer snapshot or read_page unless pixels matter.",
    {
      pageId,
      selector: selector.optional(),
      fullPage: z.boolean().optional(),
      format: z.enum(["jpeg", "png"]).optional(),
      quality: z.number().optional(),
      path: z.string().optional().describe("Save to file"),
      ifChanged: z.boolean().optional().describe("Skip the image if identical to the last one"),
    },
    async ({ pageId: pid, selector: sel, fullPage, format, quality, path, ifChanged }) => {
      try {
        const { page } = await browser.getOrCreatePage(pid);
        const type = format ?? "jpeg";
        const opts: any = { type, path, scale: "css", ...(type === "jpeg" ? { quality: quality ?? 60 } : {}) };
        const buffer = sel ? await (await mustLocate(page, sel)).screenshot(opts) : await page.screenshot({ ...opts, fullPage: fullPage ?? false });
        if (path) return ok(`Saved ${path} (${Math.round(buffer.length / 1024)} KB)`);
        const hash = createHash("sha1").update(buffer).digest("hex");
        const prev = lastShot.get(page);
        lastShot.set(page, hash);
        if (ifChanged && prev === hash) return ok("Screenshot unchanged since the last one (image omitted)");
        return { content: [{ type: "image" as const, data: buffer.toString("base64"), mimeType: `image/${type}` }] };
      } catch (e: any) {
        return fail(`Screenshot failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "read_page",
    "Current page as clean markdown (main content). query= keeps only relevant sections.",
    {
      pageId,
      query: z.string().optional(),
      selector: z.string().optional().describe("CSS region to read"),
      mainContent: z.boolean().optional(),
      links: z.enum(["inline", "refs", "none"]).optional(),
      images: z.boolean().optional(),
      maxChars: z.number().optional(),
    },
    async ({ pageId: pid, query, selector: sel, mainContent, links, images, maxChars }) => {
      try {
        const { id, page } = await browser.getOrCreatePage(pid);
        const md = await page.evaluate(htmlToMarkdown, {
          mainContent: sel ? false : mainContent ?? true,
          selector: sel,
          links: links ?? "inline",
          images: images ?? false,
          visibleOnly: true,
        });
        const max = maxChars ?? 8_000;
        let text = md.markdown;
        let note = "";
        if (query) {
          const f = filterByQuery(text, query, max);
          text = f.markdown || "(no section matched the query)";
          note = ` · query kept ${f.kept}/${f.total} sections`;
        }
        const total = md.markdown.length;
        if (text.length > max) text = text.slice(0, max) + `\n…(truncated; ${total} chars total — use query= or maxChars=)`;
        return ok(`${pageInfo(id, page.url(), md.title)} · ~${Math.round(text.length / 4)} tokens${note}\n\n${text || "(no text content)"}`);
      } catch (e: any) {
        return fail(`read_page failed: ${e.message}`);
      }
    }
  );

  server.tool(
    "evaluate_javascript",
    "Run JavaScript in the page; returns JSON.",
    { script: z.string(), pageId, maxChars: z.number().optional() },
    async ({ script, pageId: pid, maxChars }) => {
      try {
        const { page } = await browser.getOrCreatePage(pid);
        const result = await page.evaluate(script);
        const out = typeof result === "string" ? result : JSON.stringify(result);
        return ok(truncate(out ?? "undefined", maxChars ?? 6_000));
      } catch (e: any) {
        return fail(`JS error: ${e.message}`);
      }
    }
  );

  server.tool("close_browser", "Close (or detach from) the browser.", {}, async () => {
    await browser.close();
    return ok("Browser closed");
  });
}
