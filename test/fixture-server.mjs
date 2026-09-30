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

/** A realistic, busy e-commerce listing page (nav, filters, 24 cards, footer, cookie banner). */
function shop(n) {
  const cats = ["Phones", "Laptops", "Tablets", "Watches", "Audio", "Cameras", "Gaming", "TV", "Smart Home", "Accessories"];
  const nav = cats.map((c) => `<li class="nav-item"><a href="/c/${c.toLowerCase()}">${c}</a><ul class="mega">${[1, 2, 3].map((i) => `<li><a href="/c/${c.toLowerCase()}/${i}">${c} line ${i}</a></li>`).join("")}</ul></li>`).join("");
  const brands = ["Apple", "Samsung", "Google", "OnePlus", "Xiaomi", "Sony", "LG", "Motorola", "Nokia", "Huawei", "Oppo", "Vivo", "Asus", "Lenovo", "Dell", "HP"];
  const filters = brands.map((b) => `<label class="filter"><input type="checkbox" name="brand" value="${b}"> ${b}</label>`).join("");
  const cards = Array.from({ length: 24 }, (_, i) => {
    const id = (n - 1) * 24 + i + 1;
    return `<article class="card" data-id="${id}"><a class="thumb" href="/p/${id}"><img src="/img/${id}.jpg" alt="Product ${id}"></a>
<h3 class="title"><a href="/p/${id}">Product ${id} Pro Max</a></h3><div class="rating" aria-label="4.${id % 10} out of 5">★★★★☆ <span>(${100 + id})</span></div>
<div class="price">$${(id * 7.5).toFixed(2)}</div><button class="add" onclick="addToCart(${id})">Add to cart</button> <button class="wish" aria-label="Add Product ${id} to wishlist">♡</button></article>`;
  }).join("\n");
  const pages = Array.from({ length: 10 }, (_, i) => `<a href="/shop?page=${i + 1}">${i + 1}</a>`).join(" ");
  const footer = ["About", "Help", "Legal", "Social"].map((col) => `<div class="col"><h4>${col}</h4><ul>${Array.from({ length: 12 }, (_, i) => `<li><a href="/${col.toLowerCase()}/${i}">${col} link ${i + 1}</a></li>`).join("")}</ul></div>`).join("");
  return `<!doctype html><html lang="en"><head><title>MegaStore — page ${n}</title><style>.mega{display:none}.nav-item:hover .mega{display:block}</style></head><body>
<div id="cookies" class="cookie-banner" role="dialog" aria-label="Cookie consent"><p>We use cookies to improve your experience.</p><button onclick="document.getElementById('cookies').remove()">Accept all</button><button onclick="document.getElementById('cookies').remove()">Reject</button></div>
<header><a href="/" class="logo">MegaStore</a><form role="search" action="/search"><input type="search" name="q" placeholder="Search products"><button>Search</button></form>
<a href="/account">Account</a> <button id="cart" aria-live="polite">Cart (0)</button><nav aria-label="Categories"><ul>${nav}</ul></nav></header>
<main><aside class="filters"><h2>Filter</h2><fieldset><legend>Brand</legend>${filters}</fieldset>
<fieldset><legend>Price</legend>${["Under $50", "$50–$200", "$200–$500", "Over $500"].map((p) => `<label><input type="radio" name="price"> ${p}</label>`).join("")}</fieldset></aside>
<section class="results"><h1>All products</h1><p class="count">240 results</p><select aria-label="Sort by"><option>Featured</option><option>Price: low to high</option><option>Price: high to low</option></select>
<div class="grid">${cards}</div><nav class="pagination" aria-label="Pages">${pages} ${n < 10 ? `<a rel="next" href="/shop?page=${n + 1}">Next</a>` : ""}</nav></section></main>
<footer>${footer}<p>© 2026 MegaStore</p></footer>
<script>let cart=0;function addToCart(id){cart++;document.getElementById('cart').textContent='Cart ('+cart+')';fetch('/api/event?type=cart&id='+id);}</script></body></html>`;
}

export const events = [];

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
    if (url.pathname === "/shop") return send(200, shop(parseInt(url.searchParams.get("page") || "1", 10)));
    if (url.pathname === "/api/event") {
      events.push(Object.fromEntries(url.searchParams));
      return send(200, "{}", "application/json");
    }
    if (url.pathname === "/list") return send(200, page(parseInt(url.searchParams.get("page") || "1", 10)));
    if (url.pathname === "/api/products") {
      // JSON API behind /app.html; requires the auth header the page's JS sends.
      if (req.headers["x-api-key"] !== "demo-key") return send(401, JSON.stringify({ error: "missing key" }), "application/json");
      const p = parseInt(url.searchParams.get("page") || "1", 10);
      const items = [1, 2, 3, 4].map((i) => ({ id: (p - 1) * 4 + i, name: `Widget ${(p - 1) * 4 + i}`, price: 10 * ((p - 1) * 4 + i), tags: ["a", "b"] }));
      return send(200, JSON.stringify({ page: p, total: 12, items }), "application/json");
    }
    if (url.pathname === "/app.html") {
      return send(200, `<!doctype html><html><head><title>Widget App</title></head><body><h1>Widgets</h1><ul id="list"></ul><button id="more">Load more</button>
<script>let p=1;async function load(){const r=await fetch('/api/products?page='+p,{headers:{'x-api-key':'demo-key'}});const d=await r.json();for(const it of d.items){const li=document.createElement('li');li.className='item';li.textContent=it.name+' — $'+it.price;document.getElementById('list').appendChild(li);}p++;}
document.getElementById('more').onclick=load;load();</script></body></html>`);
    }
    if (url.pathname === "/feed.html") {
      return send(200, `<!doctype html><html><head><title>Feed</title><style>.post{height:220px;border:1px solid #ccc}</style></head><body><h1>Feed</h1><div id="feed"></div>
<script>let n=0;function more(){for(let i=0;i<10&&n<40;i++){const d=document.createElement('div');d.className='post';d.textContent='Post number '+(++n);document.getElementById('feed').appendChild(d);}}
more();addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.body.offsetHeight-50)setTimeout(more,100);});</script></body></html>`);
    }
    if (url.pathname === "/private") return send(200, "<html><body>secret</body></html>");
    if (url.pathname === "/blocked") return send(403, "<html><head><title>Just a moment...</title></head><body>cf-chl challenge</body></html>");
    if (url.pathname === "/" ) return send(200, `<html><head><title>Home</title></head><body><h1>Home</h1><p>Welcome to the fixture site, a small website used by the automated test-suite to check crawling and scraping.</p><a href="/article.html">Article</a> <a href="/products.html">Products</a> <a href="/list?page=1">List</a> <a href="/private">Private</a></body></html>`);
    const file = join(dir, url.pathname.replace(/^\//, ""));
    if (file.startsWith(dir) && existsSync(file)) return send(200, readFileSync(file), file.endsWith(".pdf") ? "application/pdf" : "text/html; charset=utf-8");
    send(404, "<html><body>not found</body></html>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
