// RedAlert Live proxy. Node 18+. Web Push uses the web-push package. See README.md.
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const webpush = require("web-push");
const E = process.env, PORT = +E.PORT || 8787, ORIGIN = E.ALLOWED_ORIGIN || "";
const PUSH_PUBLIC = E.VAPID_PUBLIC_KEY || "BLD0K2r11FqEnEhpAW22STYS6CZkswp6hYf6hyCf8NSh2iHcfOvqg4h36dMMahcRon3O12GUaXkDwPAKW67BDrc";
const PUSH_READY = Boolean(PUSH_PUBLIC && E.VAPID_PRIVATE_KEY);
if (PUSH_READY) webpush.setVapidDetails(E.VAPID_SUBJECT || "https://redalert-live.onrender.com", PUSH_PUBLIC, E.VAPID_PRIVATE_KEY);
const PUSH_STORE = path.join(__dirname, "push-subscriptions.json");
const pushSubscriptions = new Map();
try { for (const s of JSON.parse(fs.readFileSync(PUSH_STORE, "utf8"))) if (s && isAllowedPushEndpoint(s.endpoint) && s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string") pushSubscriptions.set(s.endpoint, s); } catch (_) {}
function savePushSubscriptions() { try { fs.writeFileSync(PUSH_STORE, JSON.stringify([...pushSubscriptions.values()])); } catch (e) { console.error("Could not persist push subscriptions:", msg(e)); } }
function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    const allowedHosts = new Set([
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com"
    ]);
    return url.protocol === "https:" && allowedHosts.has(url.hostname.toLowerCase()) &&
      !url.username && !url.password && !url.port && !url.hash;
  } catch (_) { return false; }
}
function readJsonBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; if (body.length > limit) { reject(new Error("request body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (_) { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}
const requestWindows = new Map();
function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    const chain = forwarded.split(",").map(value => value.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1].slice(0, 80);
  }
  return String(req.socket && req.socket.remoteAddress || "unknown").slice(0, 80);
}
function applyRateLimit(req, res, route, limit, windowMs, headers) {
  const now = Date.now();
  const key = clientAddress(req) + ":" + route;
  let bucket = requestWindows.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    requestWindows.set(key, bucket);
  }
  bucket.count++;
  if (requestWindows.size > 10000) {
    for (const [entryKey, entry] of requestWindows) {
      if (now - entry.startedAt > 30 * 60 * 1000) requestWindows.delete(entryKey);
      if (requestWindows.size <= 8000) break;
    }
  }
  if (bucket.count <= limit) return true;
  const retryAfter = Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000));
  res.writeHead(429, { ...headers, "Retry-After": String(retryAfter) });
  res.end(JSON.stringify({ error: "too many requests", retryAfter }));
  return false;
}
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Native clients may not send Origin.
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" &&
      parsed.host.toLowerCase() === String(req.headers.host || "").toLowerCase();
  } catch (_) { return false; }
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

const get = async (url, extraHeaders = {}, timeoutMs = 8000) => {
  const c = new AbortController(), t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36", Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest", ...extraHeaders } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
};
async function pollOrefSource() {
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
let orefPushBaseline = null;
let orefPushLastKey = "";
async function pollOref() {
  await pollOrefSource();
  // Never treat an unavailable source as an all-clear or trigger a push from stale data.
  if (oref.state !== "ok") return;
  const current = [...new Set(Object.entries(oref.active || {}).flatMap(([type, cities]) =>
    (Array.isArray(cities) ? cities : []).filter(city => typeof city === "string").map(city => type + "::" + city)
  ))].sort();
  if (orefPushBaseline === null) {
    orefPushBaseline = current;
    orefPushLastKey = current.join("|");
    return;
  }
  const newlyActive = current.filter(item => !orefPushBaseline.includes(item));
  orefPushBaseline = current;
  const key = newlyActive.join("|");
  if (!key || key === orefPushLastKey || !PUSH_READY || pushSubscriptions.size === 0) {
    orefPushLastKey = current.join("|");
    return;
  }
  orefPushLastKey = current.join("|");
  const newCities = [...new Set(newlyActive.map(item => item.split("::").slice(1).join("::")))];
  const payload = JSON.stringify({
    title: "RedAlert Live — התרעה מדווחת",
    body: ("סוג: " + [...new Set(newlyActive.map(item => item.split("::")[0]))].join(", ") + ". יישובים: " + newCities.slice(0, 6).join(", ") + (newCities.length > 6 ? " ועוד" : "") + ". בדקו מיד את יישומון פיקוד העורף.").slice(0, 180),
    url: "/",
    tag: "ral-oref-" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 20)
  });
  await Promise.allSettled([...pushSubscriptions.entries()].filter(([, subscription]) => !subscription.notificationPrefs || subscription.notificationPrefs.red !== false).map(async ([endpoint, subscription]) => {
    try { const alertPayload = { ...JSON.parse(payload), silent: subscription.notificationPrefs && subscription.notificationPrefs.alertMode === "vibrate-only" }; await webpush.sendNotification(subscription, JSON.stringify(alertPayload), { TTL: 60, urgency: "high" }); }
    catch (error) {
      const status = error && (error.statusCode || error.status);
      if (status === 404 || status === 410) { pushSubscriptions.delete(endpoint); savePushSubscriptions(); }
      else console.error("Oref push delivery failed:", status || msg(error));
    }
  }));
}
const dec = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (b, n) => { const m = b.match(new RegExp("<" + n + "[^>]*>([\\s\\S]*?)</" + n + ">", "i")); return m ? dec(m[1]) : ""; };
function parseFeed(x) {
  const out = [];
  for (const m of x.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const b = m[0]; let link = tag(b, "link");
    if (!link) { const h = b.match(/<link[^>]*href="([^"]+)"/i); link = h ? h[1] : ""; }
    const mediaMatch = b.match(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*url=["']([^"']+)["']/i) || b.match(/<img\b[^>]*src=["']([^"']+)["']/i);
    const mediaUrl = ((mediaMatch && mediaMatch[1]) || "").replace(/&amp;/g, "&");
    out.push({ title: tag(b, "title"), desc: tag(b, "description") || tag(b, "summary"), link, pub: Date.parse(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated")), mediaUrl: /^https:\/\//i.test(mediaUrl) ? mediaUrl : "", mediaType: mediaUrl ? "image" : "" });
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
  { id: "iran", label: "דיווחים על איראן — כלי תקשורת", query: '(Iran OR Iranian OR Tehran OR "Islamic Revolutionary Guard" OR איראן OR טהרן)', rssQuery: '(Iran OR Iranian OR Tehran OR "Islamic Revolutionary Guard" OR איראן OR טהרן) when:6h', verification: "דיווח תקשורתי — פתחו את הכתבה המקורית" },
  { id: "launch", label: "דיווחים פומביים על שיגורים מאיראן", query: '(Iran OR Iranian OR Tehran OR IRGC OR איראן OR איראני OR טהרן) (missile launch OR missiles launched OR ballistic missile OR fired toward Israel OR launches from Iran OR rocket attack OR שיגור טילים OR שיגור מאיראן OR טילים מאיראן OR שיגרו טילים OR ירי מאיראן)', rssQuery: '(Iran OR Iranian OR Tehran OR IRGC OR "missile launch" OR "missiles launched" OR "ballistic missile" OR "fired toward Israel" OR "launches from Iran" OR שיגור טילים OR שיגור מאיראן OR טילים מאיראן) when:6h', verification: "דיווח ציבורי — לא התרעה רשמית; יש לפתוח את המקור ולהצליב" },
  { id: "osint-hormuz", label: "OSINT — איראן, משגרים והורמוז", query: '(Iran OR Iranian OR IRGC OR Iran\'s) ("missile launcher" OR "launcher movement" OR "anti-ship missile" OR "Strait of Hormuz" OR Hormuz OR Sirik OR tanker OR vessel OR "launch site")', rssQuery: '(Iran OR Iranian OR IRGC OR "missile launcher" OR "launcher movement" OR "anti-ship missile" OR "Strait of Hormuz" OR Hormuz OR Sirik OR tanker OR vessel) when:6h', verification: "OSINT/חדשות פתוחות — דיווח ראשוני בלבד; הצליבו מול מקור עצמאי" },
  { id: "telegram-osint-amk", label: "OSINT — AMK Mapping", telegram: "AMK_Mapping", verification: "OSINT בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "telegram-osint-geopwatch", label: "OSINT — Geopolitics Watch", telegram: "GeoPWatch", verification: "OSINT בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "telegram-osint-rnintel", label: "OSINT — Rerum Novarum Intel", telegram: "rnintel", verification: "אגרגטור OSINT — יש להצליב; עלול לכלול פרשנות" },
  { id: "media-n12", label: "N12 / mako", query: 'domain:mako.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:mako.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-kan", label: "כאן חדשות", query: 'domain:kan.org.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:kan.org.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-13", label: "חדשות 13", query: 'domain:13tv.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:13tv.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-14", label: "עכשיו 14", query: 'domain:now14.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:now14.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-ynet", label: "ynet", query: 'domain:ynet.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:ynet.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-walla", label: "וואלה חדשות", query: 'domain:walla.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:walla.co.il (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "media-i24", label: "i24NEWS", query: 'domain:i24news.tv (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה)', rssQuery: 'site:i24news.tv (Iran OR Israel OR missile OR rocket OR drone OR strike OR attack OR איראן OR ישראל OR טיל OR שיגור OR יירוט OR תקיפה) when:6h' },
  { id: "telegram-n12", label: "חדשות N12 בטלגרם", telegram: "n12_news", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-kan11", label: "כאן חדשות בטלגרם", telegram: "KAN11NEWS", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-newsil", label: "חדשות ישראל בטלגרם", telegram: "newsil", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-hamal", label: "חמ״ל — דיווחים בטלגרם", telegram: "hamalnews", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-abualiexpress", label: "אבו עלי אקספרס — טלגרם", telegram: "abualiexpress", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-aharon-yediot", label: "אהרון ידיעות", telegram: "aharonyediotnews", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-pkpoi", label: "חדשות הבזק ללא צנזורה", telegram: "pkpoi", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-mnnews7", label: "MNnews7 — דיווחים בטלגרם", telegram: "MNnews7", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-shadow-unit-il", label: "Shadow Unit IL", telegram: "shadowUnitIL", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-salehdesk1", label: "Saleh Desk", telegram: "salehdesk1", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-tzevaadom", label: "צופר — צבע אדום בטלגרם", telegram: "tzevaadom", verification: "ערוץ התרעות ציבורי — אינו תחליף למקור הרשמי" },
  { id: "telegram-yediot", label: "ידיעות / חדשות מהשטח בטלגרם", telegram: "yediotnews25", verification: "טלגרם — בדקו מול מקור חדשות נוסף" },
  { id: "telegram-ram", label: "מבזקי רעם בטלגרם", telegram: "ramreports", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-301", label: "301 העולם הערבי בטלגרם", telegram: "arabworld301news", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-firstreports", label: "חדשות ישראל בזמן אמת בטלגרם", telegram: "firstreportsnews", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-n12-official", label: "N12 — ערוץ החדשות", telegram: "N12_news_Israel", verification: "ערוץ חדשות — בדקו את הכתבה המקורית" },
  { id: "telegram-ynet", label: "ynet חדשות", telegram: "ynetalerts", verification: "ערוץ חדשות — בדקו את הכתבה המקורית" },
  { id: "telegram-idf", label: "צה״ל — ערוץ רשמי", telegram: "idf_telegram", verification: "ערוץ רשמי — הודעות צה״ל; אינו תחליף להנחיות פיקוד העורף" },
  { id: "telegram-israelhayom", label: "ישראל היום", telegram: "israelhayomofficial", verification: "ערוץ חדשות — בדקו את הכתבה המקורית" },
  { id: "telegram-israeluncensored", label: "חדשות ישראל ללא צנזורה", telegram: "IsraelNewsonTelegramm", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-iran", label: "חדשות איראן", telegram: "hadshotiran", verification: "טלגרם — דיווחים לא מאומתים עד לאישור נוסף" },
  { id: "telegram-n12-reporters", label: "N12 — צ׳אט הכתבים", telegram: "N12chat", verification: "ערוץ/צ׳אט חדשות — יש להצליב דיווחים" },
  { id: "telegram-newssil", label: "חדשות ישראל IL", telegram: "newssil", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-news-il-h", label: "חדשות ישראל ללא צנזורה", telegram: "News_il_h", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-divuhim", label: "דיווחים חמים מהשטח", telegram: "divuhim1234", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-newsarmy", label: "צבא החדשות", telegram: "NewsArmy", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-israelnews", label: "חדשות ישראל", telegram: "israel_news_telegram", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-israeltoday", label: "ישראל היום — טלגרם", telegram: "israeltoday", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-divuchimbizmanemet", label: "דיווחים בזמן אמת", telegram: "divuchimbizmanemet", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-idfofficial", label: "צה״ל — הערוץ הרשמי באנגלית", telegram: "idfofficial", verification: "ערוץ רשמי — הודעות צה״ל" },
  { id: "telegram-pikudhaoref", label: "פיקוד העורף — ערוץ טלגרם", telegram: "PikudHaOref_all", verification: "ערוץ רשמי — יש לפעול לפי הנחיות פיקוד העורף" },
  { id: "telegram-tzenora", label: "חדשות ללא צנזורה", telegram: "tzenora", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-raknet", label: "רק נטו חדשות", telegram: "raknetoooooo", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-ntd-hebrew", label: "NTD עברית", telegram: "NTD_Hebrew", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-hotnews", label: "החדשות החמות", telegram: "hotnews1", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-kolisrael", label: "קול ישראל — דיווחי ביטחון", telegram: "kolisrael", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-amirbohbot", label: "אמיר בוחבוט — ביטחון", telegram: "amirbohbot", verification: "טלגרם — יש להצליב דיווחים" },
  { id: "telegram-divuchim-online", label: "דיווחים אונליין", telegram: "divuchim_online", verification: "טלגרם — דיווחים לא מאומתים" },
  { id: "telegram-mivzak-afel", label: "מבזק אפל", telegram: "yyyttehdbsj", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-lelotsenzura", label: "חדשות ביטחון מהשטח ללא צנזורה", telegram: "lelotsenzura", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-newsisrael-live", label: "חדשות ישראל מהשטח | ללא צנזורה", telegram: "newsisrael_live", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-firstnewsil", label: "First News IL", telegram: "Firstnewsil", verification: "טלגרם — יש לוודא את זהות הערוץ ולהצליב דיווחים" },
  { id: "telegram-realtimesecurity", label: "חדשות בזמן אמת", telegram: "Realtimesecurity1", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-hazfon", label: "חדשות לפני כולם", telegram: "hazfon1", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-baznews", label: "רגע חדשות — צבא וביטחון", telegram: "baznews9", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-israel-yamin", label: "ישראל ימין — חדשות", telegram: "israel_yamin", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "arabic-genvnews", label: "GenVNews", telegram: "GenVNews", category: "arabic", verification: "ערוץ ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-turkeynewskian", label: "Turkey News Kian · פרסית", telegram: "turkeynewskian", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-live-geopolitics", label: "Live Geopolitics", telegram: "Live_Geopolitics", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-defence-elite", label: "Defence Elite", telegram: "defence_elite", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-wars-news", label: "Wars News", telegram: "WARS_NEWS", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-radarnews98", label: "Radar News", telegram: "RadarNews98", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-voiceofbushehr", label: "Voice of Bushehr", telegram: "VoiceOfBushehr", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-tahavolatejahani", label: "Tahavolate Jahani", telegram: "tahavolatejahani", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-fighter-radar", label: "Fighter Radar", telegram: "fighter_radar", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-warmonitors", label: "War Monitors", telegram: "warmonitors", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-almayadeen", label: "Al Mayadeen", telegram: "almayadeen", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-iraninarabic", label: "Iran in Arabic", telegram: "IraninArabic", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-tasnimnews", label: "Tasnim News", telegram: "Tasnimnews", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-iranintltv", label: "Iran International", telegram: "IranintlTV", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-middle-east-spectator", label: "Middle East Spectator", telegram: "Middle_East_Spectator", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-thecradlemedia", label: "The Cradle", telegram: "thecradlemedia", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-almasiranet", label: "Al Masirah", telegram: "AlmasiraNet", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-alarabytelevision", label: "Al Araby Television", telegram: "AlarabyTelevision", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-rasedal3ado138e", label: "Rased Al Ado", telegram: "rasedal3ado138e", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-iran-military-capabilities", label: "Iran Military Capabilities", telegram: "iran_military_capabilities", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-sepah-news1", label: "Sepah News", telegram: "sepah_news1", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-sepah-pasdaran", label: "Sepah Pasdaran", telegram: "sepah_pasdaran", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-nezami-news-ir", label: "Nezami News", telegram: "NEZAMI_NEWS_IR", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-wattanagency", label: "Wattan Agency", telegram: "WattanAgency", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-almasirah2", label: "Al Masirah 2", telegram: "Almasirah2", category: "arabic", verification: "ערוץ ציבורי בערבית/פרסית — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-khoy-uolduz", label: "khoy_uolduz", telegram: "khoy_uolduz", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-geopoliticsshit", label: "GeopoliticsShit", telegram: "GeopoliticsShit", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-jangnews0011", label: "Jangnews0011", telegram: "Jangnews0011", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-enghelab-st", label: "enghelab_st", telegram: "enghelab_st", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-mahdaviatakhbar", label: "mahdaviatakhbar", telegram: "mahdaviatakhbar", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-atn-news11", label: "ATN_NEWS11", telegram: "ATN_NEWS11", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-charik-media", label: "charik_media", telegram: "charik_media", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-general-persiian", label: "General_persiian", telegram: "General_persiian", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-iranroyyal", label: "IRANROYYAL", telegram: "IRANROYYAL", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-akhbare-tazeh", label: "Akhbare_tazeh", telegram: "Akhbare_tazeh", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-zeus-khabarrr", label: "zeus_khabarrr", telegram: "zeus_khabarrr", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-the-slaughter710", label: "the_slaughter710", telegram: "the_slaughter710", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-llivenews", label: "llivenews", telegram: "llivenews", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-bbc-news-irr", label: "BBC_NEWS_irr", telegram: "BBC_NEWS_irr", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-hoshdar-313", label: "hoshdar_313", telegram: "hoshdar_313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-tajhizat-nezami313", label: "tajhizat_nezami313", telegram: "tajhizat_nezami313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-final-battle313", label: "final_battle313", telegram: "final_battle313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gordanesam313", label: "gordanesam313", telegram: "gordanesam313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-a7rartullkarm", label: "a7rartullkarm", telegram: "a7rartullkarm", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-berandaz", label: "berandaz", telegram: "berandaz", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-meysamnews7", label: "MeysamNews7", telegram: "MeysamNews7", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-reactor-news", label: "reactor_news", telegram: "reactor_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-bardegi57", label: "bardegi57", telegram: "bardegi57", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-m-mahdibaba", label: "M_Mahdibaba", telegram: "M_Mahdibaba", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-news-domain", label: "News_domain", telegram: "News_domain", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-jsn-ir", label: "jsn_ir", telegram: "jsn_ir", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-mahdaviatsiasi", label: "mahdaviatsiasi", telegram: "mahdaviatsiasi", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-m0-hm", label: "M0_HM", telegram: "M0_HM", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-tweetmardomi", label: "Tweetmardomi", telegram: "Tweetmardomi", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-evin-khabar", label: "Evin_khabar", telegram: "Evin_khabar", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-pm-afshaa", label: "pm_afshaa", telegram: "pm_afshaa", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-vahidonline", label: "VahidOnline", telegram: "VahidOnline", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-khabrfuori", label: "khabrfuori", telegram: "khabrfuori", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-aba5p", label: "ABA5p", telegram: "ABA5p", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-parazitpatriot", label: "parazitpatriot", telegram: "parazitpatriot", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-poorya-news", label: "poorya_news", telegram: "poorya_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-omidefardayma", label: "omidefardayma", telegram: "omidefardayma", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-newsfori", label: "newsfori", telegram: "newsfori", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-takhte-khabar", label: "takhte_khabar", telegram: "takhte_khabar", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-war-neews", label: "war_neews", telegram: "war_neews", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gazanewsnow", label: "GazaNewsNow", telegram: "GazaNewsNow", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-mehwaralmokawma", label: "mehwaralmokawma", telegram: "mehwaralmokawma", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-ne-wg", label: "NE_WG", telegram: "NE_WG", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-km-ap", label: "km_ap", telegram: "km_ap", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-world-newsly", label: "World_Newsly", telegram: "World_Newsly", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-nasserkaveh44", label: "nasserkaveh44", telegram: "nasserkaveh44", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-naya-foriraq", label: "naya_foriraq", telegram: "naya_foriraq", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-warlife3", label: "Warlife3", telegram: "Warlife3", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-khabari", label: "khabari", telegram: "khabari", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-hamin-alan-news", label: "Hamin_alan_news", telegram: "Hamin_alan_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-yavaran-mahdi-12", label: "YAVARAN_MAHDI_12", telegram: "YAVARAN_MAHDI_12", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-newsbitaraf", label: "newsbitaraf", telegram: "newsbitaraf", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-palestinenowgazaa", label: "PalestineNowGazaa", telegram: "PalestineNowGazaa", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-standwithgazza10", label: "standwithgazza10", telegram: "standwithgazza10", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-iribnews", label: "iribnews", telegram: "iribnews", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-bintjbeilnews", label: "bintjbeilnews", telegram: "bintjbeilnews", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-war-news", label: "WAR_news", telegram: "WAR_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alomhoar", label: "Alomhoar", telegram: "Alomhoar", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alibk3", label: "Alibk3", telegram: "Alibk3", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alfaqaar313", label: "Alfaqaar313", telegram: "Alfaqaar313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-te-h6", label: "te_h6", telegram: "te_h6", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-fateheinn-news", label: "fateheinn_news", telegram: "fateheinn_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-kh-zb", label: "kh_zb", telegram: "kh_zb", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-nw-za", label: "NW_ZA", telegram: "NW_ZA", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-sh-zu", label: "Sh_zu", telegram: "Sh_zu", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-razmavaran-org", label: "RazmAvaran_org", telegram: "RazmAvaran_org", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-nuseirat1", label: "Nuseirat1", telegram: "Nuseirat1", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-es-f3", label: "Es_F3", telegram: "Es_F3", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-tahavolatemantaghe", label: "Tahavolatemantaghe", telegram: "Tahavolatemantaghe", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-fo-rk", label: "FO_RK", telegram: "FO_RK", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-akhbaralfa1313", label: "akhbaralfa1313", telegram: "akhbaralfa1313", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-mehwargun", label: "mehwargun", telegram: "mehwargun", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-nayaforiraq", label: "nayaforiraq", telegram: "nayaforiraq", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-libanon-news", label: "libanon_news", telegram: "libanon_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-hezbulla", label: "hezbulla", telegram: "hezbulla", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alresalahpress", label: "alresalahpress", telegram: "alresalahpress", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-hpress", label: "hpress", telegram: "hpress", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-yemen-link", label: "yemen_link", telegram: "yemen_link", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-mojahedin-iran", label: "mojahedin_iran", telegram: "mojahedin_iran", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-akhbarfouri", label: "akhbarfouri", telegram: "akhbarfouri", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-sepahcybery", label: "sepahcybery", telegram: "sepahcybery", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-jeninnews2", label: "jeninnews2", telegram: "jeninnews2", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-electrohizbullah", label: "Electrohizbullah", telegram: "Electrohizbullah", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-c-military1", label: "C_Military1", telegram: "C_Military1", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-me7war313mokawama", label: "me7war313mokawama", telegram: "me7war313mokawama", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gazanewsnow5", label: "GazaNewsNow5", telegram: "GazaNewsNow5", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-aaabahd", label: "aaabahd", telegram: "aaabahd", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gazanewsnow2021", label: "gazanewsnow2021", telegram: "gazanewsnow2021", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gaza-live3", label: "Gaza_live3", telegram: "Gaza_live3", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-newsyemn", label: "newsyemn", telegram: "newsyemn", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-n-ffg", label: "N_FFG", telegram: "N_FFG", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-jenin-gher", label: "jenin_gher", telegram: "jenin_gher", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-ansarollah1", label: "ansarollah1", telegram: "ansarollah1", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-qudsn", label: "QudsN", telegram: "QudsN", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gazanowinhebrew", label: "gazanowinhebrew", telegram: "gazanowinhebrew", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alasiman", label: "AlasimaN", telegram: "AlasimaN", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-palestine911o", label: "Palestine911o", telegram: "Palestine911o", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-akkanews48", label: "AkkaNews48", telegram: "AkkaNews48", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-almuhallel1", label: "almuhallel1", telegram: "almuhallel1", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-hamza20300", label: "hamza20300", telegram: "hamza20300", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-sepah-lr", label: "Sepah_lr", telegram: "Sepah_lr", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-ahfadalbahaa", label: "ahfadalbahaa", telegram: "ahfadalbahaa", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-newsps0", label: "NewsPs0", telegram: "NewsPs0", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-sa7atplbreaking", label: "Sa7atPlBreaking", telegram: "Sa7atPlBreaking", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-fatehpress", label: "fatehpress", telegram: "fatehpress", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-kianmeli1", label: "kianmeli1", telegram: "kianmeli1", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-almustashaar", label: "Almustashaar", telegram: "Almustashaar", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-poshtpardeha", label: "poshtpardeha", telegram: "poshtpardeha", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-zohour-i12", label: "Zohour_I12", telegram: "Zohour_I12", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-akhbarebedonesansor", label: "akhbarebedonesansor", telegram: "akhbarebedonesansor", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-alonews", label: "alonews", telegram: "alonews", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-yemen0net", label: "Yemen0net", telegram: "Yemen0net", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-nezamitarin", label: "nezamitarin", telegram: "nezamitarin", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-ariammehr88", label: "ariammehr88", telegram: "ariammehr88", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-enqelab-rojhelat", label: "enqelab_Rojhelat", telegram: "enqelab_Rojhelat", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-ababil-news", label: "ababil_news", telegram: "ababil_news", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-gando-zs", label: "GANDO_ZS", telegram: "GANDO_ZS", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" },
  { id: "arabic-extra-rac-nwesir", label: "RAC_NWESIR", telegram: "RAC_NWESIR", category: "arabic", verification: "מקור ציבורי בטלגרם — דיווח לא מאומת עד להצלבה" }
];
const PUBLIC_ARABIC_CHANNELS = PUBLIC_NEWS_GROUPS.filter(group => group.category === "arabic");
const PUBLIC_STANDARD_NEWS_GROUPS = PUBLIC_NEWS_GROUPS.filter(group => group.category !== "arabic");

async function fetchTelegramChannelUncached(channel, limit = 15) {
  // Prefer an RSS bridge: Telegram's HTML preview is currently returning markup
  // the in-process scraper cannot parse from the hosted Render instance.
  // Keep to listed public instances; mirrors are tried only after earlier instances fail.
  const rssHosts = [
    "https://rsshub.app",
    "https://rsshub.rssforever.com",
    "https://hub.slarker.me",
    "https://redalert-rsshub.onrender.com",
    "https://rsshub.pseudoyu.com",
    "https://rsshub.rss.tips",
    "https://rsshub.ktachibana.party",
    "https://rsshub.cups.moe",
    "https://rss.owo.nz",
    "https://rss.wudifeixue.com"
  ];
  let rssError = "";
  // Try three independent public bridges in parallel instead of waiting up to 8s
  // for each of nine mirrors in sequence. Move to the next batch only if all fail.
  for (let offset = 0; offset < rssHosts.length; offset += 3) {
    const batch = await Promise.allSettled(rssHosts.slice(offset, offset + 3).map(async host => {
      const xml = await get(host + "/telegram/channel/" + encodeURIComponent(channel), {
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Referer": host + "/"
      }, 5000);
      if (!/<(?:rss|feed|channel)\b/i.test(xml) || /<title>\s*(?:Error|Not Found|Internal Server Error)/i.test(xml.slice(0, 2000))) {
        throw new Error("RSS bridge did not return a feed");
      }
      const now = Date.now();
      const items = parseFeed(xml).map(item => {
        const pub = Number.isFinite(item.pub) ? item.pub : Date.parse(item.pub || "");
        const link = String(item.link || "");
        const titleText = cleanTranslationText(item.title || "");
        const description = cleanTranslationText(item.desc || "");
        const title = (titleText.length >= 8 ? titleText : description || titleText).replace(/\s+/g, " ").trim();
        return { title: title.slice(0, 1000), description: description.slice(0, 1000), url: link, source: "t.me/" + channel,
          date: Number.isFinite(pub) ? new Date(pub).toISOString() : "",
          mediaUrl: item.mediaUrl || "", mediaType: item.mediaType || "",
          unverified: true, verification: "מקור טלגרם — דיווח לא מאומת עד להצלבה מול מקור נוסף" };
      }).filter(item => {
        const pub = Date.parse(item.date);
        return item.title.length >= 3 && /^https?:\/\//i.test(item.url) &&
          Number.isFinite(pub) && pub <= now + 5 * 60 * 1000 && now - pub <= 6 * 60 * 60 * 1000;
      });
      const seen = new Set();
      const parsed = items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .filter(item => !seen.has(item.url) && seen.add(item.url)).slice(0, limit);
      if (!parsed.length) throw new Error("RSS bridge returned no posts from the last 6 hours");
      return parsed;
    }));
    const success = batch.find(result => result.status === "fulfilled");
    if (success) return success.value;
    rssError = batch.map(result => result.status === "rejected" ? msg(result.reason) : "").filter(Boolean).join("; ");
  }

  // Fallback to Telegram's public HTML preview if RSS bridge instances are unavailable.
  const urls = ["https://t.me/s/" + encodeURIComponent(channel), "https://telegram.me/s/" + encodeURIComponent(channel)];
  let html = "", lastError = "";
  for (const url of urls) {
    try {
      const candidate = await get(url, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": "https://t.me/"
      }, 5000);
      html = candidate;
      if (/tgme_widget_message_wrap|tgme_widget_message_text|data-post=["'][^"']+\//i.test(candidate)) break;
      lastError = "public preview markup not found";
    } catch (error) { lastError = msg(error); }
  }
  if (!html) throw new Error("Telegram/RSS preview unavailable (" + rssError + "; " + lastError + ")");
  const starts = [...html.matchAll(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_wrap\b[^"']*["'][^>]*>/gi)];
  const blocks = starts.map((match, index) => html.slice(match.index, starts[index + 1]?.index ?? html.length));
  if (!starts.length) throw new Error("Telegram/RSS preview markup unavailable (" + rssError + ")");
  const out = [];
  for (const block of blocks) {
    const post = (block.match(/data-post=["']([^"']+)["']/i) || [])[1];
    if (!post) continue;
    const textMatch = block.match(/<div\b[^>]*class=["'][^"']*\btgme_widget_message_text\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    let title = textMatch ? dec(textMatch[1].replace(/<br\s*\/?\s*>/gi, " ").replace(/<\/p>/gi, " ")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    const dateRaw = (block.match(/<time\b[^>]*datetime=["']([^"']+)["']/i) || [])[1] || "";
    const pub = Date.parse(dateRaw);
    if (!Number.isFinite(pub) || Date.now() - pub > 6 * 60 * 60 * 1000 || pub > Date.now() + 5 * 60 * 1000) continue;
    const photoBg = block.match(/class=["'][^"']*tgme_widget_message_photo_wrap[^"']*["'][^>]*style=["'][^"']*background-image:\s*url\(["']?(https:\/\/[^)'"]+)/i)
      || block.match(/background-image:\s*url\(["']?(https:\/\/[^)'"]+)/i);
    const photoTag = [...block.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]).find(tag => /tgme_widget_message_photo/i.test(tag));
    const imgSrc = photoTag ? (photoTag.match(/(?:src|srcset)=["']([^"' ,]+)["']/i) || [])[1] : "";
    const videoMatch = /tgme_widget_message_video_player|tgme_widget_message_video|<video\b|tgme_widget_message_roundvideo/i.test(block);
    const mediaUrl = (photoBg ? photoBg[1] : (imgSrc || "")).replace(/&amp;/g, "&");
    const hasPhoto = Boolean(mediaUrl);
    if (!title && !videoMatch && !hasPhoto) continue;
    if (!title) title = videoMatch ? "תיעוד וידאו מצורף לפוסט" : "תמונה מצורפת לפוסט";
    if (title.length < 6 && !videoMatch && !hasPhoto) continue;
    out.push({ title: title.slice(0, 600), url: "https://t.me/" + post, source: "t.me/" + channel,
      date: new Date(pub).toISOString(), mediaUrl, mediaType: videoMatch ? "video-preview" : (hasPhoto ? "image" : ""),
      unverified: true, verification: "מקור טלגרם — דיווח לא מאומת עד להצלבה מול מקור נוסף" });
  }
  const seen = new Set();
  const parsed = out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).filter(a => !seen.has(a.url) && seen.add(a.url)).slice(0, limit);
  if (!parsed.length) throw new Error("No recent Telegram posts could be parsed (RSS bridge: " + rssError + ")");
  return parsed;
}

// Avoid hammering shared public RSS bridges every 20 seconds when they are rate-limiting
// or temporarily unavailable. Successful feeds are briefly cached; failures back off.
const telegramFetchCache = new Map();
const telegramFetchInFlight = new Map();
async function fetchTelegramChannel(channel, limit = 15) {
  const key = String(channel).toLowerCase() + ":" + limit;
  const cached = telegramFetchCache.get(key);
  const now = Date.now();
  if (cached && now < cached.until) {
    if (cached.error) throw new Error(cached.error);
    return cached.items;
  }
  if (telegramFetchInFlight.has(key)) return telegramFetchInFlight.get(key);
  const request = (async () => {
    try {
      const items = await fetchTelegramChannelUncached(channel, limit);
      telegramFetchCache.set(key, { items, until: Date.now() + 45_000 });
      return items;
    } catch (error) {
      const message = msg(error);
      telegramFetchCache.set(key, { error: message, until: Date.now() + 30_000 });
      throw error;
    } finally {
      telegramFetchInFlight.delete(key);
    }
  })();
  telegramFetchInFlight.set(key, request);
  return request;
}

async function fetchPublicNewsGroupUncached(group, limit = 15) {
  if (group.telegram) return fetchTelegramChannel(group.telegram, limit);

  let lastError = "public news source unavailable";
  const gdeltUrl = "https://api.gdeltproject.org/api/v2/doc/doc?query=" + encodeURIComponent(group.query) +
    "&mode=ArtList&format=json&sort=datedesc&maxrecords=" + Math.max(limit, 20) + "&timespan=6h";
  try {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(gdeltUrl, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; RedAlertLive/1.0)", "Accept": "application/json" } });
      const body = await response.text();
      if (!response.ok) throw new Error("GDELT HTTP " + response.status);
      const data = JSON.parse(body);
      const articles = (data.articles || []).map(a => ({
        title: String(a.title || "").trim(), url: String(a.url || ""),
        source: String(a.domain || "מקור חדשות"), date: normalizeNewsDate(a.seendate || ""),
        mediaUrl: /^https:\/\//i.test(String(a.socialimage || "")) ? String(a.socialimage) : "", mediaType: a.socialimage ? "image" : ""
      })).filter(a => {
        const age = Date.parse(a.date);
        const relevant = /iran|iranian|tehran|israel|israeli|missile|rocket|drone|strike|attack|intercept|launch|war|security|טיל|שיגור|יירוט|איראן|ישראל|תקיפה|כטב.?ם|מלחמה|ביטחון/i.test(a.title);
        return a.title.length >= 12 && /^https?:\/\//i.test(a.url) && relevant &&
          (Number.isFinite(age) && Date.now() - age <= 6 * 60 * 60 * 1000 && age <= Date.now() + 5 * 60 * 1000);
      });
      if (articles.length) return articles.slice(0, limit);
      lastError = "GDELT returned no recent relevant articles";
    } finally { clearTimeout(timer); }
  } catch (error) { lastError = msg(error); }

  // Fallback to Google News RSS when GDELT is blocked, rate-limited, or returns no usable articles.
  const rssUrl = "https://news.google.com/rss/search?q=" + encodeURIComponent(group.rssQuery) +
    "&hl=he&gl=IL&ceid=IL:he";
  try {
    const xml = await get(rssUrl, { "Accept": "application/rss+xml, application/xml, text/xml, */*" }, 7000);
    const seen = new Set();
    const articles = parseFeed(xml).map(item => {
      const title = item.title || "";
      const match = title.match(/\s+-\s+([^-]+)$/);
      return { title, url: item.link || "", source: match ? match[1].trim() : "Google News",
        date: Number.isFinite(item.pub) ? new Date(item.pub).toISOString() : "", mediaUrl: item.mediaUrl || "", mediaType: item.mediaType || "" };
    }).filter(a => {
      const age = Date.parse(a.date);
      const relevant = /iran|iranian|tehran|israel|israeli|missile|rocket|drone|strike|attack|intercept|launch|war|security|טיל|שיגור|יירוט|איראן|ישראל|תקיפה|כטב.?ם|מלחמה|ביטחון/i.test(a.title);
      if (!a.title || a.title.length < 12 || !/^https?:\/\//i.test(a.url) || seen.has(a.url) || !relevant ||
          (!Number.isFinite(age) || Date.now() - age > 6 * 60 * 60 * 1000 || age > Date.now() + 5 * 60 * 1000)) return false;
      seen.add(a.url); return true;
    });
    if (articles.length) return articles.slice(0, limit);
    throw new Error("Google News RSS returned no articles");
  } catch (error) {
    const googleError = msg(error);
    // Additional public RSS fallback for the two Iran news groups. Bing's RSS
    // search feed is not a versioned API, so it is used only after GDELT and Google News.
    if (group.id === "launch" || group.id === "iran") {
      try {
        const query = group.id === "launch"
          ? '"Iran missile launch" OR "missiles launched from Iran" OR "Iran ballistic missile" OR "Iran missile platform"'
          : 'Iran Israel Tehran IRGC missile rocket drone strike attack';
        const bingUrl = "https://www.bing.com/news/search?q=" + encodeURIComponent(query) + "&format=RSS&setmkt=en-US";
        const xml = await get(bingUrl, { "Accept": "application/rss+xml, application/xml, text/xml, */*" }, 9000);
        const articles = parseFeed(xml).map(item => {
          let url = String(item.link || "");
          try {
            const parsedUrl = new URL(url);
            if (parsedUrl.hostname.endsWith("bing.com") && parsedUrl.pathname.includes("apiclick.aspx")) {
              url = new URLSearchParams(parsedUrl.search).get("url") || url;
            }
          } catch (_) {}
          const title = String(item.title || "").trim();
          const match = title.match(/\\s+-\\s+([^\\-]+)$/);
          return {
            title, url, source: match ? match[1].trim() : "Bing News",
            date: Number.isFinite(item.pub) ? new Date(item.pub).toISOString() : "",
            mediaUrl: item.mediaUrl || "", mediaType: item.mediaType || ""
          };
        }).filter(article => {
          const age = Date.parse(article.date);
          const hasIran = /iran|iranian|tehran|irgc/i.test(article.title);
          const relevant = group.id === "launch"
            ? /missile|rocket|launch|fired|ballistic|strike|attack|platform/i.test(article.title)
            : /missile|rocket|drone|strike|attack|military|security/i.test(article.title);
          return article.title.length >= 12 && /^https?:\/\//i.test(article.url) && hasIran && relevant &&
            Number.isFinite(age) && Date.now() - age <= 6 * 60 * 60 * 1000 && age <= Date.now() + 5 * 60 * 1000;
        });
        if (articles.length) return articles.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
        throw new Error("Bing News RSS returned no recent relevant articles");
      } catch (bingError) {
        // Last-resort publisher feeds: BBC Middle East, Al Jazeera English and
        // The Guardian World. Keep only recent Iran-related headlines matching
        // this group's topic; never turn broad world headlines into Iran alerts.
        const publisherFeeds = [
          { name: "BBC News — Middle East", url: "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
          { name: "Al Jazeera English", url: "https://www.aljazeera.com/xml/rss/all.xml" },
          { name: "The Guardian — World", url: "https://www.theguardian.com/world/rss" }
        ];
        const feedResults = await Promise.allSettled(publisherFeeds.map(async feed => {
          const xml = await get(feed.url, { "Accept": "application/rss+xml, application/xml, text/xml, */*" }, 9000);
          return parseFeed(xml).map(item => ({
            title: String(item.title || "").trim(),
            url: String(item.link || "").trim(),
            source: feed.name,
            date: Number.isFinite(item.pub) ? new Date(item.pub).toISOString() : "",
            mediaUrl: item.mediaUrl || "",
            mediaType: item.mediaType || ""
          }));
        }));
        const articles = feedResults.flatMap(result => result.status === "fulfilled" ? result.value : [])
          .filter(article => {
            const age = Date.parse(article.date);
            const title = article.title;
            const hasIran = /iran|iranian|tehran|irgc|islamic republic/i.test(title);
            const relevant = group.id === "launch"
              ? /missile|rocket|launch|fired|ballistic|strike|attack|drone|qeshm|hormuz/i.test(title)
              : /missile|rocket|drone|strike|attack|military|security|nuclear|sanction/i.test(title);
            return title.length >= 12 && (article.url.startsWith("https://") || article.url.startsWith("http://")) &&
              hasIran && relevant && Number.isFinite(age) &&
              Date.now() - age <= 6 * 60 * 60 * 1000 && age <= Date.now() + 5 * 60 * 1000;
          });
        if (articles.length) return articles.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, limit);
        throw new Error("GDELT/Google/Bing/publisher RSS unavailable (" + lastError + "; " + googleError + "; " + msg(bingError) + ")");
      }
    }
    throw new Error("GDELT/Google News unavailable (" + lastError + "; " + googleError + ")");
  }
}


// Cache per source as well, so unavailable media providers are not retried every 20 seconds.
const publicNewsGroupCache = new Map();
const publicNewsGroupInFlight = new Map();
async function fetchPublicNewsGroup(group, limit = 15) {
  const key = group.id + ":" + limit;
  const cached = publicNewsGroupCache.get(key);
  if (cached && Date.now() < cached.until) {
    if (cached.error) throw new Error(cached.error);
    return cached.articles;
  }
  if (publicNewsGroupInFlight.has(key)) return publicNewsGroupInFlight.get(key);
  const request = (async () => {
    try {
      const articles = await fetchPublicNewsGroupUncached(group, limit);
      publicNewsGroupCache.set(key, { articles, until: Date.now() + 45_000 });
      return articles;
    } catch (error) {
      const message = msg(error);
      publicNewsGroupCache.set(key, { error: message, until: Date.now() + 30_000 });
      throw error;
    } finally {
      publicNewsGroupInFlight.delete(key);
    }
  })();
  publicNewsGroupInFlight.set(key, request);
  return request;
}

let publicNewsCache = null;
let publicNewsRefreshPromise = null;
let publicNewsLastRefresh = 0;
const PUBLIC_NEWS_REFRESH_MS = 30000;
const PUBLIC_NEWS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
function filterFreshPublicArticles(articles) {
  const now = Date.now();
  return (articles || []).filter(article => {
    const published = Date.parse(article.date || "");
    return Number.isFinite(published) && published <= now + 5 * 60 * 1000 && now - published <= PUBLIC_NEWS_MAX_AGE_MS;
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
async function refreshPublicNewsCache() {
  if (publicNewsRefreshPromise) return publicNewsRefreshPromise;
  const previous = publicNewsCache;
  const previousGroups = new Map((previous && previous.groups || []).map(g => [g.id, g]));
  const results = PUBLIC_STANDARD_NEWS_GROUPS.map(group => {
    const old = previousGroups.get(group.id);
    return old ? { ...old, articles: filterFreshPublicArticles(old.articles || []), refreshing: true } :
      { id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור", articles: [], unavailable: false, refreshing: true };
  });
  // Publish a cache immediately and update it as each source finishes. The browser no longer
  // waits for every Telegram/news source before receiving the first response.
  publicNewsCache = {
    source: "GDELT / Google News RSS / public Telegram channel previews",
    fetchedAt: previous && previous.fetchedAt || null,
    partial: true, refreshing: true,
    note: "Public media, OSINT reports and public Telegram previews. Posts are unverified until corroborated; no physical/satellite launcher tracking or launch-time prediction.",
    groups: results
  };
  publicNewsRefreshPromise = (async () => {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < PUBLIC_STANDARD_NEWS_GROUPS.length) {
        const index = nextIndex++;
        const group = PUBLIC_STANDARD_NEWS_GROUPS[index];
        try {
          const articles = filterFreshPublicArticles(await fetchPublicNewsGroup(group, 20));
          results[index] = { id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור", articles, unavailable: false, refreshing: false };
        } catch (error) {
          console.error("Public news group failed (" + group.id + "):", msg(error));
          const old = previousGroups.get(group.id);
          results[index] = {
            id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור",
            articles: filterFreshPublicArticles(old && old.articles || []), unavailable: true, error: msg(error), refreshing: false
          };
        }
        publicNewsCache = {
          source: "GDELT / Google News RSS / public Telegram channel previews",
          fetchedAt: new Date().toISOString(),
          partial: results.some(g => g.unavailable || g.refreshing),
          refreshing: true,
          note: "Public media, OSINT reports and public Telegram previews. Posts are unverified until corroborated; no physical/satellite launcher tracking or launch-time prediction.",
          groups: [...results]
        };
      }
    };
    // Limit concurrency to reduce Telegram throttling and publish useful results progressively.
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    publicNewsCache = {
      source: "GDELT / Google News RSS / public Telegram channel previews",
      fetchedAt: new Date().toISOString(),
      partial: results.some(g => g.unavailable),
      refreshing: false,
      note: "Public media, OSINT reports and public Telegram previews. Posts are unverified until corroborated; no physical/satellite launcher tracking or launch-time prediction.",
      groups: [...results]
    };
    publicNewsLastRefresh = Date.now();
    return publicNewsCache;
  })().finally(() => { publicNewsRefreshPromise = null; });
  return publicNewsRefreshPromise;
}
function ensurePublicNewsRefresh() {
  if (!publicNewsRefreshPromise && Date.now() - publicNewsLastRefresh >= PUBLIC_NEWS_REFRESH_MS) {
    return refreshPublicNewsCache().catch(error => { console.error("Public news refresh failed:", msg(error)); return publicNewsCache; });
  }
  return publicNewsRefreshPromise || Promise.resolve(publicNewsCache);
}
let arabicNewsCache = null;
let arabicNewsRefreshPromise = null;
let arabicNewsLastRefresh = 0;
const ARABIC_NEWS_REFRESH_MS = 45000;

function isExceptionalArabicReport(article) {
  const text = [article.title, article.description, article.summary].filter(Boolean).join(" ");
  const highSignal = /(?:missile\s+(?:launch|strike|barrage)|ballistic missile|mass(?:ive)?\s+(?:drone|missile)\s+(?:attack|launch|strike|swarm)|drone swarm|multiple reconnaissance drones|airspace (?:closed|closure)|emergency mobilization|major explosion|large-scale attack|IRGC.{0,45}(?:missile|drone|alert|mobiliz|deploy)|إطلاق صواريخ|هجوم صاروخي|هجوم واسع|ضربة واسعة|طائرات? مسيرة|مسيّرات استطلاع|إغلاق المجال الجوي|إغلاق الأجواء|انفجار كبير|تعبئة عامة|حالة استنفار|الحرس الثوري.{0,45}(?:صواريخ|مسيرات|استنفار|تحركات)|چندین پهپاد|پهپادهای شناسایی|شلیک موشک|پرتاب موشک|حمله موشکی|حمله گسترده|بستن حریم هوایی|آماده‌باش|انفجارهای شدید|تحرکات غیرعادی|سپاه.{0,45}(?:پهپاد|موشک|آماده‌باش|تحرکات))/i;
  return highSignal.test(text);
}
async function refreshArabicNewsCache() {
  if (arabicNewsRefreshPromise) return arabicNewsRefreshPromise;
  arabicNewsRefreshPromise = (async () => {
    const previousGroups = new Map((arabicNewsCache && arabicNewsCache.groups || []).map(group => [group.id, group]));
    const results = PUBLIC_ARABIC_CHANNELS.map(group => {
      const previous = previousGroups.get(group.id);
      return {
        id: group.id, label: group.label, verification: group.verification,
        articles: filterFreshPublicArticles(previous && previous.articles || []),
        unavailable: false, refreshing: true
      };
    });
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < PUBLIC_ARABIC_CHANNELS.length) {
        const i = nextIndex++;
        const group = PUBLIC_ARABIC_CHANNELS[i];
        try {
          const articles = filterFreshPublicArticles(await fetchTelegramChannel(group.telegram, 12))
            .filter(isExceptionalArabicReport);
          results[i] = { id: group.id, label: group.label, verification: group.verification,
            articles, unavailable: false, refreshing: false };
        } catch (error) {
          const previous = previousGroups.get(group.id);
          results[i] = { id: group.id, label: group.label, verification: group.verification,
            articles: filterFreshPublicArticles(previous && previous.articles || []),
            unavailable: true, error: msg(error), refreshing: false };
        }
        arabicNewsCache = { source: "Public Telegram channels", fetchedAt: new Date().toISOString(),
          refreshing: true, note: "רק כותרות חריגות ממקורות ציבוריים; הדיווחים אינם מאומתים עצמאית.",
          groups: [...results] };
      }
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    arabicNewsCache = { source: "Public Telegram channels", fetchedAt: new Date().toISOString(),
      refreshing: false, note: "רק כותרות חריגות ממקורות ציבוריים; הדיווחים אינם מאומתים עצמאית.",
      groups: [...results] };
    arabicNewsLastRefresh = Date.now();
    return arabicNewsCache;
  })().finally(() => { arabicNewsRefreshPromise = null; });
  return arabicNewsRefreshPromise;
}
function ensureArabicNewsRefresh() {
  if (!arabicNewsRefreshPromise && Date.now() - arabicNewsLastRefresh >= ARABIC_NEWS_REFRESH_MS) {
    return refreshArabicNewsCache().catch(error => {
      console.error("Arabic public news refresh failed:", msg(error));
      return arabicNewsCache;
    });
  }
  return arabicNewsRefreshPromise || Promise.resolve(arabicNewsCache);
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
function cleanTranslationText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => { const code = Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " "; })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const code = parseInt(n, 16); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " "; })
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}
async function translationFetch(url, timeoutMs = 7500) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RedAlertLive/1.0)",
      "Accept": "application/json,text/plain,*/*",
      "Accept-Language": "he-IL,he;q=0.9,en;q=0.8"
    } });
    if (!response.ok) throw new Error("translation HTTP " + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function translationPost(url, body, timeoutMs = 6500) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST", signal: controller.signal,
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error("translation HTTP " + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}
const translationInFlight = new Map();
const translationFailureCache = new Map();
function cacheTranslation(input, translated) {
  translationCache.set(input, translated);
  translationFailureCache.delete(input);
  if (translationCache.size > 500) translationCache.delete(translationCache.keys().next().value);
  return translated;
}
async function translateToHebrew(text) {
  const input = cleanTranslationText(text);
  if (!input) return "";
  if (translationCache.has(input)) return translationCache.get(input);
  const failedUntil = translationFailureCache.get(input) || 0;
  if (Date.now() < failedUntil) throw new Error("translation temporarily unavailable");
  if (translationInFlight.has(input)) return translationInFlight.get(input);
  const request = (async () => {
    let lastError;
    const hasPersian = /[\u067E\u0686\u0698\u06AF\u06A9\u06CC]/u.test(input);
    const source = hasPersian ? "fa" : /[\u0600-\u06FF]/u.test(input) ? "ar" : "";

    // Google Translate is the primary free route. Try its API host and web host.
    for (const host of ["https://translate.googleapis.com", "https://translate.google.com"]) {
      try {
        const url = host + "/translate_a/single?client=gtx&sl=auto&tl=he&dt=t&q=" + encodeURIComponent(input);
        const parsed = await translationFetch(url, 6500);
        const translated = Array.isArray(parsed?.[0]) ? parsed[0].map(part => part?.[0] || "").join("").trim() : "";
        if (translated) return cacheTranslation(input, translated);
        throw new Error("Google returned an empty translation");
      } catch (error) { lastError = error; }
    }

    // MyMemory direct translation, then a two-step route through English if needed.
    if (source) {
      try {
        const url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(input) + "&langpair=" + source + "%7Che";
        const data = await translationFetch(url, 6500);
        const translated = String(data?.responseData?.translatedText || "").trim();
        if (data?.responseStatus === 200 && translated && !/^PLEASE SELECT|NO QUERY SPECIFIED/i.test(translated)) {
          return cacheTranslation(input, translated);
        }
        throw new Error("MyMemory returned an empty translation");
      } catch (error) { lastError = error; }
      try {
        const first = await translationFetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(input) + "&langpair=" + source + "%7Cen", 6500);
        const english = String(first?.responseData?.translatedText || "").trim();
        if (first?.responseStatus === 200 && english) {
          const second = await translationFetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(english) + "&langpair=en%7Che", 6500);
          const translated = String(second?.responseData?.translatedText || "").trim();
          if (second?.responseStatus === 200 && translated) return cacheTranslation(input, translated);
        }
        throw new Error("MyMemory English pivot returned an empty translation");
      } catch (error) { lastError = error; }
    }

    // LibreTranslate mirrors: try direct translation, then explicitly pivot via English.
    const libreSource = source || "auto";
    for (const base of ["https://translate.argosopentech.com", "https://translate.terraprint.co"]) {
      try {
        const direct = await translationPost(base + "/translate", {
          q: input, source: libreSource, target: "he", format: "text"
        }, 5000);
        const translated = String(direct?.translatedText || "").trim();
        if (translated) return cacheTranslation(input, translated);
        throw new Error("LibreTranslate returned an empty direct translation");
      } catch (error) { lastError = error; }
      try {
        const first = await translationPost(base + "/translate", {
          q: input, source: libreSource, target: "en", format: "text"
        }, 5000);
        const english = String(first?.translatedText || "").trim();
        if (!english) throw new Error("LibreTranslate English pivot returned empty text");
        const second = await translationPost(base + "/translate", {
          q: english, source: "en", target: "he", format: "text"
        }, 5000);
        const translated = String(second?.translatedText || "").trim();
        if (translated) return cacheTranslation(input, translated);
        throw new Error("LibreTranslate Hebrew pivot returned empty text");
      } catch (error) { lastError = error; }
    }

    translationFailureCache.set(input, Date.now() + 20000);
    if (translationFailureCache.size > 500) translationFailureCache.delete(translationFailureCache.keys().next().value);
    console.warn("[translation] all free providers failed:", msg(lastError || "unknown error"));
    throw lastError || new Error("translation unavailable");
  })();
  translationInFlight.set(input, request);
  try { return await request; }
  finally { translationInFlight.delete(input); }
}
const state = areas => ({ now: Date.now(), oref: orefOut(areas), prelim: grp(G.prelim), military: grp(G.military) });

const ACCESS_REQUIRED = E.ACCESS_REQUIRED === "true";
const SUPABASE_URL = String(E.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = E.SUPABASE_SECRET_KEY || "";
const ACCESS_ADMIN_PASSWORD = E.ACCESS_ADMIN_PASSWORD || "";
const ACCESS_PASSWORD = E.ACCESS_PASSWORD || "";
const RESEND_API_KEY = E.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL = E.RESEND_FROM_EMAIL || "onboarding@resend.dev";
const ACCESS_NOTIFY_EMAIL = "inonkaravani27@gmail.com";
const accessSessionCache = new Map();
const adminSessions = new Map();

function accessConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY && ACCESS_ADMIN_PASSWORD);
}
function passwordAccessConfigured() { return Boolean(ACCESS_PASSWORD); }
function createAccessSession(deviceId) {
  const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const nonce = crypto.randomBytes(24).toString("base64url");
  const payload = expiresAt + "." + nonce + "." + deviceId;
  const signature = crypto.createHmac("sha256", ACCESS_PASSWORD).update(payload).digest("base64url");
  return payload + "." + signature;
}
function verifyAccessSession(token) {
  if (!passwordAccessConfigured() || typeof token !== "string" || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [expiryText, nonce, deviceId, signature] = parts;
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 366 * 24 * 60 * 60 * 1000 ||
      !/^[A-Za-z0-9_-]{20,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{20,64}$/.test(deviceId)) return null;
  const payload = expiryText + "." + nonce + "." + deviceId;
  const expected = crypto.createHmac("sha256", ACCESS_PASSWORD).update(payload).digest("base64url");
  return constantTimeEqual(signature, expected) ? { deviceId, expiresAt } : null;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieHeader(name, value, maxAge, sameSite = "Lax", cookiePath = "/") {
  return name + "=" + encodeURIComponent(value) + "; Path=" + cookiePath +
    (Number.isFinite(maxAge) ? "; Max-Age=" + maxAge : "") + "; HttpOnly; Secure; SameSite=" + sameSite;
}
function clearCookieHeader(name, cookiePath = "/") {
  return name + "=; Path=" + cookiePath + "; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}
function accessHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
async function supabaseAccess(pathname, options = {}) {
  if (!accessConfigured()) throw new Error("access service is not configured");
  const response = await fetch(SUPABASE_URL + "/rest/v1/access_requests" + pathname, {
    method: options.method || "GET",
    headers: {
      "apikey": SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      ...(options.prefer ? { "Prefer": options.prefer } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase access request failed: " + response.status);
  return body ? JSON.parse(body) : null;
}
const deviceAuthCache = new Map();
const deviceLastSeenWrites = new Map();
async function supabaseDevices(query, options = {}) {
  if (!accessConfigured()) throw new Error("access service is not configured");
  const response = await fetch(SUPABASE_URL + "/rest/v1/access_devices" + query, {
    method: options.method || "GET",
    headers: {
      "apikey": SUPABASE_SECRET_KEY,
      "Content-Type": "application/json",
      ...(options.prefer ? { "Prefer": options.prefer } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase device request failed: " + response.status);
  return body ? JSON.parse(body) : null;
}
function deviceDescription(req) {
  const ua = String(req.headers["user-agent"] || "").slice(0, 500);
  let device = "מכשיר לא מזוהה", os = "מערכת לא מזוהה", browser = "דפדפן לא מזוהה";
  if (/Android/i.test(ua)) { os = "Android"; device = (/;\s*([^;)]+)\s*Build\//i.exec(ua) || [])[1] || "מכשיר Android"; }
  else if (/iPhone|iPad|iPod/i.test(ua)) { os = "iOS"; device = /iPad/i.test(ua) ? "iPad" : "iPhone"; }
  else if (/Windows/i.test(ua)) { os = "Windows"; device = "מחשב Windows"; }
  else if (/Mac OS X/i.test(ua)) { os = "macOS"; device = "Mac"; }
  else if (/Linux/i.test(ua)) { os = "Linux"; device = "מחשב Linux"; }
  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";
  return { user_agent: ua, device_type: device.slice(0,100), os: os.slice(0,60), browser: browser.slice(0,60) };
}
async function isApprovedAccess(req) {
  if (!ACCESS_REQUIRED) return true;
  const session = verifyAccessSession(parseCookies(req).ral_access);
  if (!session) return false;
  const currentSessionHash = accessHash(parseCookies(req).ral_access);
  const cached = deviceAuthCache.get(session.deviceId);
  if (cached && cached.until > Date.now() && cached.sessionHash === currentSessionHash) return cached.allowed;
  try {
    const rows = await supabaseDevices("?device_id=eq." + encodeURIComponent(session.deviceId) + "&select=device_id,session_hash,blocked&limit=1");
    const row = Array.isArray(rows) ? rows[0] : null;
    const allowed = Boolean(row && row.blocked !== true && row.session_hash === currentSessionHash);
    deviceAuthCache.set(session.deviceId, { allowed, sessionHash: currentSessionHash, until: Date.now() + 10000 });
    if (allowed && Date.now() - (deviceLastSeenWrites.get(session.deviceId) || 0) > 5 * 60 * 1000) {
      deviceLastSeenWrites.set(session.deviceId, Date.now());
      supabaseDevices("?device_id=eq." + encodeURIComponent(session.deviceId), {
        method: "PATCH", prefer: "return=minimal",
        body: { last_seen_at: new Date().toISOString(), ip_address: clientAddress(req) }
      }).catch(() => {});
    }
    return allowed;
  } catch (_) { return false; }
}
async function sendAccessRequestNotification(fullName) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.warn("[access] Email notification skipped: RESEND_API_KEY or RESEND_FROM_EMAIL is not configured");
    return;
  }
  const safeName = String(fullName).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [ACCESS_NOTIFY_EMAIL],
      subject: "בקשת גישה חדשה ל־RedAlert Live",
      html: "<div dir=\"rtl\" style=\"font-family:Arial,sans-serif\"><h2>בקשת גישה חדשה</h2><p>המשתמש <strong>" + safeName + "</strong> ביקש גישה לאתר RedAlert Live.</p><p><a href=\"https://redalert-live.onrender.com/admin\">כניסה לעמוד הניהול לאישור או דחייה</a></p></div>",
      text: "בקשת גישה חדשה ל־RedAlert Live\nשם: " + String(fullName) + "\nלאישור או דחייה: https://redalert-live.onrender.com/admin"
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Resend email failed: " + response.status + " " + detail.slice(0, 300));
  }
  const result = await response.json().catch(() => ({}));
  console.log("[access] Email notification accepted by Resend:", result.id || "accepted");
}
async function getAccessRequestByHash(hash) {
  const query = "?access_token_hash=eq." + encodeURIComponent(hash) +
    "&select=id,status,full_name,created_at&limit=1";
  const rows = await supabaseAccess(query);
  return Array.isArray(rows) ? rows[0] || null : null;
}
function isAdminRequest(req, res) {
  const token = parseCookies(req).ral_admin;
  if (!token) return false;
  const expiresAt = adminSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  const renewedExpiry = Date.now() + 30 * 60 * 1000;
  adminSessions.set(token, renewedExpiry);
  if (res && !res.headersSent) {
    res.setHeader("Set-Cookie", cookieHeader("ral_admin", token, 30 * 60, "Strict", "/api/access/admin"));
  }
  return true;
}
function constantTimeEqual(a, b) {
  const aa = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

const FILES = { "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"], "/admin.webmanifest": ["admin.webmanifest", "application/manifest+json"], "/sw.js": ["sw.js", "text/javascript"], "/icon.svg": ["icon.svg", "image/svg+xml"], "/icon-maskable.svg": ["icon-maskable.svg", "image/svg+xml"], "/icon-192.png": ["icon-192.png", "image/png"], "/icon-512.png": ["icon-512.png", "image/png"] };

const PUB = fs.existsSync(path.join(__dirname, "public", "index.html")) ? path.join(__dirname, "public") : __dirname;
const INDEX = path.join(PUB, "index.html");
const server = http.createServer(async (req, res) => {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  };
  if (req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted) {
    h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  if (ORIGIN) { h["Access-Control-Allow-Origin"] = ORIGIN; h["Vary"] = "Origin"; }
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (p.startsWith("/api/") && req.method !== "OPTIONS" &&
      !applyRateLimit(req, res, "api", 300, 60 * 1000, h)) return;
  if ((p === "/api/prelim" || p === "/api/osint") && req.method === "GET" &&
      !applyRateLimit(req, res, "external-news", 20, 60 * 1000, h)) return;
  if (req.method === "OPTIONS") { res.writeHead(204, { ...h, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); return res.end(); }

  if (p === "/api/access/status" && req.method === "GET") {
    if (!ACCESS_REQUIRED) { res.writeHead(200, h); return res.end(JSON.stringify({ enabled: false })); }
    if (!passwordAccessConfigured()) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "ACCESS_PASSWORD is not configured" })); }
    const approved = await isApprovedAccess(req);
    res.writeHead(200, h);
    return res.end(JSON.stringify({ enabled: true, status: approved ? "approved" : "none" }));
  }
  if (p === "/api/access/login" && req.method === "POST") {
    if (!sameOriginRequest(req) || !req.headers.origin) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!ACCESS_REQUIRED || !passwordAccessConfigured()) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "סיסמת הגישה עדיין לא הוגדרה בשרת." })); }
    if (!applyRateLimit(req, res, "access-password-login", 5, 15 * 60 * 1000, h)) return;
    try {
      const data = await readJsonBody(req, 4096);
      if (!constantTimeEqual(data.password || "", ACCESS_PASSWORD)) {
        res.writeHead(401, h); return res.end(JSON.stringify({ error: "סיסמה שגויה. נסה שוב." }));
      }
      if (!accessConfigured()) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "ניהול המכשירים עדיין לא הוגדר במסד הנתונים." })); }
      const cookies = parseCookies(req);
      const existingDeviceId = /^[A-Za-z0-9_-]{20,64}$/.test(cookies.ral_device || "") ? cookies.ral_device : "";
      if (existingDeviceId) {
        const existingRows = await supabaseDevices("?device_id=eq." + encodeURIComponent(existingDeviceId) + "&select=blocked&limit=1");
        if (Array.isArray(existingRows) && existingRows[0] && existingRows[0].blocked === true) {
          res.writeHead(403, h); return res.end(JSON.stringify({ error: "המכשיר הזה נחסם. יש לפנות למנהל האתר." }));
        }
      }
      const deviceId = existingDeviceId || crypto.randomBytes(24).toString("base64url");
      const session = createAccessSession(deviceId);
      const remember = data.remember === true;
      const cookieAge = 60 * 60 * 24 * 365;
      const details = deviceDescription(req);
      const now = new Date().toISOString();
      await supabaseDevices("?on_conflict=device_id", {
        method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
        body: { device_id: deviceId, session_hash: accessHash(session), blocked: false,
          device_type: details.device_type, os: details.os, browser: details.browser,
          user_agent: details.user_agent, ip_address: clientAddress(req),
          last_seen_at: now, updated_at: now }
      });
      deviceAuthCache.delete(deviceId);
      res.writeHead(200, { ...h, "Set-Cookie": [
        cookieHeader("ral_access", session, cookieAge),
        cookieHeader("ral_device", deviceId, 60 * 60 * 24 * 365)
      ] });
      return res.end(JSON.stringify({ ok: true, status: "approved" }));
    } catch (_) {
      res.writeHead(400, h); return res.end(JSON.stringify({ error: "לא ניתן לבדוק את הסיסמה. נסה שוב." }));
    }
  }
  if (p === "/api/access/admin/login" && req.method === "POST") {
    if (!sameOriginRequest(req) || !req.headers.origin) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!ACCESS_REQUIRED || !accessConfigured()) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "access service is not configured" })); }
    if (!applyRateLimit(req, res, "access-admin-login", 5, 15 * 60 * 1000, h)) return;
    try {
      const data = await readJsonBody(req, 4096);
      if (!constantTimeEqual(data.password || "", ACCESS_ADMIN_PASSWORD)) {
        res.writeHead(401, h); return res.end(JSON.stringify({ error: "סיסמה שגויה." }));
      }
      const token = crypto.randomBytes(32).toString("base64url");
      adminSessions.set(token, Date.now() + 30 * 60 * 1000);
      res.writeHead(200, { ...h, "Set-Cookie": cookieHeader("ral_admin", token, 30 * 60, "Strict", "/api/access/admin") });
      return res.end(JSON.stringify({ ok: true }));
    } catch (_) {
      res.writeHead(400, h); return res.end(JSON.stringify({ error: "בקשת התחברות לא תקינה." }));
    }
  }
  if (p === "/api/access/admin/status" && req.method === "GET") {
    const authenticated = isAdminRequest(req, res);
    res.writeHead(authenticated ? 200 : 401, h);
    return res.end(JSON.stringify({ authenticated }));
  }
  if (p === "/api/access/admin/logout" && req.method === "POST") {
    const token = parseCookies(req).ral_admin;
    if (token) adminSessions.delete(token);
    res.writeHead(200, { ...h, "Set-Cookie": clearCookieHeader("ral_admin", "/api/access/admin") });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === "/api/access/admin/requests" && req.method === "GET") {
    if (!isAdminRequest(req, res)) { res.writeHead(401, h); return res.end(JSON.stringify({ error: "unauthorized" })); }
    try {
      const rows = await supabaseAccess("?status=eq.pending&select=id,full_name,status,created_at&order=created_at.desc&limit=100");
      res.writeHead(200, h); return res.end(JSON.stringify({ requests: rows || [] }));
    } catch (_) {
      res.writeHead(503, h); return res.end(JSON.stringify({ error: "לא ניתן לטעון בקשות כרגע." }));
    }
  }
  if (p === "/api/access/admin/review" && req.method === "POST") {
    if (!sameOriginRequest(req) || !req.headers.origin) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!isAdminRequest(req, res)) { res.writeHead(401, h); return res.end(JSON.stringify({ error: "unauthorized" })); }
    try {
      const data = await readJsonBody(req, 4096);
      const id = String(data.id || "");
      const status = String(data.status || "");
      if (!/^[0-9a-f-]{36}$/i.test(id) || !["approved", "rejected"].includes(status)) {
        res.writeHead(400, h); return res.end(JSON.stringify({ error: "בקשה לא תקינה." }));
      }
      await supabaseAccess("?id=eq." + encodeURIComponent(id), {
        method: "PATCH",
        prefer: "return=minimal",
        body: { status, reviewed_at: new Date().toISOString() }
      });
      accessSessionCache.clear();
      res.writeHead(200, h); return res.end(JSON.stringify({ ok: true }));
    } catch (_) {
      res.writeHead(503, h); return res.end(JSON.stringify({ error: "לא ניתן לעדכן את הבקשה כרגע." }));
    }
  }

  if (p === "/api/access/admin/devices" && req.method === "GET") {
    if (!isAdminRequest(req, res)) { res.writeHead(401, h); return res.end(JSON.stringify({ error: "unauthorized" })); }
    try {
      const rows = await supabaseDevices("?select=device_id,label,device_type,os,browser,ip_address,created_at,last_seen_at,blocked&order=last_seen_at.desc&limit=200");
      res.writeHead(200, h); return res.end(JSON.stringify({ devices: rows || [] }));
    } catch (_) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "לא ניתן לטעון מכשירים. יש לוודא שהטבלה access_devices נוצרה ב-Supabase." })); }
  }
  if (p === "/api/access/admin/device" && req.method === "POST") {
    if (!sameOriginRequest(req) || !req.headers.origin) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!isAdminRequest(req, res)) { res.writeHead(401, h); return res.end(JSON.stringify({ error: "unauthorized" })); }
    try {
      const data = await readJsonBody(req, 4096);
      const id = String(data.device_id || "");
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) { res.writeHead(400, h); return res.end(JSON.stringify({ error: "מזהה מכשיר לא תקין." })); }
      if (data.action === "rename") {
        const label = String(data.label || "").trim();
        if (label.length > 60) { res.writeHead(400, h); return res.end(JSON.stringify({ error: "הכינוי ארוך מדי." })); }
        await supabaseDevices("?device_id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { label: label || null, updated_at: new Date().toISOString() } });
      } else if (data.action === "block" || data.action === "unblock") {
        await supabaseDevices("?device_id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { blocked: data.action === "block", updated_at: new Date().toISOString() } });
        deviceAuthCache.delete(id);
      } else if (data.action === "revoke") {
        await supabaseDevices("?device_id=eq." + encodeURIComponent(id), { method: "PATCH", prefer: "return=minimal", body: { session_hash: null, updated_at: new Date().toISOString() } });
        deviceAuthCache.delete(id);
      } else { res.writeHead(400, h); return res.end(JSON.stringify({ error: "פעולה לא מוכרת." })); }
      res.writeHead(200, h); return res.end(JSON.stringify({ ok: true }));
    } catch (_) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "לא ניתן לעדכן את המכשיר." })); }
  }
  if (p === "/api/push/public-key" && req.method === "GET") {
    res.writeHead(200, h);
    return res.end(JSON.stringify({ enabled: PUSH_READY, publicKey: PUSH_PUBLIC, subscribers: pushSubscriptions.size }));
  }
  if (p === "/api/push/preferences" && req.method === "POST") {
    if (!sameOriginRequest(req)) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!applyRateLimit(req, res, "push-preferences", 60, 15 * 60 * 1000, h)) return;
    readJsonBody(req).then(data => {
      if (!data || !isAllowedPushEndpoint(data.endpoint)) { res.writeHead(400, h); return res.end(JSON.stringify({ error: "invalid push endpoint" })); }
      const sub = pushSubscriptions.get(data.endpoint);
      if (!sub) { res.writeHead(404, h); return res.end(JSON.stringify({ error: "subscription not found" })); }
      sub.notificationPrefs = { red: data.red !== false, news: data.news !== false, alertMode: data.alertMode === "vibrate-only" ? "vibrate-only" : "sound-vibrate" };
      pushSubscriptions.set(data.endpoint, sub); savePushSubscriptions();
      res.writeHead(200, h); return res.end(JSON.stringify({ ok: true }));
    }).catch(error => { if (!res.headersSent) { res.writeHead(400, h); res.end(JSON.stringify({ error: msg(error) })); } });
    return;
  }
  if (p === "/api/push/subscribe" && req.method === "POST") {
    if (!PUSH_READY) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "push server keys are not configured" })); }
    if (!sameOriginRequest(req)) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "origin not allowed" })); }
    if (!applyRateLimit(req, res, "push-subscribe", 10, 15 * 60 * 1000, h)) return;
    readJsonBody(req).then(subscription => {
      if (!subscription || !isAllowedPushEndpoint(subscription.endpoint) ||
          !subscription.keys || typeof subscription.keys.p256dh !== "string" || subscription.keys.p256dh.length > 256 ||
          typeof subscription.keys.auth !== "string" || subscription.keys.auth.length > 256) {
        res.writeHead(400, h); return res.end(JSON.stringify({ error: "invalid push subscription" }));
      }
      const existing = pushSubscriptions.get(subscription.endpoint);
      subscription.notificationPrefs = subscription.notificationPrefs || (existing && existing.notificationPrefs) || { red: true, news: true };
      pushSubscriptions.set(subscription.endpoint, subscription);
      savePushSubscriptions();
      res.writeHead(201, h); res.end(JSON.stringify({ ok: true }));
    }).catch(error => {
      if (!res.headersSent) { res.writeHead(400, h); res.end(JSON.stringify({ error: msg(error) })); }
    });
    return;
  }

  if (ACCESS_REQUIRED && p.startsWith("/api/") && !p.startsWith("/api/access/")) {
    if (!accessConfigured()) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "access service is not configured" })); }
    try {
      if (!(await isApprovedAccess(req))) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "access approval required" })); }
    } catch (_) {
      res.writeHead(503, h); return res.end(JSON.stringify({ error: "access service unavailable" }));
    }
  }
  if (p === "/api/access/heartbeat" && req.method === "GET") {
    try {
      const session = verifyAccessSession(parseCookies(req).ral_access);
      if (!session) { res.writeHead(403, h); return res.end(JSON.stringify({ error: "unauthorized" })); }
      await supabaseDevices("?device_id=eq." + encodeURIComponent(session.deviceId), {
        method: "PATCH", prefer: "return=minimal",
        body: { last_seen_at: new Date().toISOString(), ip_address: clientAddress(req) }
      });
      res.writeHead(200, h); return res.end(JSON.stringify({ ok: true }));
    } catch (_) { res.writeHead(503, h); return res.end(JSON.stringify({ error: "heartbeat unavailable" })); }
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
    const sendSnapshot = () => {
      if (res.destroyed || res.writableEnded) return;
      const snapshot = publicNewsCache || {
        source: "GDELT / Google News RSS / public Telegram channel previews",
        fetchedAt: null, partial: true, refreshing: true,
        note: "Public media, OSINT reports and public Telegram previews. Posts are unverified until corroborated; no physical/satellite launcher tracking or launch-time prediction.",
        groups: PUBLIC_STANDARD_NEWS_GROUPS.map(group => ({ id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור", articles: [], refreshing: true }))
      };
      res.writeHead(200, h);
      const freshSnapshot = { ...snapshot, groups: (snapshot.groups || []).map(group => ({ ...group, articles: filterFreshPublicArticles(group.articles || []) })) };
      res.end(JSON.stringify({ ...freshSnapshot, refreshing: Boolean(publicNewsRefreshPromise), refreshIntervalMs: PUBLIC_NEWS_REFRESH_MS, maxArticleAgeMs: PUBLIC_NEWS_MAX_AGE_MS }));
    };
    // Respond immediately with whatever is cached; refresh runs in the background and
    // progressively fills this endpoint. This avoids the browser timing out while dozens of sources load.
    ensurePublicNewsRefresh();
    sendSnapshot();
    return;
  }
  if (p === "/api/arabic-channels") {
    const snapshot = arabicNewsCache || {
      source: "Public Telegram channels", fetchedAt: null, refreshing: true,
      note: "רק כותרות חריגות ממקורות ציבוריים; הדיווחים אינם מאומתים עצמאית.",
      groups: PUBLIC_ARABIC_CHANNELS.map(group => ({ id: group.id, label: group.label,
        verification: group.verification, articles: [], refreshing: true }))
    };
    ensureArabicNewsRefresh();
    res.writeHead(200, h);
    return res.end(JSON.stringify({ ...snapshot, refreshing: Boolean(arabicNewsRefreshPromise),
      refreshIntervalMs: ARABIC_NEWS_REFRESH_MS }));
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
    if (!applyRateLimit(req, res, "translate", 120, 60 * 1000, h)) return;
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

  if (p === "/admin" && req.method === "GET") {
    const adminFile = path.join(PUB, "admin.html");
    if (fs.existsSync(adminFile)) {
      res.writeHead(200, { ...h, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", "X-Frame-Options": "DENY" });
      return res.end(fs.readFileSync(adminFile));
    }
  }
  if ((p === "/" || p === "/index.html") && fs.existsSync(INDEX)) {
    const html = fs.readFileSync(INDEX, "utf8").replace("<head>", "<head><script>window.RAL_SAME_ORIGIN=true;window.RAL_POLL_MS=" + POLL + ";setTimeout(()=>fetch('/api/access/heartbeat',{cache:'no-store'}).catch(()=>{}),1500);setInterval(()=>fetch('/api/access/heartbeat',{cache:'no-store'}).catch(()=>{}),30000)</script>");
    res.writeHead(200, { ...h, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' https:; frame-src 'self' https://iwm.diskin.net https://t.me https://*.t.me; img-src 'self' data: blob: https:; font-src 'self' data: https://unpkg.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Frame-Options": "DENY" }); return res.end(html);
  }
  res.writeHead(404, h); res.end("{}");
});
async function pollPushNews() {
  if (!PUSH_READY || pushSubscriptions.size === 0) return;
  try {
    const results = await Promise.all(PUBLIC_STANDARD_NEWS_GROUPS.map(async group => {
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
      await Promise.allSettled([...pushSubscriptions.entries()].filter(([, subscription]) => !subscription.notificationPrefs || subscription.notificationPrefs.news !== false).map(async ([endpoint, subscription]) => {
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
  setTimeout(() => refreshPublicNewsCache().catch(error => console.error("Initial public news refresh failed:", msg(error))), 1000);
  setInterval(ensurePublicNewsRefresh, 5000);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
(async function loop() { await Promise.all([pollOref(), pollGroup(G.prelim), pollGroup(G.military)]); setTimeout(loop, POLL); })();
