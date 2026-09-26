import type { Page, ElementHandle } from "playwright";
import { isRef, resolveRef } from "./snapshot.js";

/**
 * Utility helpers shared across tools.
 */

/** Wait for network to be idle after an action. */
export async function waitForStable(page: Page, timeout = 5000): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
  } catch {
    // Best-effort; don't fail the tool call
  }
}

const HTML_TAGS = new Set(
  ("a abbr address article aside audio b blockquote body button canvas caption code dd details dialog div dl dt em " +
    "fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input label legend li main nav ol " +
    "option p pre section select small span strong summary table tbody td textarea th thead tr ul video svg").split(" ")
);

/** Build a smart CSS/XPath/text selector from user input. */
export function buildSelector(selector: string): string {
  const s = selector.trim();
  // Explicit Playwright engine (css=, xpath=, text=, role=, internal:…)
  if (/^(css|xpath|text|role|id|data-testid|nth|internal:[a-z-]+)=/.test(s) || s.startsWith("internal:")) return s;
  if (s.startsWith("//") || s.startsWith("(//")) return `xpath=${s}`;
  if (HTML_TAGS.has(s.toLowerCase())) return s.toLowerCase();
  // Looks like CSS (has . # [ > : ~ + * or a tag followed by combinators)
  if (/[.#\[\]>:~+*=]/.test(s) && !/\s{2,}/.test(s) && /^[\w.#\[*:-]/.test(s)) return s;
  // Plain words → exact visible text
  return `text="${s.replace(/"/g, '\\"')}"`;
}

/** Candidate selectors for free text: exact text, then labels/attributes, then substring. */
function textCandidates(s: string): string[] {
  const q = JSON.stringify(s);
  return [
    `text=${q}`,
    `internal:label=${q}i`,
    `[aria-label=${q} i]`,
    `[placeholder=${q} i]`,
    `[title=${q} i]`,
    `text=${s}`,
  ];
}

/**
 * Resolve a selector, visible text, or snapshot ref ("e12", "f1e3") to an element.
 * Waits up to `timeout` ms for the element to appear. Returns null if not found;
 * throws for stale refs so the agent knows to take a fresh snapshot.
 */
export async function locate(page: Page, selector: string, timeout = 5000): Promise<ElementHandle | null> {
  const s = selector.trim();
  if (isRef(s)) {
    const el = await resolveRef(page, s);
    if (!el) throw new Error(`Ref ${s} is stale or unknown — call snapshot to get fresh refs`);
    return el;
  }
  const built = buildSelector(s);
  const candidates = built.startsWith('text="') ? textCandidates(s) : [built];
  for (const c of candidates) {
    try {
      const el = await page.$(c);
      if (el) return toControl(el);
    } catch {
      /* invalid selector for this engine — try the next */
    }
  }
  if (timeout <= 0) return null;
  try {
    let loc = page.locator(candidates[0]);
    for (const c of candidates.slice(1)) loc = loc.or(page.locator(c));
    const first = loc.first();
    await first.waitFor({ state: "attached", timeout });
    const el = await first.elementHandle({ timeout: 1000 });
    return el ? toControl(el) : null;
  } catch {
    return null;
  }
}

/** A <label> matched by text stands for its form control. */
async function toControl(el: ElementHandle): Promise<ElementHandle> {
  const control = await el.evaluateHandle((n: any) => (n.tagName === "LABEL" && n.control ? n.control : n));
  return (control.asElement() as ElementHandle) || el;
}

/** Like locate() but throws a helpful error when nothing matches. */
export async function mustLocate(page: Page, selector: string, timeout = 5000): Promise<ElementHandle> {
  const el = await locate(page, selector, timeout);
  if (!el) throw new Error(`Not found: ${selector} (tip: call snapshot and use a ref like e12)`);
  return el;
}

/** Take a lightweight text snapshot of visible page elements using ARIA. */
export async function getAccessibilityTree(page: Page): Promise<string> {
  try {
    // Use Playwright's ariaSnapshot which returns a YAML-like tree of ARIA roles
    const snapshot = await page.locator("body").ariaSnapshot();
    return snapshot || "(empty page)";
  } catch {
    // Fallback: build a simple summary from the DOM
    try {
      return await page.evaluate(() => {
        const elements: string[] = [];
        const walk = (el: Element, depth: number) => {
          const indent = "  ".repeat(depth);
          const role = el.getAttribute("role") || el.tagName.toLowerCase();
          const label = el.getAttribute("aria-label") || (el as HTMLElement).innerText?.slice(0, 60) || "";
          if (["script", "style", "noscript", "br", "hr"].includes(el.tagName.toLowerCase())) return;
          elements.push(`${indent}[${role}] ${label.trim()}`);
          if (elements.length > 200) return;
          for (const child of Array.from(el.children)) {
            walk(child, depth + 1);
          }
        };
        if (document.body) walk(document.body, 0);
        return elements.join("\n") || "(empty page)";
      });
    } catch {
      return "(could not read accessibility tree)";
    }
  }
}

/** Extract readable text content from the page (trimmed). */
export async function getPageText(page: Page, maxLength = 8000): Promise<string> {
  const text = await page.evaluate(() => {
    const body = document.body;
    if (!body) return "";
    // Remove script/style content
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    return clone.innerText || clone.textContent || "";
  });
  const trimmed = text.replace(/\n{3,}/g, "\n\n").trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + "\n...(truncated)" : trimmed;
}

/** Get structured info about form elements on the page. */
export async function getFormElements(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    const elements: any[] = [];
    document.querySelectorAll("input, textarea, select, button, [role='button'], [contenteditable]").forEach((el, index) => {
      const htmlEl = el as HTMLElement;
      const input = el as HTMLInputElement;
      elements.push({
        index,
        tag: el.tagName.toLowerCase(),
        type: input.type || undefined,
        name: input.name || undefined,
        id: el.id || undefined,
        placeholder: input.placeholder || undefined,
        value: input.value || undefined,
        text: htmlEl.innerText?.slice(0, 100) || undefined,
        ariaLabel: el.getAttribute("aria-label") || undefined,
        selector: el.id ? `#${el.id}` : el.className ? `${el.tagName.toLowerCase()}.${el.className.split(" ").join(".")}` : `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`,
      });
    });
    return elements;
  });
}

/** Get all links on the page. */
export async function getPageLinks(page: Page, maxLinks = 50): Promise<{ text: string; href: string }[]> {
  return page.evaluate((max) => {
    const links: { text: string; href: string }[] = [];
    document.querySelectorAll("a[href]").forEach((el) => {
      if (links.length >= max) return;
      const a = el as HTMLAnchorElement;
      links.push({
        text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 100),
        href: a.href,
      });
    });
    return links;
  }, maxLinks);
}
