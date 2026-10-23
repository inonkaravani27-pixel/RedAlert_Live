// RedAlert Live proxy. Node 18+, no dependencies. See README.md.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const E = process.env, PORT = +E.PORT || 8787, ORIGIN = E.ALLOWED_ORIGIN || "";
const POLL = +E.POLL_MS || 10000, STALE = +E.STALE_MS || 45000, MAXAGE = +E.MAX_AGE_MS || 1800000;
const OREF_URLS = (E.OREF_URLS || "https://orefproxy5.oref-map.org/api2/alerts,https://oref-map.org/api/alerts").split(",").map(s => s.trim()).filter(Boolean);
const list = v => (v || "").split(",").map(s => s.trim()).filter(Boolean);
const msg = e => String((e && e.message) || e).replace(/https?:\/\/\S+/g, "[url]").slice(0, 120);
const oref = { state: "unchecked", last: null, error: null, active: {}, title: null, category: null, rawCount: 0 };
const mk = p => ({
  kw: list(E[p + "_KEYWORDS"]).map(s => s.toLowerCase()),
  feeds: new Map(list(E[p + "_RSS_URLS"]).map(u => [u, { url: u, state: "unchecked", last: null, error: null }])),
  items: new Map(),
});
const G = { prelim: mk("PRELIM"), military: mk("MILITARY") };

const get = async url => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "RedAlertLive/1.0", Accept: "*/*" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
};
async function pollOref() {
  let lastError = "no source configured";
  for (const url of OREF_URLS) {
    try {
      const raw = (await get(url)).replace(/^\\uFEFF/, "").trim();
      // Oref returns an empty/BOM-only body when no alert is active.
      if (!raw) {
        Object.assign(oref, { state: "ok", last: Date.now(), error: null, active: {}, title: null, category: null, rawCount: 0 });
        return;
      }
      let parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed = parsed[0] || null;
      if (parsed === null) {
        Object.assign(oref, { state: "ok", last: Date.now(), error: null, active: {}, title: null, category: null, rawCount: 0 });
        return;
      }
      if (typeof parsed !== "object" || !parsed || !parsed.title || !Array.isArray(parsed.data)) throw new Error("unexpected alert response");
      const cities = parsed.data.filter(x => typeof x === "string");
      const active = cities.length ? { [String(parsed.title)]: cities } : {};
      Object.assign(oref, { state: "ok", last: Date.now(), error: null, active, title: String(parsed.title), category: parsed.cat ?? null, rawCount: cities.length });
      return;
    } catch (e) { lastError = msg(e); }
  }
  oref.state = "error"; oref.error = lastError;
}
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (b, n) => { const m = b.match(new RegExp("<" + n + "[^>]*>([\\s\\S]*?)</" + n + ">", "i")); return m ? dec(m[1]) : ""; };
function parseFeed(x) {
  const out = [];
  for (const m of x.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const b = m[0]; let link = tag(b, "link");
    if (!link) { const h = b.match(/<link[^>]*href="([^"]+)"/i); link = h ? h[1] : ""; }
    out.push({ title: tag(b, "title"), desc: tag(b, "description") || tag(b, "summary"), link, pub: Date.parse(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated")) });
  }
  return out;
}
const norm = t => t.replace(/[^\u0590-\u05ffa-z0-9]/gi, "").toLowerCase();
async function pollGroup(g) {
  for (const f of g.feeds.values()) {
    try {
      if (!g.kw.length) throw new Error("KEYWORDS env var required");
      const now = Date.now(), host = new URL(f.url).hostname;
      for (const it of parseFeed(await get(f.url))) {
        if (!it.title || !Number.isFinite(it.pub) || now - it.pub > MAXAGE || it.pub - now > 600000) continue;
        if (!/^https?:\/\//.test(it.link)) continue;
        const txt = (it.title + " " + it.desc).toLowerCase();
        if (!g.kw.some(k => txt.includes(k))) continue;
        const key = norm(it.title), dup = [...g.items.values()].find(x => x.key === key);
        if (dup) { if (!dup.sources.includes(host)) dup.sources.push(host); continue; }
        const id = crypto.createHash("sha1").update(it.link).digest("hex").slice(0, 16);
        if (!g.items.has(id)) g.items.set(id, { id, key, title: it.title, link: it.link, sources: [host], published: it.pub, received: now });
      }
      Object.assign(f, { state: "ok", last: Date.now(), error: null });
    } catch (e) { f.state = "error"; f.error = msg(e); }
  }
  for (const [id, x] of g.items) if (Date.now() - x.published > MAXAGE) g.items.delete(id);
}
const stale = (o, ms) => (o.state === "ok" && Date.now() - o.last > ms ? { ...o, state: "stale" } : o);
const grp = g => g.feeds.size ? {
  sources: [...g.feeds.values()].map(f => stale(f, STALE * 3)),
  items: [...g.items.values()].sort((a, b) => b.received - a.received).map(({ key, ...r }) => r),
} : null;
const pickAreas = (active, areas) => {
  if (!areas || !areas.length) return active;
  const out = {};
  for (const [k, v] of Object.entries(active)) { const m = v.filter(c => areas.includes(c)); if (m.length) out[k] = m; }
  return out;
};
const orefOut = areas => {\n  const v = stale(oref, STALE);
  if (v.state !== "ok") return { ...v, active: {} };
  return areas && areas.length ? { ...v, active: pickAreas(v.active, areas), areaFiltered: true } : v;
};
const parseAreas = q => (q || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 200);
const state = areas => ({ now: Date.now(), oref: orefOut(areas), prelim: grp(G.prelim), military: grp(G.military) });
const FILES = { "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"], "/sw.js": ["sw.js", "text/javascript"], "/icon.svg": ["icon.svg", "image/svg+xml"] };

const PUB = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const INDEX = path.join(PUB, "index.html");
const server = http.createServer((req, res) => {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (ORIGIN) { h["Access-Control-Allow-Origin"] = ORIGIN; h["Vary"] = "Origin"; }
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204, { ...h, "Access-Control-Allow-Methods": "GET" }); return res.end(); }
  if (req.method !== "GET") { res.writeHead(405, h); return res.end("{}"); }
  if (p === "/healthz") { res.writeHead(200, h); return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) })); }
  if (p === "/api/state") { res.writeHead(200, h); return res.end(JSON.stringify(state(parseAreas(u.searchParams.get("areas"))))); }
  if (FILES[p]) { const f = path.join(PUB, FILES[p][0]); if (fs.existsSync(f)) { res.writeHead(200, { ...h, "Content-Type": FILES[p][1] }); return res.end(fs.readFileSync(f)); } }
  if ((p === "/" || p === "/index.html") && fs.existsSync(INDEX)) {
    const html = fs.readFileSync(INDEX, "utf8").replace("<head>", "<head><script>window.RAL_SAME_ORIGIN=true;window.RAL_POLL_MS=" + POLL + "</script>");
    res.writeHead(200, { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Frame-Options": "DENY" }); return res.end(html);
  }
  res.writeHead(404, h); res.end("{}");
});
server.listen(PORT, "0.0.0.0", () => console.log("RedAlert proxy on :" + PORT));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
(async function loop() { await Promise.all([pollOref(), pollGroup(G.prelim), pollGroup(G.military)]); setTimeout(loop, POLL); })();
