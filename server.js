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
  await Promise.allSettled([...pushSubscriptions.entries()].map(async ([endpoint, subscription]) => {
    try { await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: "high" }); }
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
  { id: "launch", label: "שיגורים, יירוטים ותקיפות — דיווחים", query: '((Iran OR Iranian OR Israel OR איראן OR ישראל) (missile OR rocket OR drone OR strike OR attack OR interception OR launch OR טיל OR רקטה OR שיגור OR יירוט OR תקיפה))', rssQuery: '((Iran OR Iranian OR Israel OR איראן OR ישראל) (missile OR rocket OR drone OR strike OR attack OR interception OR launch OR טיל OR רקטה OR שיגור OR יירוט OR תקיפה) ) when:6h', verification: "דיווח תקשורתי — פתחו את הכתבה המקורית" },
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
  { id: "telegram-aharon-yediot", label: "אהרון ידיעות", telegram: "aharonyediotnews", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-pkpoi", label: "חדשות הבזק ללא צנזורה", telegram: "pkpoi", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-mivzak-afel", label: "מבזק אפל", telegram: "yyyttehdbsj", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-lelotsenzura", label: "חדשות ביטחון מהשטח ללא צנזורה", telegram: "lelotsenzura", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-newsisrael-live", label: "חדשות ישראל מהשטח | ללא צנזורה", telegram: "newsisrael_live", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-firstnewsil", label: "First News IL", telegram: "Firstnewsil", verification: "טלגרם — יש לוודא את זהות הערוץ ולהצליב דיווחים" },
  { id: "telegram-realtimesecurity", label: "חדשות בזמן אמת", telegram: "Realtimesecurity1", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-hazfon", label: "חדשות לפני כולם", telegram: "hazfon1", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-baznews", label: "רגע חדשות — צבא וביטחון", telegram: "baznews9", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" },
  { id: "telegram-israel-yamin", label: "ישראל ימין — חדשות", telegram: "israel_yamin", verification: "טלגרם — דיווחים לא מאומתים; יש להצליב לפני הפצה" }
];
async function fetchTelegramChannelUncached(channel, limit = 15) {
  // Prefer an RSS bridge: Telegram's HTML preview is currently returning markup
  // the in-process scraper cannot parse from the hosted Render instance.
  // Keep to listed public instances; mirrors are tried only after earlier instances fail.
  const rssHosts = [
    "https://rsshub.app",
    "https://rsshub.rssforever.com",
    "https://hub.slarker.me",
    "https://rsshub.pseudoyu.com",
    "https://rsshub.rss.tips",
    "https://rsshub.ktachibana.party",
    "https://rsshub.cups.moe",
    "https://rss.owo.nz",
    "https://rss.wudifeixue.com"
  ];
  let rssError = "";
  for (const host of rssHosts) {
    try {
      const xml = await get(host + "/telegram/channel/" + encodeURIComponent(channel), {
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Referer": host + "/"
      });
      if (!/<(?:rss|feed|channel)\b/i.test(xml) || /<title>\s*(?:Error|Not Found|Internal Server Error)/i.test(xml.slice(0, 2000))) {
        throw new Error("RSS bridge did not return a feed");
      }
      const now = Date.now();
      const items = parseFeed(xml).map(item => {
        const pub = Number.isFinite(item.pub) ? item.pub : Date.parse(item.pub || "");
        const link = String(item.link || "");
        const title = String(item.title || "").replace(/\s+/g, " ").trim();
        return { title, url: link, source: "t.me/" + channel,
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
      if (parsed.length) return parsed;
      rssError = "RSS bridge returned no posts from the last 6 hours";
    } catch (error) { rssError = msg(error); }
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
      });
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
      telegramFetchCache.set(key, { items, until: Date.now() + 60_000 });
      return items;
    } catch (error) {
      const message = msg(error);
      telegramFetchCache.set(key, { error: message, until: Date.now() + 120_000 });
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
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
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
    const xml = await get(rssUrl, { "Accept": "application/rss+xml, application/xml, text/xml, */*" }, 12000);
    const seen = new Set();
    const articles = parseFeed(xml).map(item => {
      const title = item.title || "";
      const match = title.match(/\s+-\s+([^\-]+)$/);
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
    throw new Error("GDELT/Google News unavailable (" + lastError + "; " + msg(error) + ")");
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
      publicNewsGroupCache.set(key, { articles, until: Date.now() + 60_000 });
      return articles;
    } catch (error) {
      const message = msg(error);
      publicNewsGroupCache.set(key, { error: message, until: Date.now() + 120_000 });
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
const PUBLIC_NEWS_REFRESH_MS = 20000;
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
  const results = PUBLIC_NEWS_GROUPS.map(group => {
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
    note: "Public media and Telegram posts only. Telegram posts are unverified; no launcher tracking or launch-time prediction.",
    groups: results
  };
  publicNewsRefreshPromise = (async () => {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < PUBLIC_NEWS_GROUPS.length) {
        const index = nextIndex++;
        const group = PUBLIC_NEWS_GROUPS[index];
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
          note: "Public media and Telegram posts only. Telegram posts are unverified; no launcher tracking or launch-time prediction.",
          groups: [...results]
        };
      }
    };
    // Limit concurrency to reduce Telegram throttling and publish useful results progressively.
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    publicNewsCache = {
      source: "GDELT / Google News RSS / public Telegram channel previews",
      fetchedAt: new Date().toISOString(),
      partial: results.some(g => g.unavailable),
      refreshing: false,
      note: "Public media and Telegram posts only. Telegram posts are unverified; no launcher tracking or launch-time prediction.",
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
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
  let responseText;
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; RedAlertLive/1.0)", "Accept": "application/json,text/plain,*/*", "Accept-Language": "he-IL,he;q=0.9,en;q=0.8" } });
    if (!response.ok) throw new Error("translation HTTP " + response.status);
    responseText = await response.text();
  } finally { clearTimeout(timer); }
  const parsed = JSON.parse(responseText);
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
    const sendSnapshot = () => {
      if (res.destroyed || res.writableEnded) return;
      const snapshot = publicNewsCache || {
        source: "GDELT / Google News RSS / public Telegram channel previews",
        fetchedAt: null, partial: true, refreshing: true,
        note: "Public media and Telegram posts only. Telegram posts are unverified; no launcher tracking or launch-time prediction.",
        groups: PUBLIC_NEWS_GROUPS.map(group => ({ id: group.id, label: group.label, verification: group.verification || "דיווח תקשורתי — יש לפתוח את המקור", articles: [], refreshing: true }))
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
  setTimeout(() => refreshPublicNewsCache().catch(error => console.error("Initial public news refresh failed:", msg(error))), 1000);
  setInterval(ensurePublicNewsRefresh, 5000);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
(async function loop() { await Promise.all([pollOref(), pollGroup(G.prelim), pollGroup(G.military)]); setTimeout(loop, POLL); })();
