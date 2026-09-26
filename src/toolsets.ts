import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tool groups. Every tool definition is sent to the model on every turn, so
 * exposing 80 tools costs thousands of tokens per request. By default only the
 * `core` and `scrape` groups are enabled; add others with --tools.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  core: [
    "browser_connect", "navigate", "go_back", "snapshot", "click", "type_text", "fill_form", "select_option",
    "hover", "press_key", "scroll", "wait_for", "batch", "tabs", "take_screenshot", "read_page",
    "evaluate_javascript", "close_browser",
  ],
  scrape: ["scrape", "crawl", "map_site", "extract_structured", "learn_extractor", "run_extractor", "manage_extractors"],
  nav: ["go_forward", "reload", "wait_for_navigation", "wait_for_url", "wait_for_element", "wait_for_text"],
  tabs: ["list_pages", "new_page", "close_page", "focus_page"],
  forms: ["check_checkbox", "upload_file", "drag_and_drop", "get_form_elements", "scroll_to_element"],
  inspect: [
    "get_page_content", "get_page_html", "get_element_text", "get_element_attribute", "get_element_value",
    "element_exists", "element_count", "get_bounding_box", "get_accessibility_tree", "get_links", "get_table_data",
    "get_page_summary",
  ],
  storage: [
    "get_cookies", "set_cookies", "clear_cookies", "get_local_storage", "set_local_storage", "get_session_storage",
    "set_session_storage", "clear_storage", "save_storage_state", "load_storage_state",
  ],
  network: [
    "wait_for_network_idle", "wait_for_response", "wait_for_request", "get_network_log", "get_console_logs",
    "block_urls", "set_extra_headers",
  ],
  device: ["set_viewport", "emulate_device", "list_devices", "set_geolocation", "grant_permissions", "clear_permissions"],
  frames: ["list_frames", "execute_in_frame", "click_in_frame"],
  pdf: ["save_as_pdf"],
  vision: ["mark_page", "unmark_page", "click_element", "type_into_element", "mark_page_and_screenshot"],
  misc: ["handle_dialog", "smart_action", "get_browser_info"],
};

export const DEFAULT_GROUPS = ["core", "scrape"];

/** Parse "--tools core,scrape,storage" / "all" / individual tool names into a filter. */
export function resolveToolFilter(spec: string | undefined): (name: string) => boolean {
  const items = (spec || DEFAULT_GROUPS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.includes("all")) return () => true;
  const allowed = new Set<string>();
  for (const item of items) {
    if (TOOL_GROUPS[item]) TOOL_GROUPS[item].forEach((t) => allowed.add(t));
    else allowed.add(item); // an individual tool name
  }
  return (name) => allowed.has(name);
}

/** Wrap the server so `tool()` registrations outside the filter are skipped. */
export function filteredServer(server: McpServer, allow: (name: string) => boolean): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (name: string, ...rest: any[]) => (allow(name) ? (target.tool as any)(name, ...rest) : undefined);
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
