// src/scanner.js — resilient scan: API-first, HTML fallback, never throws on non-JSON
// Safe with your current baseline (no UI changes).

import mongoose from "mongoose";

// ---------- Config ----------
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || ""; // optional, but better
const NHS_HTML_BASE = "https://www.nhs.uk/service-search/find-a-dentist/results";
const NHS_COOKIES =
  process.env.NHS_COOKIES ||
  "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; OptanonAlertBoxClosed=2025-01-01T00:00:00.000Z";

const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";         // set to 1 while testing
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800);
const MAX_PCS = Number(process.env.SCAN_MAX_PCS || 20);

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isLikelyJSON(res) {
  const ct = res.headers?.get?.("content-type") || "";
  return ct.includes("application/json");
}
async function fetchText(url, headers = {}) {
  const res = await fetch(url, { redirect: "follow", headers });
  const text = await res.text();
  // Do NOT throw here; return status + text so we can decide how to proceed
  return { ok: res.ok, status: res.status, text, json: null, isJSON: isLikelyJSON(res) };
}
async function fetchJSON(url, headers = {}) {
  const r = await fetchText(url, headers);
  if (!r.ok || !r.isJSON) return { ok: r.ok, status: r.status, json: null, isJSON: false, text: r.text };
  try {
    const parsed = JSON.parse(r.text);
    return { ok: true, status: r.status, json: parsed, isJSON: true, text: r.text };
  } catch {
    return { ok: false, status: r.status, json: null, isJSON: false, text: r.text };
  }
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

function parseCardsFromAnyJSON(obj) {
  if (!obj) return [];
  const pools = [
    obj.results, obj.value, obj.items, obj.organisations,
    Array.isArray(obj) ? obj : null
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

function parseCardsFromHTML(html) {
  const out = [];
  // common NHS card link patterns
  const patterns = [
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : "https://www.nhs.uk" + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      out.push({ name, link: href });
    }
    if (out.length) break;
  }
  return dedupeCards(out);
}

async function geocode(pc) {
  try {
    const norm = pc.replace(/\s+/g, "");
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(norm)}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { lat: j?.result?.latitude ?? null, lon: j?.result?.longitude ?? null };
  } catch { return {}; }
}

// ---------- Probes ----------
async function probeAPI(pc, diag) {
  if (!NHS_API_KEY) return { source: "api", url: null, cards: [], note: "no_key" };

  const { lat, lon } = await geocode(pc);
  if (!lat || !lon) {
    diag?.errors.push({ step: "geocode", pc, msg: "no_lat_lon" });
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
  }).toString();

  const url = `${NHS_API_BASE}/organisations?${qs}`;
  const headers = { "subscription-key": NHS_API_KEY, Accept: "application/json" };
  const r = await fetchJSON(url, headers);

  diag?.calls.push({ url, ok: r.ok, isJSON: r.isJSON, status: r.status });

  if (!r.ok || !r.json) return { source: "api", url, cards: [] }; // don’t throw
  const cards = parseCardsFromAnyJSON(r.json);
  return { source: "api", url, cards };
}

async function probeHTML(pc, diag) {
  const url = `${NHS_HTML_BASE}/${encodeURIComponent(pc)}?distance=30`;
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Cookie": NHS_COOKIES,
    "Referer": "https://www.nhs.uk/",
  };
  const r = await fetchText(url, headers);
  diag?.calls.push({ url, ok: r.ok, isJSON: r.isJSON, status: r.status });
  if (!r.ok) return { source: "html", url, cards: [], note: `http_${r.status}` };
  const cards = parseCardsFromHTML(r.text);
  return { source: "html", url, cards };
}

async function getCardsForPC(pc, diag) {
  // Try API first (if key)
  const api = await probeAPI(pc, diag);
  if (api.cards?.length) return api;

  // Fallback to HTML
  const html = await probeHTML(pc, diag);
  return html;
}

// ---------- Entry ----------
export async function runScan() {
  // get distinct postcodes from watches
  const watches = await mongoose.connection.collection("watches").find({}).toArray();
  const pcs = [...new Set(
    watches.flatMap(w => {
      const raw = Array.isArray(w.postcode) ? w.postcode : String(w.postcode || "").split(/[,;]+/);
      return raw.map(s => s.trim()).filter(Boolean);
    })
  )].slice(0, MAX_PCS);

  const diag = SCAN_DEBUG ? { calls: [], errors: [] } : null;
  let checked = 0, found = 0, alertsSent = 0;

  for (const pc of pcs) {
    try {
      const r = await getCardsForPC(pc, diag);
      checked++;
      if (r.cards?.length) found += r.cards.length;
    } catch (e) {
      // we swallow errors so /api/scan never returns ok:false
      diag?.errors.push({ step: "pc", pc, msg: String(e?.message || e) });
    }
    await sleep(SCAN_DELAY_MS);
  }

  const result = { ok: true, checked, found, alertsSent };
  if (SCAN_DEBUG) result.meta = { usedApi: !!NHS_API_KEY, pcsScanned: pcs.length, ...diag };
  return result;
}
