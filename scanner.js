// scanner.js — resilient scanner: API-first, HTML fallback, no UI changes
// Works with your existing server.js (v1.8 baseline) and Mongo connection.

import mongoose from "mongoose";

// ---------- Config ----------
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || ""; // optional, but better
const NHS_HTML_BASE = "https://www.nhs.uk/service-search/find-a-dentist/results";
const NHS_COOKIES =
  process.env.NHS_COOKIES ||
  "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; OptanonAlertBoxClosed=2025-01-01T00:00:00.000Z";

const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";      // show diag info in result.meta
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800); // per-postcode politeness delay
const MAX_PCS = Number(process.env.SCAN_MAX_PCS || 20); // safety cap

// ---------- Small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asJSONsafe(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function isLikelyJSON(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json");
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { redirect: "follow", headers });
  const t = await res.text();
  if (!res.ok) {
    const msg = `http_${res.status}`;
    throw new Error(msg);
  }
  return t;
}

async function fetchJsonOrNull(url, headers = {}) {
  const res = await fetch(url, { redirect: "follow", headers });
  const t = await res.text();
  if (!res.ok) return null;
  if (!isLikelyJSON(res)) return null;
  const j = asJSONsafe(t);
  return j;
}

function dedupeCards(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const k = (c.link || "") + "|" + (c.name || "");
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}

// Pull “cards” from many likely JSON shapes (the API isn’t always consistent)
function parseCardsFromAnyJSON(obj) {
  if (!obj) return [];
  const pools = [
    obj.results,
    obj.value,
    obj.items,
    obj.organisations,
    Array.isArray(obj) ? obj : null,
  ].filter(Boolean);

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

// Very lightweight HTML card parser (nhs.uk card links)
function parseCardsFromHTML(html) {
  const out = [];
  const re =
    /<a[^>]+(?:class="[^"]*nhsuk-card__link[^"]*"[^>]*|href="(\/services\/dentist\/[^"]+)")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let m;
  while ((m = re.exec(html))) {
    const href = m[2] || m[1];
    const name = (m[3] || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Dentist";
    if (!href) continue;
    const link = href.startsWith("http") ? href : "https://www.nhs.uk" + href;
    out.push({ name, link });
  }

  // fallback pattern
  if (!out.length) {
    const re2 = /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m2;
    while ((m2 = re2.exec(html))) {
      const link = "https://www.nhs.uk" + m2[1];
      const name = (m2[2] || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "Dentist";
      out.push({ name, link });
    }
  }

  return dedupeCards(out);
}

async function geocodePostcode(pc) {
  try {
    const norm = pc.replace(/\s+/g, "");
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(norm)}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { lat: j?.result?.latitude ?? null, lon: j?.result?.longitude ?? null };
  } catch { return {}; }
}

// ---------- Core probes ----------
async function probeAPI(pc, diag) {
  if (!NHS_API_KEY) return { source: "api", url: null, cards: [] };

  // Step 1: geocode pc -> lat/lon
  const { lat, lon } = await geocodePostcode(pc);
  if (!lat || !lon) {
    if (diag) diag.errors.push({ step: "geocode", msg: "no_lat_lon" });
    return { source: "api", url: null, cards: [] };
  }

  const qs = new URLSearchParams({
    "api-version": NHS_API_VERSION,
    latitude: String(lat),
    longitude: String(lon),
    serviceType: "dentist",
    top: String(process.env.NHS_API_TOP || 50),
    skip: "0",
    distance: String(process.env.NHS_API_DISTANCE_KM || 50),
  });

  const url = `${NHS_API_BASE}/organisations?${qs.toString()}`;
  const headers = {
    "subscription-key": NHS_API_KEY,
    "Accept": "application/json",
  };

  const j = await fetchJsonOrNull(url, headers);
  if (diag) {
    diag.calls.push({ url, json: !!j });
    if (!j) diag.errors.push({ step: "api", msg: "non_json_or_empty" });
  }

  const cards = parseCardsFromAnyJSON(j);
  return { source: "api", url, cards };
}

async function probeHTML(pc, diag) {
  const url = `${NHS_HTML_BASE}/${encodeURIComponent(pc)}?distance=30`;
  try {
    const html = await fetchText(url, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html",
      "Cookie": NHS_COOKIES,
      "Referer": "https://www.nhs.uk/",
    });
    const cards = parseCardsFromHTML(html);
    if (diag) diag.calls.push({ url, html: true, cards: cards.length });
    return { source: "html", url, cards };
  } catch (e) {
    if (diag) diag.errors.push({ step: "html", msg: String(e?.message || e) });
    return { source: "html", url, cards: [] };
  }
}

async function getCardsForPostcode(pc, diag) {
  // Try API first
  const api = await probeAPI(pc, diag);
  if (api.cards && api.cards.length) return api;

  // Fallback to HTML
  const html = await probeHTML(pc, diag);
  return html;
}

// ---------- Main entry ----------
export async function runScan() {
  // read watches directly from the active connection (no model import)
  const watches = await mongoose.connection.collection("watches").find({}).toArray();

  // distinct postcodes across watches (cap to MAX_PCS for safety)
  const pcs = [...new Set(
    watches.flatMap(w => {
      const raw = Array.isArray(w.postcode) ? w.postcode : String(w.postcode || "").split(/[,;]+/);
      return raw.map(s => s.trim()).filter(Boolean);
    })
  )].slice(0, MAX_PCS);

  let checked = 0, found = 0, alertsSent = 0;
  const diag = SCAN_DEBUG ? { calls: [], errors: [] } : null;

  for (const pc of pcs) {
    try {
      const r = await getCardsForPostcode(pc, diag);
      checked++;
      if (r.cards?.length) {
        found += r.cards.length;
        // NOTE: here is where matching logic could filter for "accepting new patients"
        // and send emails. For now we just count.
      }
    } catch (e) {
      if (diag) diag.errors.push({ step: "pc", pc, msg: String(e?.message || e) });
      // keep scanning the rest
    }
    await sleep(SCAN_DELAY_MS);
  }

  const result = { ok: true, checked, found, alertsSent };
  if (SCAN_DEBUG) {
    result.meta = {
      usedApi: !!NHS_API_KEY,
      pcsScanned: pcs.length,
      calls: diag.calls,
      errors: diag.errors,
    };
  }
  return result;
}
