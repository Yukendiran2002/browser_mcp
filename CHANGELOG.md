# Changelog

## 3.0.0

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
