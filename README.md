# Browser MCP Server

**Browser automation and web scraping for AI agents, built to keep token cost and latency low.**

An [MCP](https://modelcontextprotocol.io/) server built on [Playwright](https://playwright.dev/). It gives agents a real browser (including your logged-in Chrome) and a scraping engine that only starts a browser when a page actually needs one. It also ships [DejavuScraper](https://github.com/Yukendiran2002/dejavu_scraper)'s learn-by-example extraction: learn a scraper from one example value per field, then run it on any number of similar pages without an LLM call per page.

```
You: "Get name + price for every laptop on shop.example, all pages."

agent → learn_extractor {url, examples: {name: ["ThinkPad X1"], price: ["$1,299"]}}   ← 1 LLM turn
agent → run_extractor   {name: "laptops", url, followPages: 20}                         ← 0 LLM tokens per page
      ← 480 records as JSON
```

---

## Why it's cheaper and faster

| Technique | What it saves |
|---|---|
| **Ref snapshots** (`snapshot`) | One line per actionable element, e.g. `- button "Sign in" [e7]`, instead of HTML or a full accessibility tree. |
| **Actions return diffs** | `click`/`type_text`/`batch` return only the snapshot lines that changed, plus navigation, new tabs and dialogs, so the agent rarely needs another snapshot. |
| **`batch`** | Fill a form, submit it and wait for the result in one tool call instead of five. |
| **HTTP-first scraping** | `scrape`/`crawl` fetch over plain HTTP (~10–50 ms locally) and switch to a background browser tab only for JS-rendered pages or bot walls. Hosts that keep needing a browser skip the HTTP probe. |
| **Markdown + `query=`** | Main-content markdown without nav, footers or cookie banners. `query` keeps only the BM25-relevant sections. |
| **Learned extractors** | `learn_extractor` once, then `run_extractor`/`crawl extractor=` with no LLM calls. Rules self-heal when a site's layout changes. |
| **Small default toolset** | Tool schemas are sent on every turn. The default is 25 tools (~3.9k tokens); v2 always exposed 75 (~7.1k). Enable more with `--tools`. |
| **Fast mode by default** | Real mouse/keyboard events without artificial delays. Use `--human` for Bezier mouse paths and human typing rhythm. |

### Measured on a real page (pypi.org/project/httpx)

| Representation | Size | ≈ Tokens |
|---|---:|---:|
| Raw HTML | 148,489 chars | ~37,100 |
| `innerText` | 36,132 chars | ~9,000 |
| Playwright `ariaSnapshot()` (full accessibility tree) | 18,216 chars | ~4,550 |
| **`snapshot`** (all 96 actionable elements, with refs) | 4,383 chars | **~1,100** |
| **`snapshot viewportOnly`** | 796 chars | **~200** |
| **`read_page`** (visible main content as markdown) | 4,291 chars | ~1,070 |
| **`scrape query="install proxy"`** | 1,307 chars | **~330** |

Local fixture timings (from the test suite): `scrape` over HTTP took 10–45 ms per page, versus about 600 ms for a background browser tab. `run_extractor` over three paginated pages took 9 ms.

---

## Quick start

```bash
git clone https://github.com/Yukendiran2002/browser_mcp.git
cd browser_mcp
npm install
npx playwright install chromium
npm run build
```

**Claude Code**

```bash
claude mcp add browser -- node /abs/path/browser_mcp/dist/index.js
```

**Claude Desktop / Cursor / Windsurf** (`claude_desktop_config.json`, `.cursor/mcp.json`, …)

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/abs/path/browser_mcp/dist/index.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "browser": { "type": "stdio", "command": "node", "args": ["/abs/path/browser_mcp/dist/index.js"] } } }
```

No `browser_connect` call is needed: the first tool that needs a browser starts one. It attaches to a Chrome already running with `--remote-debugging-port=9222` if there is one, and launches a fresh Chromium otherwise.

### Use your logged-in browser

```bash
# Attach to your running Chrome (keeps every cookie, login and tab)
chrome --remote-debugging-port=9222
node dist/index.js --cdp http://localhost:9222

# Or launch Chrome with your profile
node dist/index.js --channel chrome --user-data-dir "C:\Users\you\AppData\Local\Google\Chrome\User Data"
```

`close_browser` detaches from a Chrome you attached to over CDP and never closes it. Background scraping tabs share the session's cookies but never appear in your tab list.

---

## Tools

### `core`: browse and interact

| Tool | What it does |
|---|---|
| `navigate` | Open a URL; `returns: "snapshot" \| "markdown"` includes the page in the same call |
| `snapshot` | Actionable elements with refs, plus headings, landmarks, live regions and iframes. `viewportOnly`, `mode: "full"`, `urls` |
| `click`, `type_text`, `select_option`, `hover`, `press_key`, `scroll` | Accept a **ref** (`e12`, `f2e3` for iframes), CSS, XPath or visible text/label. Return what changed |
| `fill_form` | Text fields, selects and checkboxes in one call |
| `batch` | Up to 50 steps (`navigate, click, type, fill, select, check, uncheck, hover, press, scroll, wait, upload, drag, eval, back, forward, reload`) in one call |
| `wait_for` | Text, element (or `gone`), URL, network idle, or ms |
| `read_page` | Current tab as clean markdown; `query`, `selector`, `links: inline\|refs\|none` |
| `take_screenshot` | JPEG at CSS scale by default (smaller payloads); element or full page |
| `tabs` | List, new, close, focus |
| `go_back`, `evaluate_javascript`, `browser_connect`, `close_browser` | |

### `scrape`: fetch, crawl and extract

| Tool | What it does |
|---|---|
| `scrape` | One URL or up to 100 (`urls`) concurrently, as markdown. `mode: auto\|http\|browser`, `query`, `structured`, `includeLinks`, `outputFile` (JSONL) |
| `crawl` | Same-domain BFS, robots.txt-aware, concurrent; `include`/`exclude` regexes, `extractor` to emit records per page, `outputFile` |
| `map_site` | URLs from robots.txt, sitemaps (including sitemap indexes) and homepage links; `search` ranks by keyword |
| `extract_structured` | No-LLM extraction: metadata/OpenGraph, JSON-LD, microdata, tables, repeated items (products, results, cards), pagination, emails/phones, prices, feeds |
| `learn_extractor` | Learn rules from 1–2 example values per field (`{"title": ["…"], "price": ["…"]}`, `/regex/` allowed) and preview the records |
| `run_extractor` | Apply to the current tab, a URL or up to 500 URLs; `followPages` for pagination; records or grouped output; self-healing |
| `manage_extractors` | list / show / delete / keep_rules / remove_rules |

### Optional groups (`--tools core,scrape,storage,…` or `--tools all`)

| Group | Tools |
|---|---|
| `nav` | `go_forward`, `reload`, `wait_for_navigation`, `wait_for_url`, `wait_for_element`, `wait_for_text` |
| `tabs` | `list_pages`, `new_page`, `close_page`, `focus_page` |
| `forms` | `check_checkbox`, `upload_file`, `drag_and_drop`, `get_form_elements`, `scroll_to_element` |
| `inspect` | `get_page_content`, `get_page_html`, `get_element_text/attribute/value`, `element_exists`, `element_count`, `get_bounding_box`, `get_accessibility_tree`, `get_links`, `get_table_data`, `get_page_summary` |
| `storage` | cookies, localStorage, sessionStorage, `save/load_storage_state` |
| `network` | `get_network_log`, `get_console_logs`, `wait_for_response/request/network_idle`, `block_urls`, `set_extra_headers` |
| `device` | `set_viewport`, `emulate_device` (50+ presets), `list_devices`, geolocation, permissions |
| `frames` | `list_frames`, `execute_in_frame`, `click_in_frame` |
| `pdf` | `save_as_pdf` |
| `vision` | `mark_page`, `click_element`, `type_into_element`, `mark_page_and_screenshot`, `unmark_page` |
| `misc` | `handle_dialog`, `smart_action`, `get_browser_info` |

Individual tool names work too: `--tools core,scrape,get_cookies`.

---

## Workflows

**Interact**

```
navigate {url, returns: "snapshot"}
  → - textbox "Email" [e3] (required)  - textbox "Password" [e4]  - button "Sign in" [e7]
batch {steps: [{action:"fill",selector:"e3",text:"me@x.com"},
               {action:"fill",selector:"e4",text:"…"},
               {action:"click",selector:"e7"},
               {action:"wait",text:"Dashboard"}]}
  → 4 steps ✓, → [1] Dashboard | https://app.example/home
```

Password values are never echoed back. Alerts are accepted and confirms dismissed automatically, and the next result reports them. `handle_dialog` overrides this for the next dialog.

**Read and research**

```
scrape {urls: [...10 docs pages...], query: "rate limits", maxChars: 1500}
```

**Scrape at scale with no per-page LLM calls**

```
learn_extractor {name:"jobs", url:"https://jobs.example/search?q=rust",
                 examples:{title:["Senior Rust Engineer"], company:["Acme"], link:["https://jobs.example/j/123"]}}
run_extractor   {name:"jobs", url:"https://jobs.example/search?q=go", followPages: 10, outputFile:"jobs.jsonl"}
crawl           {url:"https://jobs.example", include:["/search"], extractor:"jobs", maxPages:200, outputFile:"all.jsonl"}
```

Extractors are saved to `~/.browser-mcp/extractors/<name>.json` (override with `--data-dir`). The format is DejavuScraper's, so rules move between the MCP server and Python:

```python
from dejavu_scraper import DejavuScraper
s = DejavuScraper(); s.load("~/.browser-mcp/extractors/jobs.json")
s.get_result_similar(url="https://jobs.example/search?q=python", group_by_alias=True)
```

`run_extractor` also accepts a path to a rules file saved by Python (`name: "/path/rules.json"`).

**How the extractor works.** For each example value it finds the element holding it (text, direct text, or an attribute such as `href`/`src`) and records the tag/class path from the document root. Applying a rule walks that path while allowing any sibling index, which yields every similar item. Results are zipped into records by finding each item's container. Each rule also stores a fingerprint of what it matched (text shapes like `$9.9`, lengths, tags and classes). If a redesign breaks the path, similar elements are scored against that fingerprint and the result is flagged as healed. `<tbody>` is treated as transparent, so rules learned on a live browser DOM also apply to raw HTML.

---

## CLI options

```
TOOLS        --tools <groups|names|all>   default: core,scrape
             --human                      human-like timing and mouse paths (slower, stealthier)
SCRAPING     --data-dir <path>            learned extractors (default ~/.browser-mcp)
             --cache-ttl <seconds>        page cache (default 300)
             --pool-size <n>              background tabs for scraping (default 4)
             --no-block-resources         load images/fonts/media when scraping in the browser
TRANSPORT    --http <port>                Streamable HTTP at http://127.0.0.1:<port>/mcp (default: stdio)
             --host <addr>                bind address (default 127.0.0.1)
             --token <secret>             require "Authorization: Bearer <secret>"
CONNECTION   --cdp <url> | --user-data-dir <path> | --executable-path <path> | --channel chrome|msedge
BROWSER      --browser chromium|firefox|webkit  --headless  --timeout <ms>
DEVICE       --viewport 1920x1080  --device "iPhone 15"
NETWORK      --proxy-server <url>  --proxy-bypass <list>  --ignore-https-errors  --block-service-workers
CONTEXT      --user-agent  --locale  --timezone  --color-scheme  --geolocation lat,lng  --permissions a,b
SESSION      --storage-state <file>   VIDEO  --record-video  --video-dir <path>
```

Environment variables: `BROWSER_CDP_URL`, `BROWSER_USER_DATA_DIR`, `BROWSER_EXECUTABLE_PATH`, `BROWSER_ENGINE`, `BROWSER_PROXY`, `BROWSER_HEADLESS=1`, `BROWSER_HUMAN=1`, `BROWSER_MCP_TOOLS`, `BROWSER_MCP_DATA_DIR`, `BROWSER_MCP_TOKEN`.

The HTTP fast path uses `--proxy-server` when it is an http(s) proxy, or `HTTPS_PROXY`/`HTTP_PROXY`. With a SOCKS proxy every fetch goes through the browser.

### Remote / Docker

```bash
docker build -t browser-mcp .
docker run -p 8931:8931 browser-mcp --http 8931 --host 0.0.0.0 --token "$TOKEN"
```

Each MCP session gets its own server instance; all sessions share one browser, page cache and extractor store. `GET /health` returns status. When bound to a loopback address, DNS-rebinding protection is enabled.

---

## Stealth notes

- Chromium runs with `--disable-blink-features=AutomationControlled`, so `navigator.webdriver` is false without injected scripts (which are themselves detectable).
- In headless mode the `HeadlessChrome` user-agent token is replaced with the regular Chrome UA for the same version.
- Persistent and CDP sessions keep their real user agent, since changing it logs you out of many sites.
- Scraping in the browser waits for interstitial checks ("Just a moment…", "Client Challenge") to finish before reading the page.
- `--human` adds Bezier mouse movement, click jitter, variable typing speed and smooth scrolling.

---

## Development

```bash
npm run build
npm test            # builds, then runs unit tests and an MCP end-to-end test on a local fixture site
npm run test:unit   # content engines only (no browser needed)
BROWSER_EXECUTABLE_PATH=/path/to/chrome npm test   # use a specific Chromium
```

Layout:

```
src/index.ts            CLI, stdio/HTTP transports, server factory
src/toolsets.ts         tool groups and --tools filtering
src/tools/core.ts       snapshot/interaction tools, batch
src/tools/scrape.ts     scrape, crawl, map_site, extract_structured, learn/run/manage_extractors
src/tools/actions.ts    shared action implementations (used by tools and batch)
src/snapshot.ts         in-page ref snapshot, diffs, ref resolution (incl. iframes, shadow DOM)
src/scraper.ts          HTTP fast path, browser pool, cache, robots.txt, crawl, sitemap map
src/content/markdown.ts HTML → markdown (runs in-page or on linkedom)
src/content/bm25.ts     query-focused chunk filtering
src/content/structured.ts  metadata / JSON-LD / tables / lists / pagination / contacts
src/content/dejavu.ts   DejavuScraper port: learn, apply, records, self-healing
src/tools.ts            v2 tools (optional groups)
```

## License

MIT
