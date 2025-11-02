// scanner.js — Robust NHS scan (API + HTML fallback), safe with v1.8 baseline

const NHS_BASE = process.env.NHS_BASE || "https://api.nhs.uk/service-search";
const NHS_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_KEY = process.env.NHS_API_KEY || "";
const NHS_COOKIES =
  process.env.NHS_COOKIES ||
  "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; OptanonAlertBoxClosed=2025-01-01T00:00:00.000Z";
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";
const SCAN_SNAPSHOT = process.env.SCAN_SNAPSHOT === "1";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}
async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const t = await res.text();
  let j = {};
  try { j = JSON.parse(t); } catch { j = { _raw: t }; }
  if (!res.ok) throw new Error(`http_${res.status}`);
  return j;
}

function dedupeCards(cards) {
  const seen = new Set();
  return cards.filter(c => {
    const k = (c.link || "") + "|" + (c.name || "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parseCardsFromAnyJSON(obj) {
  const pools = [obj?.results, obj?.value, obj?.items, obj?.organisations, Array.isArray(obj) ? obj : null].filter(Boolean);
  const out = [];
  for (const pool of pools) {
    for (const it of pool) {
      const name = it?.name || it?.organisationName || it?.practiceName || it?.title;
      let link = it?.url || it?.href || it?.websiteUrl || it?.path || it?.relativeUrl;
      if (link && !/^https?:\/\//i.test(link)) link = "https://www.nhs.uk" + link;
      if (name && link) out.push({ name: String(name).trim(), link });
    }
  }
  return dedupeCards(out);
}

function parsePracticeCardsHTML(html) {
  const patterns = [
    /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      const name = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      const link = href.startsWith("http") ? href : "https://www.nhs.uk" + href;
      out.push({ name, link });
    }
    if (out.length) break;
  }
  return dedupeCards(out);
}

async function geocode(pc) {
  try {
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc.replace(/\s+/g, ""))}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { lat: j?.result?.latitude ?? null, lon: j?.result?.longitude ?? null };
  } catch { return {}; }
}

async function getPracticeCardsForPostcode(pc, diag) {
  const { lat, lon } = await geocode(pc);
  const headers = NHS_KEY ? { "subscription-key": NHS_KEY, Accept: "application/json" } : {};

  // (A) NHS API: organisations near point
  if (NHS_KEY && lat && lon) {
    const qs = new URLSearchParams({
      "api-version": NHS_VERSION,
      latitude: String(lat),
      longitude: String(lon),
      serviceType: "dentist",
      top: String(process.env.NHS_API_TOP || 50),
      skip: "0",
      distance: String(process.env.NHS_API_DISTANCE_KM || 50),
    });
    const urlA = `${NHS_BASE}/organisations?${qs.toString()}`;
    try {
      const jsonA = await fetchJSON(urlA, headers);
      if (diag) diag.calls.push({ url: urlA, keys: Object.keys(jsonA || {}) });
      const cards = parseCardsFromAnyJSON(jsonA);
      if (cards.length) return { source: "api", url: urlA, cards };
    } catch (e) {
      if (diag) diag.errors.push({ step: "A", msg: String(e?.message || e) });
    }
  }

  // (B) NHS HTML fallback
  const urlH = `https://www.nhs.uk/service-search/find-a-dentist/results/${encodeURIComponent(pc)}?distance=30`;
  try {
    const html = await fetchText(urlH, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html",
      "Cookie": NHS_COOKIES,
      "Referer": "https://www.nhs.uk/",
    });
    const cards = parsePracticeCardsHTML(html);
    return { source: "html", url: urlH, cards, html: SCAN_SNAPSHOT ? html.slice(0, 1500) : undefined };
  } catch (e) {
    if (diag) diag.errors.push({ step: "HTML", msg: String(e?.message || e) });
    return { source: "html", url: urlH, cards: [] };
  }
}

export async function runScan() {
  const watches = await mongoose.connection.collection("watches").find({}).toArray();

  let checked = 0, found = 0, alertsSent = 0;
  const diag = { calls: [], errors: [] };
  const pcs = [...new Set(watches.flatMap(w => {
    const raw = Array.isArray(w.postcode) ? w.postcode : String(w.postcode || "").split(/[,;]+/);
    return raw.map(x => x.trim()).filter(Boolean);
  }))];

  for (const pc of pcs) {
    const r = await getPracticeCardsForPostcode(pc, SCAN_DEBUG ? diag : null);
    checked++;
    if (r.cards?.length) found += r.cards.length;
    await delay(800);
  }

  const result = { ok: true, checked, found, alertsSent };
  if (SCAN_DEBUG) result.meta = { apiDiag: diag, flags: { usedApi: !!NHS_KEY } };
  return result;
}
