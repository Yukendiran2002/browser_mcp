# 🌐 Browser MCP Server

**The most comprehensive Browser MCP Server for AI agents** — 70 tools with human-like behavior, stealth anti-detection, session reuse, multi-browser support, 50+ device presets, and token-optimized outputs.

Built on [Playwright](https://playwright.dev/) + [Model Context Protocol](https://modelcontextprotocol.io/).

---

## ✨ Key Features

| Feature | Description |
|---|---|
| **🤖 Human-Like Behavior** | Bezier curve mouse movements, variable-speed typing, smooth scrolling — evades bot detection |
| **🛡️ Stealth Anti-Detection** | WebGL spoofing, canvas fingerprint noise, navigator.webdriver hidden, plugin/language spoofing |
| **🔄 Session Reuse** | Connect to existing Chrome via CDP or user-data-dir — keeps cookies, logins, tabs |
| **🌍 Multi-Browser** | Chromium, Firefox, WebKit — test across all engines |
| **📱 50+ Device Presets** | iPhone, iPad, Pixel, Galaxy, OnePlus, Desktop — full viewport/UA/touch emulation |
| **🌐 Proxy Support** | HTTP/HTTPS/SOCKS5 proxy with bypass rules |
| **📊 Network Monitoring** | Auto-capture all requests/responses, console logs, filter by type |
| **📸 Visual Annotation** | mark_page: numbered boxes on interactive elements — massive token savings |
| **💾 Storage State** | Save/load cookies + localStorage for cross-session persistence |
| **🎯 Smart Actions** | Natural language commands: "click Login", "type hello into search" |
| **📉 Token Optimized** | Compact outputs, configurable truncation — saves 60-80% tokens vs competitors |
| **🎬 Video Recording** | Record browser sessions for debugging and replay |
| **📍 Geolocation** | Override latitude/longitude for location-based testing |
| **🔒 HTTPS Errors** | Ignore certificate errors for internal/staging sites |

---

## 🚀 Quick Start

### Install

```bash
git clone https://github.com/user/browser-mcp-server.git
cd browser-mcp-server
npm install
npx playwright install
npm run build
```

### Run

```bash
# Auto-detect: tries CDP on port 9222, falls back to launching a new browser
node dist/index.js

# Connect to existing Chrome (preserves your logged-in sessions)
chrome --remote-debugging-port=9222
node dist/index.js --cdp http://localhost:9222

# Reuse Chrome profile (keeps all cookies, logins, extensions)
node dist/index.js --user-data-dir "C:\Users\you\AppData\Local\Google\Chrome\User Data"

# Launch Firefox with iPhone emulation and proxy
node dist/index.js --browser firefox --device "iPhone 15" --proxy-server http://proxy:8080
```

### VS Code MCP Configuration

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "browser": {
      "type": "stdio",
      "command": "node",
      "args": ["path/to/browser-mcp-server/dist/index.js"]
    }
  }
}
```

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["path/to/browser-mcp-server/dist/index.js"],
      "env": {}
    }
  }
}
```

---

## 🛠️ All 70 Tools

### Connection (1)
| Tool | Description |
|---|---|
| `browser_connect` | Connect to browser (CDP/profile/temp launch). Multi-browser, device emulation, proxy. |

### Navigation (5)
| Tool | Description |
|---|---|
| `navigate` | Navigate to URL with configurable wait conditions |
| `go_back` | Go back in browser history |
| `go_forward` | Go forward in browser history |
| `reload` | Reload current page |
| `wait_for_navigation` | Wait for page navigation to complete |

### Page/Tab Management (4)
| Tool | Description |
|---|---|
| `list_pages` | List all open tabs |
| `new_page` | Open new tab (optionally with URL) |
| `close_page` | Close a tab by ID |
| `focus_page` | Bring a tab to front/focus |

### Interaction — Human-Like (14)
| Tool | Description |
|---|---|
| `click` | Click element with Bezier curve mouse movement |
| `type_text` | Type with human-like keystroke timing |
| `fill_form` | Fill multiple form fields with natural pauses |
| `select_option` | Select dropdown option by value or label |
| `check_checkbox` | Check/uncheck checkbox or radio button |
| `hover` | Hover with natural mouse movement |
| `press_key` | Press key or combo (Enter, Ctrl+C, Tab, etc.) |
| `scroll` | Scroll with smooth human-like motion |
| `scroll_to_element` | Scroll element into view |
| `wait_for_element` | Wait for element to appear/disappear |
| `wait_for_text` | Wait for specific text on page |
| `drag_and_drop` | Drag element to target with natural motion |
| `upload_file` | Upload file(s) to input |
| `handle_dialog` | Accept or dismiss browser dialogs |

### Reading/Observation — Token-Optimized (14)
| Tool | Description |
|---|---|
| `get_page_content` | Get visible text (default 4000 chars) |
| `get_page_html` | Get HTML (truncated to save tokens) |
| `get_element_text` | Get element text content |
| `get_element_attribute` | Get element attribute value |
| `get_element_value` | Get form element value |
| `element_exists` | Quick true/false existence check |
| `element_count` | Count elements matching selector |
| `get_bounding_box` | Get element position and size |
| `take_screenshot` | Screenshot page or element (PNG/base64) |
| `get_accessibility_tree` | Compact ARIA accessibility tree |
| `get_form_elements` | List form elements (compact format) |
| `get_links` | List page links (deduplicated) |
| `get_table_data` | Extract table data as structured JSON |
| `evaluate_javascript` | Run JavaScript in page context |

### Cookies & Storage (10)
| Tool | Description |
|---|---|
| `get_cookies` | Get cookies (compact format) |
| `set_cookies` | Set cookies |
| `clear_cookies` | Clear all cookies |
| `get_local_storage` | Get localStorage |
| `set_local_storage` | Set localStorage key-value pairs |
| `get_session_storage` | Get sessionStorage |
| `set_session_storage` | Set sessionStorage key-value pairs |
| `clear_storage` | Clear localStorage, sessionStorage, or both |
| `save_storage_state` | Save cookies + localStorage to JSON file |
| `load_storage_state` | Load cookies + localStorage from JSON file |

### Network Monitoring & Control (8)
| Tool | Description |
|---|---|
| `wait_for_network_idle` | Wait for all network requests to finish |
| `wait_for_url` | Wait for URL to match pattern |
| `wait_for_response` | Wait for network response matching URL |
| `wait_for_request` | Wait for network request matching URL |
| `get_network_log` | Get captured network requests/responses |
| `get_console_logs` | Get captured console messages |
| `block_urls` | Block URLs by pattern (ads, trackers, etc.) |
| `set_extra_headers` | Set custom HTTP headers |

### Device & Viewport (3)
| Tool | Description |
|---|---|
| `set_viewport` | Set viewport size for responsive testing |
| `emulate_device` | Emulate device (50+ presets) |
| `list_devices` | List all available device presets |

### Geolocation & Permissions (3)
| Tool | Description |
|---|---|
| `set_geolocation` | Override browser geolocation |
| `grant_permissions` | Grant browser permissions |
| `clear_permissions` | Clear all granted permissions |

### Frame/iFrame Support (3)
| Tool | Description |
|---|---|
| `list_frames` | List all frames on the page |
| `execute_in_frame` | Run JavaScript in a specific frame |
| `click_in_frame` | Click element inside a frame |

### PDF (1)
| Tool | Description |
|---|---|
| `save_as_pdf` | Save page as PDF (A4, Letter, etc.) |

### Visual Annotation — mark_page (5)
| Tool | Description |
|---|---|
| `mark_page` | Annotate page with numbered boxes on interactive elements |
| `unmark_page` | Remove annotations |
| `click_element` | Click by index from mark_page |
| `type_into_element` | Type into element by index from mark_page |
| `mark_page_and_screenshot` | Mark + screenshot (best for visual agents) |

### Smart Tools (2)
| Tool | Description |
|---|---|
| `get_page_summary` | Ultra-compact page summary (minimal tokens) |
| `smart_action` | Natural language browser action |

### Browser Management (2)
| Tool | Description |
|---|---|
| `get_browser_info` | Get browser config details |
| `close_browser` | Close browser and cleanup |

---

## 📱 Supported Device Presets (50+)

**iPhones:** SE, 12 Mini, 12, 12 Pro, 12 Pro Max, 13, 13 Pro, 14, 14 Pro, 14 Pro Max, 15, 15 Pro, 15 Pro Max, 16 Pro Max

**iPads:** Mini, Air, Pro 11, Pro 12.9, 10th Gen

**Android:** Pixel 5, 6, 7, 8 Pro, Galaxy S21, S23 Ultra, Z Fold 5, A54, OnePlus 12, Moto G, Xiaomi 14, Huawei P60

**Desktop:** Chrome 1920x1080, Chrome 1440, Firefox, Safari, Edge, Small Laptop, Ultrawide

**Landscape:** iPhone Landscape, iPad Landscape, Android Landscape

---

## 🔧 CLI Options

```
CONNECTION:
  --cdp <url>                 Connect via Chrome DevTools Protocol
  --user-data-dir <path>      Launch browser with user profile
  --executable-path <path>    Path to browser executable

BROWSER:
  --browser <engine>          chromium, firefox, or webkit (default: chromium)
  --headless                  Run in headless mode
  --timeout <ms>              Default action timeout (default: 30000)

VIEWPORT & DEVICE:
  --viewport <WxH>            Viewport size, e.g. 1920x1080
  --device <name>             Emulate device preset

NETWORK:
  --proxy-server <url>        Proxy URL
  --proxy-bypass <domains>    Domains to bypass proxy
  --ignore-https-errors       Ignore HTTPS certificate errors
  --block-service-workers     Block service workers

CONTEXT:
  --user-agent <string>       Custom user agent
  --locale <locale>           Browser locale (e.g. en-US)
  --timezone <tz>             Timezone (e.g. America/New_York)
  --color-scheme <scheme>     light, dark, or no-preference
  --geolocation <lat,lng>     Override geolocation
  --permissions <list>        Comma-separated permissions

SESSION:
  --storage-state <path>      Load session from JSON file

VIDEO:
  --record-video              Record browser session
  --video-dir <path>          Video output directory
```

### Environment Variables

| Variable | CLI Equivalent |
|---|---|
| `BROWSER_CDP_URL` | `--cdp` |
| `BROWSER_USER_DATA_DIR` | `--user-data-dir` |
| `BROWSER_EXECUTABLE_PATH` | `--executable-path` |
| `BROWSER_ENGINE` | `--browser` |
| `BROWSER_PROXY` | `--proxy-server` |

---

## 🐳 Docker

```bash
docker build -t browser-mcp-server .
docker run -i browser-mcp-server
docker run -i browser-mcp-server --headless --browser chromium
```

---

## 🏗️ Architecture

```
src/
├── index.ts           # CLI entry point, MCP server setup
├── browser-manager.ts # Browser lifecycle, multi-engine, stealth, tracking
├── tools.ts           # All 70 MCP tools with human-like behavior
├── resources.ts       # 6 MCP resources (page, cookies, console, network, etc.)
├── human.ts           # Human behavior engine (Bezier curves, natural typing)
├── devices.ts         # 50+ device emulation presets
├── utils.ts           # Shared utilities (selectors, accessibility, text extraction)
└── mark_page.js       # Page annotation script (numbered interactive elements)
```

---

## 🔒 Anti-Detection Features

- `navigator.webdriver` set to `false`
- Chrome runtime spoofed
- Permissions query overridden
- Plugins and languages spoofed
- WebGL vendor/renderer overridden (Intel Iris)
- Canvas fingerprint noise injection
- `connection.rtt` consistency
- Automation command-line flags disabled
- Human-like timing on all interactions

---

## 📊 Competitive Advantage

| Feature | This Server | Playwright MCP (Microsoft) | mcp-playwright | Browserbase MCP |
|---|---|---|---|---|
| Human-like behavior | ✅ Bezier curves | ❌ | ❌ | ❌ |
| Stealth anti-detection | ✅ Full suite | ❌ | ❌ | ❌ |
| Session reuse (CDP) | ✅ | ✅ | ❌ | ❌ (cloud) |
| Multi-browser | ✅ 3 engines | ✅ | ✅ | ❌ |
| Device emulation | ✅ 50+ presets | ❌ | ✅ 143 | ❌ |
| Token optimization | ✅ Compact outputs | ❌ | ❌ | ❌ |
| Network monitoring | ✅ Auto-capture | ❌ | ❌ | ❌ |
| mark_page annotation | ✅ | ❌ | ❌ | ❌ |
| Smart natural actions | ✅ | ❌ | ❌ | ❌ |
| Console log capture | ✅ Auto | ✅ | ❌ | ❌ |
| Video recording | ✅ | ❌ | ✅ | ✅ |
| iframe support | ✅ | ✅ | ❌ | ❌ |
| Total tools | **70** | ~20 | ~30 | ~15 |

---

## 📄 License

MIT
