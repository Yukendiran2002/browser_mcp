// Unit tests for the browser-free content engines (markdown, BM25, structured data, DejavuScraper port).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../dist/content/dom.js";
import { htmlToMarkdown } from "../dist/content/markdown.js";
import { filterByQuery } from "../dist/content/bm25.js";
import { extractStructured } from "../dist/content/structured.js";
import { learn, applyRules, records, grouped, normalizeModel } from "../dist/content/dejavu.js";
import { buildSelector } from "../dist/utils.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const doc = (name) => parseDocument(readFileSync(join(fixtures, name), "utf8"));
const BASE = "https://gadget.example/phones";

test("markdown keeps article content and drops page chrome", () => {
  const { markdown, title } = htmlToMarkdown({ baseUrl: "https://blog.example/post", mainContent: true }, doc("article.html"));
  assert.equal(title, "How Browsers Render Pages");
  assert.match(markdown, /^# How Browsers Render Pages/);
  assert.match(markdown, /parses \*\*HTML\*\* into/);
  assert.match(markdown, /\[MDN performance guide\]\(https:\/\/developer\.mozilla\.org\/docs\/Web\/Performance\)/);
  assert.match(markdown, /  - Cascade/);
  assert.match(markdown, /```js\nrequestAnimationFrame/);
  assert.match(markdown, /\| Stage \| Cost \|\n\| --- \| --- \|/);
  for (const noise of ["We use cookies", "Other post A", "© 2026", "Blog"]) assert.ok(!markdown.includes(noise), noise);
});

test("markdown link refs mode puts URLs in a footer", () => {
  const { markdown } = htmlToMarkdown({ baseUrl: "https://blog.example/post", mainContent: true, links: "refs" }, doc("article.html"));
  assert.match(markdown, /\[MDN performance guide\]\[1\]/);
  assert.match(markdown, /\n\[1\]: https:\/\/developer\.mozilla\.org/);
});

test("markdown separates adjacent inline elements", () => {
  const { markdown } = htmlToMarkdown({ baseUrl: BASE, mainContent: true }, doc("products.html"));
  assert.match(markdown, /\$999\.00 ★★★★☆/);
});

test("BM25 query filter keeps only relevant sections", () => {
  const { markdown } = htmlToMarkdown({ mainContent: true }, doc("article.html"));
  const f = filterByQuery(markdown, "GPU compositing", 400);
  assert.equal(f.kept, 1);
  assert.match(f.markdown, /GPU acceleration/);
  assert.ok(!f.markdown.includes("reflow"));
});

test("structured extraction finds metadata, JSON-LD, tables, items, pagination, contacts", () => {
  const s = extractStructured(doc("products.html"), BASE);
  assert.equal(s.metadata.description, "Buy the latest phones");
  assert.equal(s.metadata.canonical, "https://gadget.example/phones");
  assert.equal(s.jsonld[0].name, "Gadget Store");
  assert.deepEqual(s.tables[0].headers, ["Model", "Screen", "Battery"]);
  assert.equal(s.tables[0].rows[1].Battery, "4000 mAh");
  const list = s.lists[0];
  assert.equal(list.count, 4, "featured item with an extra class is still grouped");
  assert.deepEqual(
    list.items.map((i) => [i.title, i.price, i.url]),
    [
      ["iPhone 15", "$999.00", "https://gadget.example/p/iphone-15"],
      ["Samsung Galaxy S24", "$899.00", "https://gadget.example/p/galaxy-s24"],
      ["Google Pixel 8", "$699.00", "https://gadget.example/p/pixel-8"],
      ["OnePlus 12", "$799.00", "https://gadget.example/p/oneplus-12"],
    ]
  );
  assert.equal(s.pagination.next, "https://gadget.example/phones?page=2");
  assert.deepEqual(s.contacts.emails, ["sales@gadget.example"]);
  assert.ok(s.contacts.phones.some((p) => p.includes("555-0123")));
  assert.deepEqual(s.prices, ["$999.00", "$899.00", "$699.00", "$799.00"]);
});

test("dejavu: learn from one example per field, extract all records", () => {
  const d = doc("products.html");
  const { rules, unmatched } = learn(d, BASE, { name: ["iPhone 15"], price: ["$999.00"], link: ["https://gadget.example/p/iphone-15"] });
  assert.deepEqual(unmatched, []);
  const recs = records(applyRules(d, BASE, rules));
  assert.deepEqual(recs, [
    { name: "iPhone 15", price: "$999.00", link: "https://gadget.example/p/iphone-15" },
    { name: "Samsung Galaxy S24", price: "$899.00", link: "https://gadget.example/p/galaxy-s24" },
    { name: "Google Pixel 8", price: "$699.00", link: "https://gadget.example/p/pixel-8" },
    { name: "OnePlus 12", price: "$799.00", link: "https://gadget.example/p/oneplus-12" },
  ]);
});

test("dejavu: regex examples and unmatched reporting", () => {
  const d = doc("products.html");
  const { rules, unmatched } = learn(d, BASE, { price: ["/\\$\\d+\\.00/"], nope: ["does not exist"] });
  assert.deepEqual(unmatched, ["nope: does not exist"]);
  assert.deepEqual(grouped(applyRules(d, BASE, rules)).price, ["$999.00", "$899.00", "$699.00", "$799.00"]);
});

test("dejavu: rules self-heal after a redesign", () => {
  const { rules } = learn(doc("products.html"), BASE, { name: ["iPhone 15"], price: ["$999.00"] });
  const res = applyRules(doc("products-v2.html"), BASE, rules);
  assert.ok(res.some((r) => r.healed));
  assert.deepEqual(records(res), [
    { name: "iPhone 16", price: "$1,099.00" },
    { name: "Samsung Galaxy S25", price: "$949.00" },
    { name: "Google Pixel 9", price: "$799.00" },
  ]);
});

test("dejavu: loads rule files written by the Python DejavuScraper", () => {
  const model = normalizeModel(JSON.parse(readFileSync(join(fixtures, "dejavu-python-rules.json"), "utf8")));
  const g = grouped(applyRules(doc("products.html"), BASE, model.stack_list));
  assert.deepEqual(g.price, ["$999.00", "$899.00", "$699.00", "$799.00"]);
  for (const n of ["iPhone 15", "Samsung Galaxy S24", "Google Pixel 8", "OnePlus 12"]) assert.ok(g.name.includes(n), n);
});

test("buildSelector treats tag names as CSS and words as text", () => {
  assert.equal(buildSelector("button"), "button");
  assert.equal(buildSelector("#login .btn"), "#login .btn");
  assert.equal(buildSelector("//div[@id='x']"), "xpath=//div[@id='x']");
  assert.equal(buildSelector("Sign in"), 'text="Sign in"');
  assert.equal(buildSelector("role=button[name=\"Go\"]"), 'role=button[name="Go"]');
});
