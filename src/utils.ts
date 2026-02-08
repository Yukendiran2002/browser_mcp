import { Page } from "playwright";

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

/** Build a smart CSS/XPath/text selector from user input. */
export function buildSelector(selector: string): string {
  // If user passed something that looks like XPath, use it directly
  if (selector.startsWith("//") || selector.startsWith("(//")) {
    return `xpath=${selector}`;
  }
  // If it looks like a CSS selector (has . # [ > : etc.), use as-is
  if (/^[.#\[\w]/.test(selector) && /[.#\[\]>:~+]/.test(selector)) {
    return selector;
  }
  // If it looks like an aria role/label, use text matching
  if (/^[A-Za-z\s]+$/.test(selector.trim())) {
    return `text="${selector}"`;
  }
  return selector;
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
