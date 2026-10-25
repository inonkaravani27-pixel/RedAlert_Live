// RedAlert Live proxy. Node 18+. Web Push uses the web-push package. See README.md.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const webpush = require("web-push");
const E = process.env, PORT = +E.PORT || 8787, ORIGIN = E.ALLOWED_ORIGIN || "";
const PUSH_PUBLIC = E.VAPID_PUBLIC_KEY || "BLD0K2r11FqEnEhpAW22STYS6CZkswp6hYf6hyCf8NSh2iHcfOvqg4h36dMMahcRon3O12GUaXkDwPAKW67BDrc";
const PUSH_READY = Boolean(PUSH_PUBLIC && E.VAPID_PRIVATE_KEY);
if (PUSH_READY) webpush.setVapidDetails(E.VAPID_SUBJECT || "https://redalert-live.onrender.com", PUSH_PUBLIC, E.VAPID_PRIVATE_KEY);
const PUSH_STORE = path.join(__dirname, "push-subscriptions.json");
const pushSubscriptions = new Map();
try { for (const s of JSON.parse(fs.readFileSync(PUSH_STORE, "utf8"))) if (s && s.endpoint && s.keys) pushSubscriptions.set(s.endpoint, s); } catch (_) {}
function savePushSubscriptions() { try { fs.writeFileSync(PUSH_STORE, JSON.stringify([...pushSubscriptions.values()])); } catch (e) { console.error("Could not persist push subscriptions:", msg(e)); } }
function readJsonBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; if (body.length > limit) { reject(new Error("request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (_) { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
let pushNewsInitialized = false;
const knownPushArticleUrls = new Set();
const POLL = +E.POLL_MS || 5000, STALE = +E.STALE_MS || 30000, MAXAGE = +E.MAX_AGE_MS || 1800000;
const OREF_URLS = (E.OREF_URLS || "https://api.tzevaadom.co.il/notifications,https://orefproxy5.oref-map.org/api2/alerts,https://oref-map.org/api/alerts").split(",").map(s => s.trim()).filter(Boolean);
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
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; RedAlertLive/1.0)", Accept: "application/json, text/plain, */*", "Referer": "https://www.oref.org.il/", "X-Requested-With": "XMLHttpRequest" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
};
async function pollOref() {
  let lastError = "no source configured";
  for (const url of OREF_URLS) {
    try {
      const raw = (await get(url)).replace(/^\uFEFF/, "").trim();
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
      // Tzeva Adom community API may return { alerts: [...] }; Oref relays return { title, data: [...] }.
      if (typeof parsed !== "object" || !parsed) throw new Error("unexpected alert response");
      if (parsed.status === "success" && parsed.alerts_active === false) {
        Object.assign(oref, { state: "ok", last: Date.now(), error: null, active: {}, title: null, category: null, rawCount: 0 });
        return;
      }
      if (parsed.status === "success" && parsed.alerts_active === true && parsed.data) {
        const data = parsed.data;
        const cities = Array.isArray(data.locations) ? data.locations.filter(x => typeof x === "string") :
          Array.isArray(data.data) ? data.data.filter(x => typeof x === "string") : [];
        if (!cities.length) throw new Error("alert response has no locations");
        const title = String(data.title || "התרעה");
        Object.assign(oref, { state: "ok", last: Date.now(), error: null, active: { [title]: cities }, title, category: data.cat ?? null, rawCount: cities.length });
        return;
      }
      if (Array.isArray(parsed.alerts)) {
        const rows = parsed.alerts;
        const cities = [...new Set(rows.flatMap(x => {
          if (Array.isArray(x.cities)) return x.cities.filter(v => typeof v === "string");
          if (Array.isArray(x.data)) return x.data.filter(v => typeof v === "string");
          const area = x.RegionDesc || x.region || x.area || x.data;
          return typeof area === "string" && area ? [area] : [];
        }))];
        const title = rows.map(x => x.Message || x.title || x.description).find(x => typeof x === "string" && x.trim()) || "התרעה";
        const active = cities.length ? { [String(title)]: cities } : {};
        Object.assign(oref, { state: "ok", last: Date.now(), error: null, active, title: cities.length ? String(title) : null, category: rows[0]?.cat ?? rows[0]?.threat ?? null, rawCount: cities.length });
        return;
      }
      if (!parsed.title || !Array.isArray(parsed.data)) throw new Error("unexpected alert response");
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

function normalizeNewsDate(value) {
  const raw = String(value || "").trim();
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) return new Date(Date.UTC(+compact[1], +compact[2] - 1, +compact[3], +compact[4], +compact[5], +compact[6])).toISOString();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}
const PUBLIC_NEWS_GROUPS = [
  { id: "iran", label: "דיווחים על איראן — כלי תקשורת", query: '(Iran OR Iranian OR Tehran OR "Islamic Revolutionary Guard")', rssQuery: '(Iran OR Iranian OR Tehran OR "Islamic Revolutionary Guard") when:1d', verification: "דיווח תקשורתי — פתחו את הכתבה המקורית" },
  { id: "launch", label: "שיגורים, יירוטים ותקיפות — דיווחים", query: '((Iran OR Iranian OR Israel) (missile OR rocket OR drone OR strike OR attack OR interception OR launch))', rssQuery: '((Iran OR Iranian OR Israel) (missile OR rocket OR drone OR strike OR attack OR interception OR launch)) when:1d', verification: "דיווח תקשורתי — פתחו את הכתבה המקורית" },
  { id: "telegram-n12", label: "חדשות N12 בטלגרם", telegram: "n12_news", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-kan11", label: "כאן חדשות בטלגרם", telegram: "KAN11NEWS", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-newsil", label: "חדשות ישראל בטלגרם", telegram: "newsil", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-hamal", label: "חמ״ל — דיווחים בטלגרם", telegram: "hamalnews", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-abualiexpress", label: "אבו עלי אקספרס — טלגרם", telegram: "abualiexpress", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-tzevaadom", label: "צופר — צבע אדום בטלגרם", telegram: "tzevaadom", verification: "ערוץ התרעות ציבורי — אינו תחליף למקור הרשמי" }
];
async function fetchTelegramChannel(channel, limit = 15) {
  const html = await get("https://t.me/s/" + encodeURIComponent(channel));
  const blocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*"[^>]*>[\s\S]*?(?=<div class="tgme_widget_message_wrap|<div class="footer|$)/gi)].map(m => m[0]);
  const out = [];
  for (const block of blocks) {
    const post = (block.match(/data-post="([^"]+)"/i) || [])[1];
    if (!post) continue;
    const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = textMatch ? dec(textMatch[1]).replace(/\s+/g, " ").trim() : "";
    const dateRaw = (block.match(/<time[^>]*datetime="([^"]+)"/i) || [])[1] || "";
    const pub = Date.parse(dateRaw);
    if (!title || title.length < 12 || !Number.isFinite(pub) || Date.now() - pub > 24 * 60 * 60 * 1000 || pub > Date.now() + 5 * 60 * 1000) continue;
    const mediaMatch = block.match(/background-image:\s*url\(['"]?(https:\/\/[^)'"]+)/i);
    const imgMatch = block.match(/<img[^>]+src="(https:\/\/[^"]+)"/i);
    const videoMatch = /class="tgme_widget_message_video_player/.test(block);
    const mediaUrl = (mediaMatch ? mediaMatch[1] : (imgMatch ? imgMatch[1] : "")).replace(/&amp;/g, "&");
    out.push({
      title: title.slice(0, 600),
      url: "https://t.me/" + post,
      source: "t.me/" + channel,
      date: new Date(pub).toISOString(),
      mediaUrl,
      mediaType: videoMatch ? "video-preview" : (mediaUrl ? "image" : ""),
      unverified: true,
      verification: "מקור טלגרם — בדקו מול מקור נוסף"
    });
  }
  const seen = new Set();
  return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).filter(a => !seen.has(a.url) && seen.add(a.url)).slice(0, limit);
}
async function fetchPublicNewsGroup(group, limit = 15) {
  if (group.telegram) return fetchTelegramChannel(group.telegram, limit);

  let lastError = "public news source unavailable";
  const gdeltUrl = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(group.query) +
    "&mode=ArtList&format=json&sort=datedesc&maxrecords=" + Math.max(limit, 20) + "&timespan=24h";
  try {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(gdeltUrl, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; RedAlertLive/1.0)", "Accept": "application/json" } });
      const body = await response.text();
      if (!response.ok) throw new Error("GDELT HTTP " + response.status);
      const data = JSON.parse(body);
      const articles = (data.articles || []).map(a => ({
        title: String(a.title || "").trim(), url: String(a.url || ""),
        source: String(a.domain || "מקור חדשות"), date: normalizeNewsDate(a.seendate || "")
      })).filter(a => {
        const age = Date.parse(a.date);
        const relevant = /iran|iranian|tehran|israel|israeli|missile|rocket|drone|strike|attack|intercept|launch|war|security|טיל|שיגור|יירוט|איראן|ישראל|תקיפה|כטב.?ם|מלחמה|ביטחון/i.test(a.title);
        return a.title.length >= 12 && /^https?:\/\//i.test(a.url) && relevant &&
          (!Number.isFinite(age) || (Date.now() - age <= 24 * 60 * 60 * 1000 && age <= Date.now() + 5 * 60 * 1000));
      });
      if (articles.length) return articles.slice(0, limit);
      lastError = "GDELT returned no recent relevant articles";
    } finally { clearTimeout(timer); }
  } catch (error) { lastError = msg(error); }

  // Fallback to Google News RSS when GDELT is blocked, rate-limited, or returns no usable articles.
  const rssUrl = "https://news.google.com/rss/search?q=" + encodeURIComponent(group.rssQuery) +
    "&hl=en-US&gl=US&ceid=US:en";
  try {
    const xml = await get(rssUrl);
    const seen = new Set();
    const articles = parseFeed(xml).map(item => {
      const title = item.title || "";
      const match = title.match(/\s+-\s+([^\-]+)$/);
      return { title, url: item.link || "", source: match ? match[1].trim() : "Google News",
        date: Number.isFinite(item.pub) ? new Date(item.pub).toISOString() : "" };
    }).filter(a => {
      const age = Date.parse(a.date);
      const relevant = /iran|iranian|tehran|israel|israeli|missile|rocket|drone|strike|attack|intercept|launch|war|security|טיל|שיגור|יירוט|איראן|ישראל|תקיפה|כטב.?ם|מלחמה|ביטחון/i.test(a.title);
      if (!a.title || a.title.length < 12 || !/^https?:\/\//i.test(a.url) || seen.has(a.url) || !relevant ||
          (Number.isFinite(age) && (Date.now() - age > 24 * 60 * 60 * 1000 || age > Date.now() + 5 * 60 * 1000))) return false;
      seen.add(a.url); return true;
    });
    if (articles.length) return articles.slice(0, limit);
    throw new Error("Google News RSS returned no articles");
  } catch (error) {
    throw new Error("GDELT/Google News unavailable (" + lastError + "; " + msg(error) + ")");
  }
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
        // Keep recent entries from the configured newsroom feeds. Many video/live-blog headlines do not contain the configured keywords, so strict keyword matching hid valid updates.
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
const orefOut = areas => {
  const v = stale(oref, STALE);
  if (v.state !== "ok") return { ...v, active: {} };
  return areas && areas.length ? { ...v, active: pickAreas(v.active, areas), areaFiltered: true } : v;
};
const parseAreas = q => (q || "").split("|").map(s => s.trim()).filter(Boolean).slice(0, 200);
const translationCache = new Map();
async function translateToHebrew(text) {
  const input = String(text || "").trim().slice(0, 1200);
  if (!input) return "";
  if (translationCache.has(input)) return translationCache.get(input);
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=he&dt=t&q=" + encodeURIComponent(input);
  const response = await get(url);
  const parsed = JSON.parse(response);
  const translated = Array.isArray(parsed?.[0]) ? parsed[0].map(part => part?.[0] || "").join("") : "";
  if (!translated) throw new Error("translation unavailable");
  translationCache.set(input, translated);
  if (translationCache.size > 500) translationCache.delete(translationCache.keys().next().value);
  return translated;
}
const state = areas => ({ now: Date.now(), oref: orefOut(areas), prelim: grp(G.prelim), military: grp(G.military) });
const FILES = { "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"], "/sw.js": ["sw.js", "text/javascript"], "/icon.svg": ["icon.svg", "image/svg+xml"] };

const PUB = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const INDEX = path.join(PUB, "index.html");
const server = http.createServer((req, res) => {
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (ORIGIN) { h["Access-Control-Allow-Origin"] = ORIGIN; h["Vary"] = "Origin"; }
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (req.method === "OPTIONS") { res.writeHead(204, { ...h, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }
  if (p === "/api/push/public-key" && req.method === "GET") {
    res.writeHead(200, h);
    return res.end(JSON.stringify({ enabled: PUSH_READY, publicKey: PUSH_PUBLIC, subscribers: pushSubscriptions.size }));
  }
  if (p === "/api/push/subscribe" && req.method === "POST") {
    if (!PUSH_READY) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "push server keys are not configured" })); }
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); } }
      catch (_) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    }
    readJsonBody(req).then(subscription => {
      if (!subscription || typeof subscription.endpoint !== "string" || !subscription.endpoint.startsWith("https://") ||
          !subscription.keys || typeof subscription.keys.p256dh !== "string" || typeof subscription.keys.auth !== "string") {
        res.writeHead(400, h); return res.end(JSON.stringify({ error: "invalid push subscription" }));
      }
      pushSubscriptions.set(subscription.endpoint, subscription);
      savePushSubscriptions();
      res.writeHead(201, h); res.end(JSON.stringify({ ok: true }));
    }).catch(error => {
      if (!res.headersSent) { res.writeHead(400, h); res.end(JSON.stringify({ error: msg(error) })); }
    });
    return;
  }
  if (req.method !== "GET") { res.writeHead(405, h); return res.end("{}"); }
  if (p === "/healthz") { res.writeHead(200, h); return res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) })); }
  if (p === "/api/state") { res.writeHead(200, h); return res.end(JSON.stringify(state(parseAreas(u.searchParams.get("areas"))))); }
  if (p === "/api/prelim") {
    const query = encodeURIComponent('(Iran OR Israel OR missile OR rocket OR launch OR interception OR "Home Front Command" OR IDF)');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    fetch("https://api.gdeltproject.org/api/v2/doc/doc?query="+query+"&mode=ArtList&format=json&sort=datedesc&maxrecords=40&timespan=24h", {signal:controller.signal})
      .then(async r => {
        const body = await r.text();
        if (!r.ok) throw new Error("GDELT HTTP "+r.status);
        let data;
        try { data = JSON.parse(body); } catch { throw new Error("GDELT returned non-JSON response"); }
        return data;
      })
      .then(data => {
        const seen = new Set();
        const items = (data.articles || []).map(a => ({id:a.url || a.title, title:a.title || "", link:a.url || "", sources:[a.domain || "מקור לא ידוע"], published:Date.parse(a.seendate || "") || null, description:""}))
          .filter(a => { if (!a.title || !(a.link.startsWith("https://") || a.link.startsWith("http://")) || seen.has(a.link)) return false; seen.add(a.link); return true; }).slice(0,20);
        clearTimeout(timer);
        if (!res.headersSent) { res.writeHead(200, h); res.end(JSON.stringify({items, fetchedAt:new Date().toISOString(), source:"GDELT"})); }
      }).catch(() => {
        clearTimeout(timer);
        if (!res.headersSent) { res.writeHead(502, h); res.end(JSON.stringify({error:"news source unavailable"})); }
      });
    return;
  }
  if (p === "/api/iran-indicators") {
    // Public news reports only. No launcher tracking or launch-time prediction.
    Promise.all(PUBLIC_NEWS_GROUPS.map(async group => {
      try { return { id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור", articles: await fetchPublicNewsGroup(group, 15) }; }
      catch (error) {
        console.error("Public news group failed (" + group.id + "):", msg(error));
        return { id: group.id, label: group.label, articles: [], unavailable: true };
      }
    })).then(results => {
      if (res.headersSent) return;
      const failures = results.filter(g => g.unavailable).length;
      res.writeHead(failures === results.length ? 502 : 200, h);
      res.end(JSON.stringify({
        source: "GDELT / Google News RSS / public Telegram channel previews",
        fetchedAt: new Date().toISOString(),
        partial: failures > 0,
        error: failures === results.length ? "public news feed unavailable" : undefined,
        note: "Public media and Telegram posts only. Telegram posts are unverified; no launcher tracking or launch-time prediction.",
        groups: results
      }));
    }).catch(error => {
      console.error("Public news route failed:", msg(error));
      if (!res.headersSent) { res.writeHead(502, h); res.end(JSON.stringify({ error: "public news feed unavailable" })); }
    });
    return;
  }
  if (p === "/api/osint") {
    const query = encodeURIComponent('(Iran OR Israel OR missile OR rocket OR drone OR interception)') ;
    fetch("https://api.gdeltproject.org/api/v2/doc/doc?query="+query+"&mode=ArtList&format=json&maxrecords=25&sort=DateDesc")
      .then(r => { if (!r.ok) throw new Error("GDELT unavailable"); return r.json(); })
      .then(data => {
        const articles = (data.articles || []).map(a => ({title:a.title || "", url:a.url || "", source:a.domain || "", date:a.seendate || ""})).filter(a => a.title && a.url);
        if (!res.headersSent) { res.writeHead(200, h); res.end(JSON.stringify({source:"GDELT DOC API", fetchedAt:new Date().toISOString(), articles})); }
      })
      .catch(() => { if (!res.headersSent) { res.writeHead(502, h); res.end(JSON.stringify({error:"OSINT feed unavailable"})); } });
    return;
  }
  if (p === "/api/translate") {
    const text = u.searchParams.get("text") || "";
    if (!text.trim() || text.length > 1200) { res.writeHead(400, h); return res.end(JSON.stringify({ error: "text must be 1-1200 characters" })); }
    translateToHebrew(text).then(translated => {
      if (!res.headersSent) { res.writeHead(200, h); res.end(JSON.stringify({ translated, language: "he" })); }
    }).catch(() => {
      if (!res.headersSent) { res.writeHead(502, h); res.end(JSON.stringify({ error: "translation unavailable" })); }
    });
    return;
  }
  if (FILES[p]) { const f = path.join(PUB, FILES[p][0]); if (fs.existsSync(f)) { res.writeHead(200, { ...h, "Content-Type": FILES[p][1] }); return res.end(fs.readFileSync(f)); } }
  if ((p === "/" || p === "/index.html") && fs.existsSync(INDEX)) {
    const html = fs.readFileSync(INDEX, "utf8").replace("<head>", "<head><script>window.RAL_SAME_ORIGIN=true;window.RAL_POLL_MS=" + POLL + "</script>");
    res.writeHead(200, { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' https:; frame-src 'self' https://iwm.diskin.net https://t.me https://*.t.me; img-src 'self' data: blob: https:; font-src 'self' data: https://unpkg.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Frame-Options": "DENY" }); return res.end(html);
  }
  res.writeHead(404, h); res.end("{}");
});
async function pollPushNews() {
  if (!PUSH_READY || pushSubscriptions.size === 0) return;
  try {
    const results = await Promise.all(PUBLIC_NEWS_GROUPS.map(async group => {
      try { return await fetchPublicNewsGroup(group, 15); }
      catch (error) { console.error("Push news source failed (" + group.id + "):", msg(error)); return []; }
    }));
    const articles = [...new Map(results.flat().map(a => [a.url, a])).values()];
    if (!articles.length) return;
    if (!pushNewsInitialized) {
      for (const article of articles) knownPushArticleUrls.add(article.url);
      pushNewsInitialized = true;
      return;
    }
    const fresh = articles.filter(article => !knownPushArticleUrls.has(article.url));
    for (const article of articles) knownPushArticleUrls.add(article.url);
    if (!fresh.length) return;
    for (const article of fresh.slice(0, 5)) {
      const payload = JSON.stringify({
        title: "RedAlert Live — דיווח חדש",
        body: (article.title + (article.source ? " · " + article.source : "")).slice(0, 180),
        url: article.url,
        tag: "ral-" + crypto.createHash("sha1").update(article.url).digest("hex").slice(0, 20)
      });
      await Promise.allSettled([...pushSubscriptions.entries()].map(async ([endpoint, subscription]) => {
        try { await webpush.sendNotification(subscription, payload, { TTL: 300, urgency: "normal" }); }
        catch (error) {
          const status = error && (error.statusCode || error.status);
          if (status === 404 || status === 410) { pushSubscriptions.delete(endpoint); savePushSubscriptions(); }
          else console.error("Push delivery failed:", status || msg(error));
        }
      }));
    }
    if (knownPushArticleUrls.size > 500) {
      const keep = articles.map(article => article.url);
      knownPushArticleUrls.clear(); keep.forEach(url => knownPushArticleUrls.add(url));
    }
  } catch (error) { console.error("Push news poll failed:", msg(error)); }
}
server.listen(PORT, "0.0.0.0", () => {
  console.log("RedAlert proxy on :" + PORT + (PUSH_READY ? " (web push ready)" : " (web push needs VAPID_PRIVATE_KEY)"));
  setTimeout(pollPushNews, 15000);
  setInterval(pollPushNews, 60000);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
(async function loop() { await Promise.all([pollOref(), pollGroup(G.prelim), pollGroup(G.military)]); setTimeout(loop, POLL); })();
