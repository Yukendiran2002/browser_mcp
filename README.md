# Browser MCP Server

**Browser automation and web scraping for AI agents, built to keep token cost and latency low.**

An [MCP](https://modelcontextprotocol.io/) server built on [Playwright](https://playwright.dev/). It gives agents a real browser (including your logged-in Chrome) and a scraping engine that only starts a browser when a page actually needs one. It also calls sites' own JSON APIs directly, replays recorded flows as macros, and ships [DejavuScraper](https://github.com/Yukendiran2002/dejavu_scraper)'s learn-by-example extraction: learn a scraper from one example value per field, then run it on any number of similar pages without an LLM call per page.

```
You: "Get name + price for every laptop on shop.example, all pages."

agent → learn_extractor {url, examples: {name: ["ThinkPad X1"], price: ["$1,299"]}}   ← 1 LLM turn
agent → run_extractor   {name: "laptops", url, followPages: 20}                         ← 0 LLM tokens per page
      ← 480 records as JSON
```

---

## Head-to-head benchmark

`bench/compare.mjs` runs the same four tasks against this server, [Playwright MCP](https://github.com/microsoft/playwright-mcp) 0.0.82 and [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 1.10.1 on a local fixture site, using the call sequence a competent agent would use with each server's own tools (Playwright's `browser_find`/`browser_fill_form`/`browser_evaluate`, DevTools' `fill_form`/`evaluate_script`/`wait_for`, …). Success is checked server-side, not from tool output.

| Task | This server | Playwright MCP | Chrome DevTools MCP |
|---|---|---|---|
| **shop**: busy store page, dismiss cookie banner, add product 3 to cart, confirm | 3 calls · 1.3k result tokens | 5 calls · 6.1k | 5 calls · 10.4k |
| **login**: fill 4 fields, submit, confirm welcome | 2 calls · 0.3k | 5 calls · 0.6k | 5 calls · 0.6k |
| **extract**: name + price of 72 products on 3 pages | 2 calls · 1.0k | 7 calls · 7.4k | 7 calls · 6.2k |
| **read**: answer a question from an article | 1 call · 0.1k | 2 calls · 0.8k | 2 calls · 0.6k |
| **Total** (all 4/4 successful) | **8 calls · 2.7k · 3.1 s** | 19 calls · 14.8k · 7.6 s | 19 calls · 17.7k · 5.4 s |
| Tool schema sent every turn | 27 tools · 4.6k tokens | 25 tools · 5.0k | 30 tools · 6.4k |
| **Estimated input tokens** (schema + growing context, per turn, uncached) | **61k** | 184k (3.0×) | 212k (3.5×) |

Snapshot of a real page ([pypi.org/project/httpx](https://pypi.org/project/httpx/), `bench/real.mjs`):

| | chars | ≈ tokens |
|---|---:|---:|
| Playwright MCP `browser_snapshot` | 31,171 | 7,800 |
| Chrome DevTools MCP `take_snapshot` | 28,419 | 7,100 |
| **`snapshot`** (all 96 actionable elements, with refs) | 3,837 | **960** |
| **`snapshot viewportOnly`** | 751 | **190** |
| **`read_page`** (visible main content as markdown) | 4,358 | 1,090 |

Caveats: the task scripts and the fixture site are ours; they use each competitor's most economical tools, but a real LLM agent may take different paths. Reproduce with `cd bench && npm install && node compare.mjs`.

---

## How it compares

Features found by reviewing the leading browser/scraping MCP servers (September 2026) and what this server does about each:

| Idea (where it comes from) | Here |
|---|---|
| Accessibility snapshot with refs (Playwright MCP, Chrome DevTools MCP, agent-browser) | Actionable-only snapshot with landmarks; merges headings into their links, drops duplicate thumbnail links, folds footer link farms; `find=` search and `root=` scoping |
| See the effect of an action (Playwright returns code only; DevTools needs `includeSnapshot`) | Every action returns the snapshot **diff**, navigation, new tab, dialog, and live-region messages |
| Big outputs to files (Playwright CLI, Firecrawl >20k handoff) | Any result over `--max-response` is saved to a file and only the head is returned |
| Secrets (Playwright `--secrets`, agent-browser auth vault) | `{{secret.NAME}}` placeholders; values are masked in every response, including JS results |
| `--if-changed` screenshots (agent-browser) | `take_screenshot ifChanged` |
| Search + scrape in one call (Firecrawl) | `web_search scrape=N` (DuckDuckGo, SearXNG or Brave), HTTP-first `scrape`/`crawl`/`map_site`, PDFs |
| LLM-free CSS schemas, best-first crawling, infinite scroll (Crawl4AI) | `extract_structured schema=`, `crawl query=` visits relevant links first, `scrape scroll=N` |
| Call the site's internal APIs instead of rendering (Unbrowse) | `list_apis` / `call_api`: JSON XHR/fetch traffic is captured while browsing and replayed with the session's cookies and auth headers, with `select=` field paths |
| Self-healing, cached actions (Stagehand/Browserbase, needs an LLM + API key) | Learned extractors self-heal by fingerprint; **macros** replay recorded flows with stable selectors and variables, with no LLM and no key |
| Performance insights (Chrome DevTools MCP) | `page_metrics`: TTFB/FCP/LCP/CLS, long tasks, bytes by type, DOM size, errors |
| Allowed/blocked origins, idle timeout (Playwright MCP) | `--allowed-domains`, `--blocked-domains` (enforced on every top-level navigation), `--idle-timeout` |

Not covered: Lighthouse audits, heap snapshots and tracing (use Chrome DevTools MCP), cross-browser test assertions/codegen (Playwright MCP), hosted infrastructure and CAPTCHA solving (Browserbase, Firecrawl).

---

## Why it's cheaper and faster

| Technique | What it saves |
|---|---|
| **Ref snapshots** | One line per actionable element (`- button "Sign in" [e7]`) instead of the full accessibility tree. |
| **Actions return diffs** | The agent rarely needs a second snapshot after acting. |
| **`batch` and macros** | A whole form in one call; a saved flow replays in one call with no reasoning. |
| **HTTP-first scraping** | Plain HTTP (10–50 ms) and a background browser tab only for JS-rendered pages or bot walls; the decision is remembered per host. |
| **Markdown + `query=`** | Main content only, then only the BM25-relevant sections. |
| **Direct API calls** | Paginating a JSON endpoint costs a few hundred tokens instead of a page render + snapshot. |
| **Learned extractors / CSS schemas** | Structured records from any number of pages with no per-page LLM work. |
| **Small default toolset + size cap** | 27 tools (~4.6k schema tokens); results over 25k chars spill to files. |
| **Fast mode by default** | No artificial delays; `--human` for human-like timing. |

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
| `snapshot` | Actionable elements with refs, plus headings, landmarks, live regions and iframes. `find`, `root`, `viewportOnly`, `mode: "full"`, `urls` |
| `click`, `type_text`, `select_option`, `hover`, `press_key`, `scroll` | Accept a **ref** (`e12`, `f2e3` for iframes), CSS, XPath or visible text/label. Return what changed |
| `fill_form` | Text fields, selects and checkboxes in one call |
| `batch` | Up to 50 steps (`navigate, click, type, fill, select, check, uncheck, hover, press, scroll, wait, upload, drag, eval, back, forward, reload`) in one call |
| `wait_for` | Text, element (or `gone`), URL, network idle, or ms |
| `read_page` | Current tab as clean markdown; `query`, `selector`, `links: inline\|refs\|none` |
| `take_screenshot` | JPEG at CSS scale; element or full page; `ifChanged` skips identical images |
| `tabs`, `go_back`, `evaluate_javascript` | |

### `scrape`: fetch, search, crawl, extract

| Tool | What it does |
|---|---|
| `web_search` | Search (DuckDuckGo by default, `--search-url` SearXNG, or `BRAVE_API_KEY`); `scrape: N` also returns the top N pages as query-filtered markdown |
| `scrape` | One URL or up to 100 (`urls`) concurrently, as markdown. HTML, PDFs, JSON. `mode: auto\|http\|browser`, `query`, `scroll`, `structured`, `includeLinks`, `outputFile` |
| `crawl` | Same-domain, robots.txt-aware, concurrent; best-first when `query` is set; `include`/`exclude`, `extractor` or `schema` for records, `outputFile` |
| `map_site` | URLs from robots.txt, sitemaps and homepage links; `search` ranks by keyword |
| `extract_structured` | Metadata, JSON-LD, microdata, tables, repeated items, pagination, contacts, prices, feeds, or your own CSS `schema` |
| `learn_extractor`, `run_extractor`, `manage_extractors` | Learn rules from 1–2 example values per field and run them on any number of pages (pagination, self-healing, DejavuScraper-compatible files) |
| `list_apis` | JSON endpoints the site called while you browsed, with response shapes (`{items:[24]{id:num,name:str}}`) |
| `call_api` | Call an endpoint with the browser's cookies and captured auth headers; `query` overrides, `select: "items[*].{name,price}"` |

### `macros`

| Tool | What it does |
|---|---|
| `macro` | Actions are recorded automatically (refs become stable selectors such as `#email` or `button:text-is("Sign in")`). `save` with `params: {"email": "me@x.com"}` turns example values into variables; `run` with `vars` replays the flow |

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
| `session` | `browser_connect`, `close_browser` (connection is normally set by CLI flags; tools auto-connect) |
| `devtools` | `page_metrics`, `get_network_log`, `get_console_logs` |
| `misc` | `handle_dialog`, `smart_action`, `get_browser_info` |

Default: `core,scrape,macros` (27 tools). Individual tool names work too: `--tools core,scrape,get_cookies`.

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

**Skip the page, call the API**

```
navigate {url: "https://shop.example/search?q=tv"}      ← the page loads its data from JSON
list_apis
  → GET shop.example/api/search?q=&page= ×1 → 200 48KB · auth header
    shape: {results:[24]{id:num,title:str,price:{amount:num}},total:num}
call_api {url: "https://shop.example/api/search", query: {q: "tv", page: 2}, select: "results[*].{title,price}"}
```

**Record once, replay forever**

```
batch {...log in and search as usual...}
macro {action: "save", name: "search", params: {"query": "laptops"}}
macro {action: "run",  name: "search", vars: {"query": "phones"}}      ← later, one call, no reasoning
```

Secrets stay out of the model's context: start with `--secrets .env` (or `BROWSER_SECRET_*` variables) and type `{{secret.GITHUB_PASSWORD}}`. The real value never appears in any result, and saved macros keep the placeholder.

**How the extractor works.** For each example value it finds the element holding it (text, direct text, or an attribute such as `href`/`src`) and records the tag/class path from the document root. Applying a rule walks that path while allowing any sibling index, which yields every similar item. Results are zipped into records by finding each item's container. Each rule also stores a fingerprint of what it matched (text shapes like `$9.9`, lengths, tags and classes). If a redesign breaks the path, similar elements are scored against that fingerprint and the result is flagged as healed. `<tbody>` is treated as transparent, so rules learned on a live browser DOM also apply to raw HTML.

---

## CLI options

```
TOOLS        --tools <groups|names|all>   default: core,scrape,macros
             --human                      human-like timing and mouse paths (slower, stealthier)
SCRAPING     --data-dir <path>            learned extractors (default ~/.browser-mcp)
             --cache-ttl <seconds>        page cache (default 300)
             --pool-size <n>              background tabs for scraping (default 4)
             --no-block-resources         load images/fonts/media when scraping in the browser
SAFETY/COST  --secrets <file.env>          {{secret.NAME}} placeholders; values masked in all output
             --max-response <chars>       larger results go to a file (default 25000, 0 = off); --output-dir <path>
             --allowed-domains <list>     e.g. "example.com,*.example.org"; --blocked-domains <list>
             --idle-timeout <seconds>     close a launched browser when idle (default 1800, 0 = never)
SEARCH       --search-url <url>           SearXNG instance; or set BRAVE_API_KEY; default DuckDuckGo HTML
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

Environment variables: `BROWSER_CDP_URL`, `BROWSER_USER_DATA_DIR`, `BROWSER_EXECUTABLE_PATH`, `BROWSER_ENGINE`, `BROWSER_PROXY`, `BROWSER_HEADLESS=1`, `BROWSER_HUMAN=1`, `BROWSER_MCP_TOOLS`, `BROWSER_MCP_DATA_DIR`, `BROWSER_MCP_TOKEN`, `BROWSER_MCP_SECRETS`, `BROWSER_SECRET_<NAME>`, `BROWSER_MCP_SEARCH_URL`, `BRAVE_API_KEY`, `BROWSER_MCP_ALLOWED_DOMAINS`, `BROWSER_MCP_BLOCKED_DOMAINS`.

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
src/tools/actions.ts    shared action implementations (used by tools, batch and macros)
src/tools/apis.ts       list_apis / call_api;  src/apis.ts captures JSON traffic
src/tools/devtools.ts   page_metrics
src/macros.ts           stable selectors, recorder, macro storage
src/search.ts           web_search providers
src/governor.ts         secret masking + oversized-result spill to files
src/policy.ts           allowed/blocked domains
bench/                  head-to-head benchmark vs Playwright MCP and Chrome DevTools MCP
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
