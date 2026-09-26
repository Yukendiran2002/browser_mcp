// Tiny static server for tests: serves test/fixtures plus a few generated routes.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function page(n) {
  const items = [1, 2, 3].map((i) => {
    const id = (n - 1) * 3 + i;
    return `<div class="product card"><h2 class="name"><a href="/p/item-${id}">Item ${id}</a></h2><span class="price">$${id}9.00</span></div>`;
  });
  const next = n < 3 ? `<a class="next" rel="next" href="/list?page=${n + 1}">Next</a>` : "";
  return `<!doctype html><html><head><title>List ${n}</title></head><body><main><div class="products">${items.join("")}</div>${next}</main></body></html>`;
}

export function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body, type = "text/html; charset=utf-8") => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    if (url.pathname === "/robots.txt") return send(200, `User-agent: *\nDisallow: /private\nSitemap: http://${req.headers.host}/sitemap.xml\n`, "text/plain");
    if (url.pathname === "/sitemap.xml") {
      const h = `http://${req.headers.host}`;
      return send(200, `<?xml version="1.0"?><urlset><url><loc>${h}/article.html</loc></url><url><loc>${h}/products.html</loc></url><url><loc>${h}/list?page=1</loc></url></urlset>`, "application/xml");
    }
    if (url.pathname === "/list") return send(200, page(parseInt(url.searchParams.get("page") || "1", 10)));
    if (url.pathname === "/private") return send(200, "<html><body>secret</body></html>");
    if (url.pathname === "/blocked") return send(403, "<html><head><title>Just a moment...</title></head><body>cf-chl challenge</body></html>");
    if (url.pathname === "/" ) return send(200, `<html><head><title>Home</title></head><body><h1>Home</h1><p>Welcome to the fixture site, a small website used by the automated test-suite to check crawling and scraping.</p><a href="/article.html">Article</a> <a href="/products.html">Products</a> <a href="/list?page=1">List</a> <a href="/private">Private</a></body></html>`);
    const file = join(dir, url.pathname.replace(/^\//, ""));
    if (file.startsWith(dir) && existsSync(file)) return send(200, readFileSync(file));
    send(404, "<html><body>not found</body></html>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
