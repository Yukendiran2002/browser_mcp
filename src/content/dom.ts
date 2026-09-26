import { parseHTML } from "linkedom";

/** Parse an HTML string into a lightweight DOM document (no browser needed). */
export function parseDocument(html: string): any {
  const { document } = parseHTML(html);
  return document;
}
