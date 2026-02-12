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

/** Anti-detection stealth script injected into every page. */
const STEALTH_SCRIPT = `
  // Override navigator.webdriver to false
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  // Override chrome.runtime to look normal
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  // Override permissions query
  const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery(params);
  }
  // Override plugins to look like a real browser
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
  // Override WebGL vendor/renderer
  const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameterOrig.call(this, parameter);
  };
  // Canvas fingerprint noise
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width === 0 && this.height === 0) return origToDataURL.apply(this, arguments);
    const ctx = this.getContext('2d');
    if (ctx) {
      const imgData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
      imgData.data[0] = imgData.data[0] ^ 1;
      ctx.putImageData(imgData, 0, 0);
    }
    return origToDataURL.apply(this, arguments);
  };
  // Hide automation indicators
  delete navigator.__proto__.webdriver;
  // Override connection.rtt for consistency
  if (navigator.connection) {
    Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
  }
`;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-component-update",
  "--disable-background-networking",
];

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
  options: BrowserConnectionOptions;

  // Tracking infrastructure
  private consoleLogs: Map<number, ConsoleLogEntry[]> = new Map();
  private networkLogs: Map<number, NetworkLogEntry[]> = new Map();
  private blockedPatterns: string[] = [];
  private isRecordingVideo = false;

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
    const contexts = this.browser.contexts();

    if (contexts.length > 0) {
      // Reuse the EXISTING context — this preserves all cookies, logins, sessions
      this.context = contexts[0];
    } else {
      // No existing context (rare) — create one but DON'T override user agent
      // so that any subsequent logins use the browser's real UA
      this.context = await this.browser.newContext();
    }

    for (const page of this.context.pages()) {
      const id = this.nextPageId++;
      this.pages.set(id, page);
      this.setupPageTracking(page, id);
    }

    // Listen for new tabs opened in the existing session
    this.context.on("page", (page) => {
      const id = this.nextPageId++;
      this.pages.set(id, page);
      this.setupPageTracking(page, id);
    });
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
        args: STEALTH_ARGS,
        ignoreDefaultArgs: ["--enable-automation"],
        ...contextOpts,
      });
    } catch (err: any) {
      if (err.message?.includes("lock") || err.message?.includes("already running") || err.message?.includes("SingletonLock")) {
        throw new Error(
          `Chrome profile is locked — close ALL Chrome windows first, then retry.\n` +
          `Or use CDP instead: start Chrome with --remote-debugging-port=9222 and use --cdp http://localhost:9222\n` +
          `Original error: ${err.message}`
        );
      }
      throw err;
    }

    await this.context.addInitScript(STEALTH_SCRIPT);

    for (const page of this.context.pages()) {
      const id = this.nextPageId++;
      this.pages.set(id, page);
      this.setupPageTracking(page, id);
    }

    this.context.on("page", (page) => {
      const id = this.nextPageId++;
      this.pages.set(id, page);
      this.setupPageTracking(page, id);
    });
  }

  /** Launch a fresh temporary browser (no session reuse). */
  async launchTemporary(): Promise<void> {
    const browserType = this.getBrowserType();
    const contextOpts = this.buildContextOptions();

    const launchOpts: any = {
      headless: this.options.headless,
      executablePath: this.options.executablePath,
      channel: this.options.channel,
      args: STEALTH_ARGS,
    };

    if (this.options.proxyServer) {
      launchOpts.proxy = {
        server: this.options.proxyServer,
        ...(this.options.proxyBypass && { bypass: this.options.proxyBypass }),
      };
    }

    this.browser = await browserType.launch(launchOpts);
    delete contextOpts.proxy;
    // For temp browsers, set default UA if none specified (sessions don't matter here)
    if (!contextOpts.userAgent) {
      contextOpts.userAgent = DEFAULT_USER_AGENT;
    }
    this.context = await this.browser.newContext(contextOpts);
    await this.context.addInitScript(STEALTH_SCRIPT);

    if (this.blockedPatterns.length > 0) {
      await this.applyRouteBlocking();
    }

    this.context.on("page", (page) => {
      const id = this.nextPageId++;
      this.pages.set(id, page);
      this.setupPageTracking(page, id);
    });
  }

  /** Smart connect: tries CDP first, then persistent dir, then temp launch. */
  async connect(): Promise<string> {
    if (this.options.cdpUrl) {
      await this.connectCDP();
      return `Connected via CDP to ${this.options.cdpUrl}`;
    }
    if (this.options.userDataDir) {
      await this.launchPersistent();
      return `Launched persistent ${this.options.browser || "chromium"} with profile: ${this.options.userDataDir}`;
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
    // Console log capture
    this.consoleLogs.set(pageId, []);
    page.on("console", (msg: ConsoleMessage) => {
      const logs = this.consoleLogs.get(pageId);
      if (logs && logs.length < 500) {
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
    const pendingRequests = new Map<string, { url: string; method: string; resourceType: string; timestamp: number }>();

    page.on("request", (request: Request) => {
      pendingRequests.set(request.url(), {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        timestamp: Date.now(),
      });
    });

    page.on("response", (response: Response) => {
      const logs = this.networkLogs.get(pageId);
      const reqInfo = pendingRequests.get(response.url());
      if (logs && logs.length < 500) {
        logs.push({
          url: response.url(),
          method: reqInfo?.method || "GET",
          status: response.status(),
          resourceType: reqInfo?.resourceType || "other",
          timestamp: Date.now(),
          duration: reqInfo ? Date.now() - reqInfo.timestamp : undefined,
        });
      }
      pendingRequests.delete(response.url());
    });

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

  getBrowserInstance(): Browser | null {
    return this.browser;
  }

  async getOrCreatePage(pageId?: number): Promise<{ id: number; page: Page }> {
    if (pageId !== undefined) {
      const page = this.pages.get(pageId);
      if (!page) throw new Error(`Page ${pageId} not found. Use list_pages to see available pages.`);
      return { id: pageId, page };
    }
    if (this.pages.size > 0) {
      const lastId = Math.max(...this.pages.keys());
      return { id: lastId, page: this.pages.get(lastId)! };
    }
    return this.newPage();
  }

  async newPage(url?: string): Promise<{ id: number; page: Page }> {
    const ctx = this.getContext();
    const page = await ctx.newPage();
    const id = this.nextPageId++;
    this.pages.set(id, page);
    this.setupPageTracking(page, id);
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
    if (page) {
      await page.bringToFront();
    }
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
    const ctx = this.getContext();
    for (const pattern of this.blockedPatterns) {
      await ctx.route(pattern, (route) => route.abort());
    }
  }

  // ─── Storage State ─────────────────────────────────────────

  async saveStorageState(filePath: string): Promise<void> {
    const ctx = this.getContext();
    const state = await ctx.storageState();
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  async loadStorageState(filePath: string): Promise<void> {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const state = JSON.parse(readFileSync(filePath, "utf-8"));
    const ctx = this.getContext();
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
    const ctx = this.getContext();
    await ctx.setGeolocation({ latitude, longitude, accuracy: accuracy || 100 });
  }

  async grantPermissions(permissions: string[], origin?: string): Promise<void> {
    const ctx = this.getContext();
    await ctx.grantPermissions(permissions, origin ? { origin } : undefined);
  }

  async clearPermissions(): Promise<void> {
    const ctx = this.getContext();
    await ctx.clearPermissions();
  }

  // ─── Extra Headers ─────────────────────────────────────────

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    const ctx = this.getContext();
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
      recordingVideo: this.isRecordingVideo,
      blockedPatterns: this.blockedPatterns.length,
      connected: !!this.context,
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────

  async close(): Promise<void> {
    if (this.context) {
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
    this.pages.clear();
    this.consoleLogs.clear();
    this.networkLogs.clear();
    this.context = null;
    this.browser = null;
  }
}
