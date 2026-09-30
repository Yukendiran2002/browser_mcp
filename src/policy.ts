/**
 * Domain policy: --allowed-domains / --blocked-domains (comma-separated, "*.example.com"
 * wildcards). Applied to navigate, scraping and every top-level navigation in the browser.
 */

let allowed: string[] = [];
let blocked: string[] = [];

export function configurePolicy(allow?: string, block?: string): void {
  const parse = (s?: string) => (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  allowed = parse(allow);
  blocked = parse(block);
}

export function policyActive(): boolean {
  return allowed.length > 0 || blocked.length > 0;
}

function matches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
  return host === pattern || host.endsWith("." + pattern);
}

/** Why a URL is not allowed, or null when it is. */
export function denyReason(url: string): string | null {
  let host: string;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (blocked.some((p) => matches(host, p))) return `${host} is blocked by --blocked-domains`;
  if (allowed.length && !allowed.some((p) => matches(host, p))) return `${host} is not in --allowed-domains`;
  return null;
}

export function assertAllowed(url: string): void {
  const r = denyReason(url);
  if (r) throw new Error(r);
}
