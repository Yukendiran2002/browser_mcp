import {
  chromium,
  firefox,
  webkit,
  Browser,
  BrowserContext,
  Page,
  BrowserType,
  ConsoleMessage,
  Request,
  Response,
} from "playwright";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawn, ChildProcess } from "node:child_process";
import { getDevicePreset, DevicePreset, DEVICE_PRESETS } from "./devices.js";

// ─── Types ───────────────────────────────────────────────────

export interface BrowserConnectionOptions {
  /** URL for Chrome DevTools Protocol (e.g. http://localhost:9222) */
  cdpUrl?: string;
  /** Path to a Chrome/Edge user-data-dir to reuse sessions */
  userDataDir?: string;
  /** Path to browser executable (auto-detected if omitted) */
  executablePath?: string;
  /** Launch the browser in headless mode (default: false) */
  headless?: boolean;
  /** Default timeout in ms for actions (default: 30000) */
  defaultTimeout?: number;
  /** Browser engine: 'chromium' | 'firefox' | 'webkit' (default: 'chromium') */
  browser?: "chromium" | "firefox" | "webkit";
  /** Proxy server URL (e.g. http://proxy:8080 or socks5://proxy:1080) */
  proxyServer?: string;
  /** Comma-separated domains to bypass proxy */
  proxyBypass?: string;
  /** Viewport width (default: auto) */
  viewportWidth?: number;
  /** Viewport height (default: auto) */
  viewportHeight?: number;
  /** Device to emulate (e.g. "iPhone 15", "Pixel 7") */
  device?: string;
  /** Record video of browser sessions */
  recordVideo?: boolean;
  /** Directory to save videos (default: ./videos) */
  videoDir?: string;
  /** Geolocation override */
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  /** Permissions to grant (e.g. ["geolocation", "clipboard-read"]) */
  permissions?: string[];
  /** Custom user agent string */
  userAgent?: string;
  /** Extra HTTP headers for all requests */
  extraHTTPHeaders?: Record<string, string>;
  /** Browser locale (e.g. "en-US") */
  locale?: string;
  /** Timezone ID (e.g. "America/New_York") */
  timezoneId?: string;
  /** Color scheme preference */
  colorScheme?: "light" | "dark" | "no-preference";
  /** Path to storage state JSON file to load */
  storageState?: string;
  /** Ignore HTTPS errors */
  ignoreHTTPSErrors?: boolean;
  /** Block service workers */
  blockServiceWorkers?: boolean;
  /** Browser channel: 'chrome', 'msedge', 'chrome-beta', 'msedge-dev' — uses YOUR installed browser */
  channel?: string;
  /** Human-like timing and mouse motion (slower, stealthier). Default: false (fast). */
  human?: boolean;
}

export interface ConsoleLogEntry {
  type: string;
  text: string;
  url: string;
  timestamp: number;
}

export interface NetworkLogEntry {
  url: string;
  method: string;
  status?: number;
  resourceType: string;
  size?: number;
  timestamp: number;
  duration?: number;
}

// ─── Anti-Detection ──────────────────────────────────────────

/** Minimal stealth script for Firefox/WebKit — only hides the webdriver flag.
 *  Chromium doesn't need it: --disable-blink-features=AutomationControlled already
 *  reports navigator.webdriver=false, and redefining it would itself be detectable. */
const STEALTH_SCRIPT = `
  // Hide the webdriver flag that Playwright sets
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  delete navigator.__proto__.webdriver;
`;

/** Minimal launch args — only disable automation detection flag.
 *  No sandbox, networking, or component flags that alter browser behavior. */
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
];

/** Regular (non-headless) Chrome user agent for the given browser version. */
export function chromeUserAgent(version: string): string {
  const major = (version.match(/^(\d+)/) || [])[1] || "140";
  const platform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
        ? "Macintosh; Intel Mac OS X 10_15_7"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// ─── Browser Manager ─────────────────────────────────────────

/**
 * Manages the browser lifecycle: connecting to running instances,
 * launching with existing user profiles, multi-browser support,
 * device emulation, proxy, video recording, and providing pages.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<number, Page> = new Map();
  private nextPageId = 1;
  private activePageId: number | null = null;
  private connecting: Promise<string> | null = null;
  /** Pages opened by the scraper pool — hidden from the agent's tab list. */
  private internalPages = new WeakSet<Page>();
  private pendingInternal = 0;
  /** Attached to someone else's browser over CDP: never close their contexts. */
  private viaCdp = false;
  /** Pending handle_dialog instruction and last dialog seen, per page. */
  private nextDialog = new WeakMap<Page, { action: "accept" | "dismiss"; promptText?: string }>();
  private dialogNotes = new WeakMap<Page, string>();
  options: BrowserConnectionOptions;

  // Tracking infrastructure
  private consoleLogs: Map<number, ConsoleLogEntry[]> = new Map();
  private networkLogs: Map<number, NetworkLogEntry[]> = new Map();
  private blockedPatterns: string[] = [];
  private isRecordingVideo = false;
  private chromeProcess: ChildProcess | null = null;

  constructor(options: BrowserConnectionOptions = {}) {
    this.options = {
      headless: false,
      defaultTimeout: 30_000,
      browser: "chromium",
      ...options,
    };
  }

  // ─── Browser Engine Selection ──────────────────────────────

  private getBrowserType(): BrowserType {
    switch (this.options.browser) {
      case "firefox":
        return firefox;
      case "webkit":
        return webkit;
      case "chromium":
      default:
        return chromium;
    }
  }

  private isChromium(): boolean {
    return (this.options.browser ?? "chromium") === "chromium";
  }

  // ─── Context Options Builder ───────────────────────────────

  private buildContextOptions(): any {
    const opts: any = {};
    const o = this.options;
    const devicePreset = o.device ? getDevicePreset(o.device) : null;

    // Viewport & device emulation
    if (devicePreset) {
      opts.viewport = devicePreset.viewport;
      opts.userAgent = devicePreset.userAgent;
      opts.deviceScaleFactor = devicePreset.deviceScaleFactor;
      opts.isMobile = devicePreset.isMobile;
      opts.hasTouch = devicePreset.hasTouch;
    } else if (o.viewportWidth && o.viewportHeight) {
      opts.viewport = { width: o.viewportWidth, height: o.viewportHeight };
    } else {
      opts.viewport = null; // Use browser default
    }

    // User agent — ONLY override if explicitly set or device emulation is active
    // Changing UA on an existing profile invalidates sessions on many sites (Google, GitHub, etc.)
    if (o.userAgent) {
      opts.userAgent = o.userAgent;
    } else if (!opts.userAgent) {
      // Only set default UA for temporary browsers, NOT for persistent/CDP sessions
      // This is handled per-connection method below
    }

    // Proxy
    if (o.proxyServer) {
      opts.proxy = {
        server: o.proxyServer,
        ...(o.proxyBypass && { bypass: o.proxyBypass }),
      };
    }

    // Geolocation
    if (o.geolocation) {
      opts.geolocation = o.geolocation;
    }

    // Permissions
    if (o.permissions) {
      opts.permissions = o.permissions;
    }

    // Locale & timezone
    if (o.locale) opts.locale = o.locale;
    if (o.timezoneId) opts.timezoneId = o.timezoneId;
    if (o.colorScheme) opts.colorScheme = o.colorScheme;

    // Extra HTTP headers
    if (o.extraHTTPHeaders) {
      opts.extraHTTPHeaders = o.extraHTTPHeaders;
    }

    // HTTPS errors
    if (o.ignoreHTTPSErrors) {
      opts.ignoreHTTPSErrors = true;
    }

    // Video recording
    if (o.recordVideo) {
      opts.recordVideo = {
        dir: o.videoDir || "./videos",
        size: opts.viewport
          ? { width: opts.viewport.width, height: opts.viewport.height }
          : { width: 1280, height: 720 },
      };
      this.isRecordingVideo = true;
    }

    // Storage state
    if (o.storageState && existsSync(o.storageState)) {
      opts.storageState = o.storageState;
    }

    // Service workers
    if (o.blockServiceWorkers) {
      opts.serviceWorkers = "block";
    }

    return opts;
  }

  // ─── Connection Methods ────────────────────────────────────

  /** Connect to an already-running browser via CDP. */
  async connectCDP(cdpUrl?: string): Promise<void> {
    const url = cdpUrl ?? this.options.cdpUrl ?? "http://localhost:9222";
    this.browser = await chromium.connectOverCDP(url);
    this.viaCdp = true;
    const contexts = this.browser.contexts();

    if (contexts.length > 0) {
      // Reuse the EXISTING context — this preserves all cookies, logins, sessions
      this.context = contexts[0];
    } else {
      // No existing context (rare) — create one but DON'T override user agent
      // so that any subsequent logins use the browser's real UA
      this.context = await this.browser.newContext();
    }

    this.attachContext(this.context);
  }

  /**
   * Resolve the Chrome/Edge executable path based on channel or explicit path.
   */
  private resolveChromePath(): string {
    if (this.options.executablePath) return this.options.executablePath;
    const channel = this.options.channel || 'chrome';
    const paths: Record<string, string[]> = {
      'chrome': [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ],
      'chrome-beta': [
        'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome Beta\\Application\\chrome.exe',
      ],
      'msedge': [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      'msedge-dev': [
        'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe',
      ],
    };
    if (process.platform === 'darwin') {
      paths['chrome'] = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
      paths['chrome-beta'] = ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'];
      paths['msedge'] = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
    } else if (process.platform === 'linux') {
      paths['chrome'] = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
      paths['chrome-beta'] = ['/usr/bin/google-chrome-beta'];
      paths['msedge'] = ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
    }
    const candidates = paths[channel] || paths['chrome'];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    // If not found in known paths, just return the channel name and hope it's on PATH
    if (process.platform === 'win32') return channel === 'msedge' ? 'msedge.exe' : 'chrome.exe';
    return channel === 'msedge' ? 'microsoft-edge' : 'google-chrome';
  }

  /**
   * Spawn Chrome/Edge with --remote-debugging-port and connect via CDP.
   * This is used when launchPersistentContext fails (e.g. Chrome blocks
   * --remote-debugging-pipe on its default user-data-dir).
   */
  async spawnChromeAndConnect(userDataDir: string, port = 9222): Promise<string> {
    const chromePath = this.resolveChromePath();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...STEALTH_ARGS,
    ];
    if (this.options.headless) args.push('--headless=new');

    // Spawn Chrome as a detached process
    this.chromeProcess = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    });
    this.chromeProcess.unref();

    // Wait for Chrome to start and open the debugging port
    const cdpUrl = `http://localhost:${port}`;
    const maxWait = 15_000; // 15 seconds
    const interval = 500;
    let waited = 0;
    while (waited < maxWait) {
      try {
        const resp = await fetch(`${cdpUrl}/json/version`);
        if (resp.ok) break;
      } catch {
        // Chrome not ready yet
      }
      await new Promise(r => setTimeout(r, interval));
      waited += interval;
    }
    if (waited >= maxWait) {
      throw new Error(`Chrome did not start within ${maxWait / 1000}s. Ensure no other Chrome instances are running and try again.`);
    }

    // Connect via CDP
    await this.connectCDP(cdpUrl);
    return `Launched real ${this.options.channel || 'chrome'} with your profile and connected via CDP at ${cdpUrl}`;
  }

  /** Launch a browser reusing a user-data-dir so cookies/sessions persist. */
  async launchPersistent(userDataDir?: string): Promise<void> {
    const dir = userDataDir ?? this.options.userDataDir ?? "";
    if (!dir) throw new Error("userDataDir is required for persistent launch");

    const browserType = this.getBrowserType();
    const contextOpts = this.buildContextOptions();

    // For persistent contexts: do NOT override user agent unless explicitly set
    // Changing UA causes sites to invalidate existing sessions
    if (!this.options.userAgent && !this.options.device) {
      delete contextOpts.userAgent;
    }

    try {
      this.context = await browserType.launchPersistentContext(dir, {
        headless: this.options.headless,
        executablePath: this.options.executablePath,
        channel: this.options.channel,
        args: this.isChromium() ? STEALTH_ARGS : [],
        ignoreDefaultArgs: this.isChromium() ? ["--enable-automation"] : undefined,
        ...contextOpts,
      });
    } catch (err: any) {
      // Chrome rejects --remote-debugging-pipe on its default data directory.
      // Auto-fallback: spawn Chrome with --remote-debugging-port and connect via CDP.
      if (err.message?.includes("non-default data directory") || err.message?.includes("remote debugging")) {
        // This will be handled by connect() — rethrow with a special marker
        const e = new Error(`NEEDS_CDP_FALLBACK: ${err.message}`);
        (e as any).needsCdpFallback = true;
        throw e;
      }
      if (err.message?.includes("lock") || err.message?.includes("already running") || err.message?.includes("SingletonLock")) {
        throw new Error(
          `Chrome profile is locked — close ALL Chrome windows first, then retry.\n` +
          `Or use CDP instead: start Chrome with --remote-debugging-port=9222 and use --cdp http://localhost:9222\n` +
          `Original error: ${err.message}`
        );
      }
      throw err;
    }

    if (!this.isChromium()) {
      await this.context.addInitScript(STEALTH_SCRIPT);
    }

    this.attachContext(this.context);
  }

  /** Launch a fresh temporary browser (no session reuse). */
  async launchTemporary(): Promise<void> {
    const browserType = this.getBrowserType();
    const contextOpts = this.buildContextOptions();

    const launchOpts: any = {
      headless: this.options.headless,
      executablePath: this.options.executablePath,
      channel: this.options.channel,
      args: this.isChromium() ? STEALTH_ARGS : [],
    };

    if (this.options.proxyServer) {
      launchOpts.proxy = {
        server: this.options.proxyServer,
        ...(this.options.proxyBypass && { bypass: this.options.proxyBypass }),
      };
    }

    this.browser = await browserType.launch(launchOpts);
    delete contextOpts.proxy;
    // Headless Chromium announces itself as "HeadlessChrome" in the UA — the most
    // common bot signal. Replace it with the regular Chrome UA for the same version.
    if (this.options.headless && !contextOpts.userAgent && this.isChromium()) {
      contextOpts.userAgent = chromeUserAgent(this.browser.version());
    }
    this.context = await this.browser.newContext(contextOpts);
    if (!this.isChromium()) {
      await this.context.addInitScript(STEALTH_SCRIPT);
    }

    if (this.blockedPatterns.length > 0) {
      await this.applyRouteBlocking();
    }

    this.attachContext(this.context);
  }

  /** Register existing and future pages of a context. */
  private attachContext(ctx: BrowserContext): void {
    for (const page of ctx.pages()) this.activePageId = this.registerPage(page);
    ctx.on("page", (page) => {
      if (this.internalPages.has(page)) return;
      if (this.pendingInternal > 0) {
        this.pendingInternal--;
        this.internalPages.add(page);
        return;
      }
      // A tab opened by the site (target=_blank, window.open) becomes the active tab.
      this.activePageId = this.registerPage(page);
    });
    ctx.on("close", () => {
      if (this.context === ctx) {
        this.context = null;
        this.pages.clear();
        this.activePageId = null;
      }
    });
  }

  private registerPage(page: Page): number {
    for (const [id, p] of this.pages) if (p === page) return id;
    const id = this.nextPageId++;
    this.pages.set(id, page);
    this.setupPageTracking(page, id);
    // Handle dialogs so they never block the page; report them in the next action result.
    page.on("dialog", async (dialog) => {
      const planned = this.nextDialog.get(page);
      this.nextDialog.delete(page);
      const action = planned?.action ?? (dialog.type() === "confirm" || dialog.type() === "prompt" ? "dismiss" : "accept");
      try {
        if (action === "accept") await dialog.accept(planned?.promptText);
        else await dialog.dismiss();
      } catch {
        /* already handled */
      }
      this.dialogNotes.set(page, `${dialog.type()} "${dialog.message().slice(0, 200)}" → ${action}ed`);
    });
    page.on("close", () => {
      this.pages.delete(id);
      if (this.activePageId === id) {
        const ids = [...this.pages.keys()];
        this.activePageId = ids.length ? ids[ids.length - 1] : null;
      }
    });
    return id;
  }

  /** Connect on first use so agents don't need an explicit browser_connect call. */
  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    return this.getContext();
  }

  isConnected(): boolean {
    return !!this.context;
  }

  /** Smart connect: tries CDP first, then persistent dir, then temp launch. */
  async connect(): Promise<string> {
    if (this.context || this.browser) await this.close();
    if (this.options.cdpUrl) {
      await this.connectCDP();
      return `Connected via CDP to ${this.options.cdpUrl}`;
    }
    if (this.options.userDataDir) {
      try {
        await this.launchPersistent();
        return `Launched persistent ${this.options.browser || "chromium"} with profile: ${this.options.userDataDir}`;
      } catch (err: any) {
        if (err.needsCdpFallback) {
          // Chrome rejected --remote-debugging-pipe on its default data dir.
          // Auto-fallback: spawn real Chrome + connect via CDP.
          return await this.spawnChromeAndConnect(this.options.userDataDir);
        }
        throw err;
      }
    }
    try {
      await this.connectCDP("http://localhost:9222");
      return "Connected via CDP to http://localhost:9222";
    } catch {
      await this.launchTemporary();
      const device = this.options.device ? ` (device: ${this.options.device})` : "";
      const proxy = this.options.proxyServer ? ` (proxy: ${this.options.proxyServer})` : "";
      const channel = this.options.channel ? ` (channel: ${this.options.channel})` : "";
      return `Launched ${this.options.browser || "chromium"}${channel}${device}${proxy}`;
    }
  }

  // ─── Page Tracking ─────────────────────────────────────────

  private setupPageTracking(page: Page, pageId: number): void {
    // Console log capture (ring buffer: keeps the most recent entries)
    this.consoleLogs.set(pageId, []);
    page.on("console", (msg: ConsoleMessage) => {
      const logs = this.consoleLogs.get(pageId);
      if (logs) {
        if (logs.length >= 500) logs.shift();
        logs.push({
          type: msg.type(),
          text: msg.text(),
          url: msg.location()?.url || "",
          timestamp: Date.now(),
        });
      }
    });

    // Network request/response tracking
    this.networkLogs.set(pageId, []);
    const started = new WeakMap<Request, number>();

    page.on("request", (request: Request) => {
      started.set(request, Date.now());
    });

    const record = (request: Request, status?: number) => {
      const logs = this.networkLogs.get(pageId);
      if (!logs) return;
      if (logs.length >= 500) logs.shift();
      const t0 = started.get(request);
      logs.push({
        url: request.url(),
        method: request.method(),
        status,
        resourceType: request.resourceType(),
        timestamp: Date.now(),
        duration: t0 ? Date.now() - t0 : undefined,
      });
    };
    page.on("response", (response: Response) => record(response.request(), response.status()));
    page.on("requestfailed", (request: Request) => record(request, 0));

    page.on("close", () => {
      this.consoleLogs.delete(pageId);
      this.networkLogs.delete(pageId);
    });
  }

  // ─── Page Management ───────────────────────────────────────

  getContext(): BrowserContext {
    if (!this.context) throw new Error("Browser not connected. Call browser_connect first.");
    return this.context;
  }

  /** Open a page for background work (scraping). It never becomes the agent's active tab. */
  async newInternalPage(): Promise<Page> {
    const ctx = await this.ensureContext();
    this.pendingInternal++;
    let page: Page;
    try {
      page = await ctx.newPage();
    } catch (e) {
      this.pendingInternal = Math.max(0, this.pendingInternal - 1);
      throw e;
    }
    if (!this.internalPages.has(page)) {
      // Our "page" event hasn't fired yet: release our claim and mark the page now.
      this.pendingInternal = Math.max(0, this.pendingInternal - 1);
      this.internalPages.add(page);
    }
    // Under concurrency the event may have been attributed to a user tab; undo that.
    for (const [id, p] of this.pages) {
      if (p === page) {
        this.pages.delete(id);
        if (this.activePageId === id) {
          const ids = [...this.pages.keys()];
          this.activePageId = ids.length ? ids[ids.length - 1] : null;
        }
      }
    }
    return page;
  }

  getBrowserInstance(): Browser | null {
    return this.browser;
  }

  async getOrCreatePage(pageId?: number): Promise<{ id: number; page: Page }> {
    await this.ensureContext();
    if (pageId !== undefined) {
      const page = this.pages.get(pageId);
      if (!page) throw new Error(`Page ${pageId} not found. Use list_pages to see available pages.`);
      return { id: pageId, page };
    }
    if (this.activePageId !== null && this.pages.has(this.activePageId)) {
      return { id: this.activePageId, page: this.pages.get(this.activePageId)! };
    }
    if (this.pages.size > 0) {
      const lastId = Math.max(...this.pages.keys());
      this.activePageId = lastId;
      return { id: lastId, page: this.pages.get(lastId)! };
    }
    return this.newPage();
  }

  setNextDialog(page: Page, action: "accept" | "dismiss", promptText?: string): void {
    this.nextDialog.set(page, { action, promptText });
  }

  takeDialogNote(page: Page): string | undefined {
    const n = this.dialogNotes.get(page);
    this.dialogNotes.delete(page);
    return n;
  }

  getActivePageId(): number | null {
    return this.activePageId;
  }

  async newPage(url?: string): Promise<{ id: number; page: Page }> {
    const ctx = await this.ensureContext();
    const page = await ctx.newPage();
    const id = this.registerPage(page);
    this.activePageId = id;
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return { id, page };
  }

  async closePage(pageId: number): Promise<void> {
    const page = this.pages.get(pageId);
    if (page) {
      await page.close();
      this.pages.delete(pageId);
      this.consoleLogs.delete(pageId);
      this.networkLogs.delete(pageId);
    }
  }

  async focusPage(pageId: number): Promise<void> {
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Page ${pageId} not found`);
    await page.bringToFront();
    this.activePageId = pageId;
  }

  listPages(): { id: number; url: string; title: string }[] {
    const result: { id: number; url: string; title: string }[] = [];
    for (const [id, page] of this.pages) {
      try {
        result.push({ id, url: page.url(), title: "" });
      } catch {
        this.pages.delete(id);
      }
    }
    return result;
  }

  async listPagesWithTitles(): Promise<{ id: number; url: string; title: string }[]> {
    const result: { id: number; url: string; title: string }[] = [];
    for (const [id, page] of this.pages) {
      try {
        const title = await page.title();
        result.push({ id, url: page.url(), title });
      } catch {
        this.pages.delete(id);
      }
    }
    return result;
  }

  // ─── Console & Network Access ──────────────────────────────

  getConsoleLogs(pageId: number): ConsoleLogEntry[] {
    return this.consoleLogs.get(pageId) || [];
  }

  clearConsoleLogs(pageId: number): void {
    this.consoleLogs.set(pageId, []);
  }

  getNetworkLogs(pageId: number): NetworkLogEntry[] {
    return this.networkLogs.get(pageId) || [];
  }

  clearNetworkLogs(pageId: number): void {
    this.networkLogs.set(pageId, []);
  }

  // ─── Route Blocking ───────────────────────────────────────

  addBlockedPattern(pattern: string): void {
    this.blockedPatterns.push(pattern);
  }

  clearBlockedPatterns(): void {
    this.blockedPatterns = [];
  }

  getBlockedPatterns(): string[] {
    return [...this.blockedPatterns];
  }

  async applyRouteBlocking(): Promise<void> {
    const ctx = await this.ensureContext();
    for (const pattern of this.blockedPatterns) {
      await ctx.route(pattern, (route) => route.abort());
    }
  }

  // ─── Storage State ─────────────────────────────────────────

  async saveStorageState(filePath: string): Promise<void> {
    const ctx = await this.ensureContext();
    const state = await ctx.storageState();
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  async loadStorageState(filePath: string): Promise<void> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const state = JSON.parse(readFileSync(filePath, "utf-8"));
    const ctx = await this.ensureContext();
    await ctx.addCookies(state.cookies || []);
    for (const origin of state.origins || []) {
      const pages = ctx.pages();
      if (pages.length > 0) {
        await pages[0].evaluate(
          ({ entries, originUrl }) => {
            if (window.location.origin === originUrl) {
              for (const { name, value } of entries) {
                localStorage.setItem(name, value);
              }
            }
          },
          { entries: origin.localStorage || [], originUrl: origin.origin }
        );
      }
    }
  }

  // ─── Geolocation & Permissions ─────────────────────────────

  async setGeolocation(latitude: number, longitude: number, accuracy?: number): Promise<void> {
    const ctx = await this.ensureContext();
    await ctx.setGeolocation({ latitude, longitude, accuracy: accuracy || 100 });
  }

  async grantPermissions(permissions: string[], origin?: string): Promise<void> {
    const ctx = await this.ensureContext();
    await ctx.grantPermissions(permissions, origin ? { origin } : undefined);
  }

  async clearPermissions(): Promise<void> {
    const ctx = await this.ensureContext();
    await ctx.clearPermissions();
  }

  // ─── Extra Headers ─────────────────────────────────────────

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    const ctx = await this.ensureContext();
    await ctx.setExtraHTTPHeaders(headers);
  }

  // ─── Browser Info ──────────────────────────────────────────

  getBrowserInfo(): Record<string, any> {
    return {
      engine: this.options.browser || "chromium",
      headless: this.options.headless,
      device: this.options.device || null,
      proxy: this.options.proxyServer || null,
      viewport: this.options.viewportWidth
        ? `${this.options.viewportWidth}x${this.options.viewportHeight}`
        : "auto",
      pages: this.pages.size,
      activePage: this.activePageId,
      human: !!this.options.human,
      recordingVideo: this.isRecordingVideo,
      blockedPatterns: this.blockedPatterns.length,
      connected: !!this.context,
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.context && !this.viaCdp) {
      try {
        await this.context.close();
      } catch {
        /* ignore */
      }
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        /* ignore */
      }
    }
    // Clean up spawned Chrome process if we launched one
    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill();
      } catch {
        /* ignore */
      }
      this.chromeProcess = null;
    }
    this.pages.clear();
    this.consoleLogs.clear();
    this.networkLogs.clear();
    this.activePageId = null;
    this.context = null;
    this.browser = null;
    this.viaCdp = false;
  }
}
