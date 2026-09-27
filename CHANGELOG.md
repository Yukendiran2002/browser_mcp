# Changelog

## 3.0.0

### Competitive round (after reviewing Playwright MCP, Chrome DevTools MCP, Firecrawl, Crawl4AI, agent-browser, Unbrowse, Browserbase)
- `list_apis` / `call_api`: JSON XHR/fetch traffic is captured while browsing; endpoints can be called directly with the session's cookies and captured auth headers, with `select` field paths.
- `macro`: actions are recorded with stable selectors (refs converted to `#id`, `[name=…]`, `:text-is()` or CSS paths); `save` with params, `run` with vars, no LLM needed.
- `web_search` (DuckDuckGo HTML, SearXNG via `--search-url`, Brave via `BRAVE_API_KEY`), optionally scraping the top N results in the same call.
- `extract_structured schema=` and `crawl schema=`: CSS-schema extraction (text, attribute, number, html, exists, list, nested, regex).
- `crawl` is best-first when `query` is set; `scrape scroll=N` for infinite scroll; PDFs are converted to markdown.
- `snapshot find=` (matching lines with their landmarks) and `root=` (scoped); `take_screenshot ifChanged`.
- Snapshots merge headings into their links, drop thumbnail links that duplicate a text link, and fold footer link farms (−34% on a busy store page).
- Response governor: `--secrets` / `BROWSER_SECRET_*` with `{{secret.NAME}}` placeholders masked in every response; `--max-response` spills oversized results to files (`--output-dir`).
- `--allowed-domains` / `--blocked-domains` enforced on navigate, scraping and every top-level browser navigation; `--idle-timeout`.
- `page_metrics` (devtools group): TTFB, FCP, LCP, CLS, long tasks, bytes by type, DOM size, errors.
- MCP `readOnlyHint` annotations on read-only tools.
- Default toolset `core,scrape,macros` (27 tools, ~4.6k schema tokens); `browser_connect`/`close_browser` moved to the `session` group.
- Record lists are returned one compact JSON object per line.
- `bench/`: reproducible head-to-head benchmark against Playwright MCP and Chrome DevTools MCP.

### Initial v3

Focus: lower token cost and latency for agents, plus built-in scraping.

### Added
- `snapshot`: compact ref-annotated list of actionable elements (landmarks, headings, live regions, iframes, open shadow DOM). Refs such as `e12` / `f2e3` work in every `selector` parameter.
- Actions (`click`, `type_text`, `fill_form`, `select_option`, `hover`, `press_key`, …) wait for the page to settle and return a snapshot diff, navigation, new-tab and dialog report.
- `batch`: run up to 50 actions in one call.
- `wait_for`, `tabs`, `read_page` (markdown of the current tab with BM25 `query` filtering).
- Scraping engine: `scrape` (single or batch URLs, HTTP-first with automatic browser fallback, response cache), `crawl` (BFS, robots.txt, include/exclude, JSONL output), `map_site` (robots.txt + sitemaps + links).
- `extract_structured`: metadata, JSON-LD, microdata, tables, repeated items, pagination, contacts, prices, feeds with no LLM.
- DejavuScraper port: `learn_extractor`, `run_extractor` (pagination, batch URLs, self-healing), `manage_extractors`. Rule files are compatible with the Python library.
- Tool groups (`--tools`), default `core,scrape` (25 tools).
- Streamable HTTP transport (`--http`, `--host`, `--token`), `/health`.
- Server instructions telling the model how to use the tools cheaply.
- Test suite (`npm test`): unit tests for the content engines and an MCP end-to-end test against a local fixture site.

### Changed
- Fast mode is the default (no artificial delays); human-like behaviour via `--human` or `browser_connect {human: true}`.
- Tools auto-connect on first use; `browser_connect` is optional.
- Screenshots default to JPEG at CSS scale.
- Selectors: bare tag names (`button`, `input`) are CSS; plain text also matches labels, aria-label, placeholder and title; a matched `<label>` resolves to its control.
- Node.js ≥ 20.18.1.

### Fixed
- `close_browser` on a CDP-attached Chrome no longer closes the user's browser contexts.
- Tools without `pageId` act on the active tab (last focused or opened) instead of the highest id.
- Network log matched responses by URL, which mixed up concurrent requests; it now tracks request objects, records failures and keeps the latest 500 entries (console log too).
- Tabs closed by the site are removed from the tab list.
- JS dialogs no longer block the page; `handle_dialog` no longer races with the default handler.
- Headless Chromium no longer sends a `HeadlessChrome` user agent; the `navigator.webdriver` override script is only injected for Firefox/WebKit.
- Chrome/Edge executable lookup for `--channel` on macOS and Linux.
