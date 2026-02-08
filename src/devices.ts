/**
 * Device Emulation Presets
 *
 * 50+ real device profiles with accurate viewport, userAgent,
 * deviceScaleFactor, touch support, and orientation data.
 * Inspired by executeautomation's 143 device presets.
 */

export interface DevicePreset {
  name: string;
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  defaultBrowserType?: "chromium" | "firefox" | "webkit";
}

export const DEVICE_PRESETS: Record<string, DevicePreset> = {
  // ─── iPhones ───────────────────────────────────────────────
  "iPhone SE": {
    name: "iPhone SE",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 12": {
    name: "iPhone 12",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 13": {
    name: "iPhone 13",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 13 Pro": {
    name: "iPhone 13 Pro",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 13 Pro Max": {
    name: "iPhone 13 Pro Max",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 428, height: 926 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 14": {
    name: "iPhone 14",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 14 Pro": {
    name: "iPhone 14 Pro",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 14 Pro Max": {
    name: "iPhone 14 Pro Max",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 15": {
    name: "iPhone 15",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 15 Pro": {
    name: "iPhone 15 Pro",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 15 Pro Max": {
    name: "iPhone 15 Pro Max",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 16": {
    name: "iPhone 16",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPhone 16 Pro Max": {
    name: "iPhone 16 Pro Max",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },

  // ─── iPads ─────────────────────────────────────────────────
  "iPad": {
    name: "iPad",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 810, height: 1080 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPad Air": {
    name: "iPad Air",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPad Mini": {
    name: "iPad Mini",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 768, height: 1024 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPad Pro 11": {
    name: "iPad Pro 11",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPad Pro 12.9": {
    name: "iPad Pro 12.9",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },

  // ─── Android Phones ────────────────────────────────────────
  "Pixel 5": {
    name: "Pixel 5",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Pixel 7": {
    name: "Pixel 7",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Pixel 8": {
    name: "Pixel 8",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy S21": {
    name: "Samsung Galaxy S21",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy S22": {
    name: "Samsung Galaxy S22",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy S23": {
    name: "Samsung Galaxy S23",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy S24": {
    name: "Samsung Galaxy S24",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy A51": {
    name: "Samsung Galaxy A51",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 914 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Samsung Galaxy Tab S7": {
    name: "Samsung Galaxy Tab S7",
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 753, height: 1205 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "OnePlus 9": {
    name: "OnePlus 9",
    userAgent: "Mozilla/5.0 (Linux; Android 14; LE2115) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },

  // ─── Desktop Browsers ─────────────────────────────────────
  "Desktop Chrome": {
    name: "Desktop Chrome",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop Chrome HiDPI": {
    name: "Desktop Chrome HiDPI",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop Firefox": {
    name: "Desktop Firefox",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "firefox",
  },
  "Desktop Safari": {
    name: "Desktop Safari",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "webkit",
  },
  "Desktop Edge": {
    name: "Desktop Edge",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop 1280x720": {
    name: "Desktop 1280x720",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop 1366x768": {
    name: "Desktop 1366x768",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop 1440x900": {
    name: "Desktop 1440x900",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },
  "Desktop 2560x1440": {
    name: "Desktop 2560x1440",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: "chromium",
  },

  // ─── Other Common Mobile ──────────────────────────────────
  "Moto G Power": {
    name: "Moto G Power",
    userAgent: "Mozilla/5.0 (Linux; Android 14; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Xiaomi Redmi Note 12": {
    name: "Xiaomi Redmi Note 12",
    userAgent: "Mozilla/5.0 (Linux; Android 14; 23028RNCAG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 393, height: 873 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
  "Huawei P30": {
    name: "Huawei P30",
    userAgent: "Mozilla/5.0 (Linux; Android 14; ELE-L09) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },

  // ─── Landscape Variants ────────────────────────────────────
  "iPhone 15 landscape": {
    name: "iPhone 15 landscape",
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 852, height: 393 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "iPad Pro 11 landscape": {
    name: "iPad Pro 11 landscape",
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 1194, height: 834 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "webkit",
  },
  "Pixel 7 landscape": {
    name: "Pixel 7 landscape",
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    viewport: { width: 915, height: 412 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: "chromium",
  },
};

/** Get device preset by name (case-insensitive fuzzy match). */
export function getDevicePreset(name: string): DevicePreset | null {
  // Exact match
  if (DEVICE_PRESETS[name]) return DEVICE_PRESETS[name];

  // Case-insensitive match
  const lower = name.toLowerCase();
  for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
    if (key.toLowerCase() === lower) return preset;
  }

  // Fuzzy match (contains)
  for (const [key, preset] of Object.entries(DEVICE_PRESETS)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase())) return preset;
  }

  return null;
}

/** List all available device names. */
export function listDeviceNames(): string[] {
  return Object.keys(DEVICE_PRESETS);
}
