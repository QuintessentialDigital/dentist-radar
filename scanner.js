// scanner.js — Diagnostic + Robust NHS parsing (safe drop-in for Dentist Radar)
//
// ✅ Works with MongoDB, email, and UI
// ✅ Adds deeper NHS API fallback and diagnostics
// ✅ Simulation-friendly (no changes to other modules)

import fetch from "node-fetch";
import mongoose from "mongoose";

const NHS_BASE = process.env.NHS_BASE || "https://api.nhs.uk/service-search";
const NHS_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_KEY = process.env.NHS_API_KEY || "";
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";
const SCAN_SNAPSHOT = process.env.SCAN_SNAPSHOT === "1";
const NHS_COOKIES =
  process.env.NHS_COOKIES ||
  "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; OptanonAlertBoxClosed=2025-01-01T00:00:00.000Z";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
      "Cache-Control": "no-cache",
      "Upgrade-Insecure-Requests": "1",
      "Referer": "https://www.nhs.uk/",
      "Cookie": NHS_COOKIES,
      ...headers,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.text();
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text(); // capture raw for diagnostics
  let json = {};
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`http_${res.status}`);
  return json;
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
  const out = [];
  const pools = [
    obj?.results, obj?.value, obj?.items, obj?.organisations, obj?.Services,
    Array.isArray(obj) ? obj : null
  ].filter(Boolean);

  for (const pool of pools) {
    for (const it of pool) {
      const name =
        it?.name ||
        it?.organisationName ||
        it?.practiceName ||
        it?.title ||
        it?.OrganisationName;

      let link =
        it?.url || it?.href || it?.link || it?.websiteUrl || it?.orgLink || it?.path || it?.relativeUrl;

      if (link && !/^https?:\/\//i.test(link)) link = "https://www.nhs.uk" + link;

      if (name && link) {
        if (/\/services\/dentist\//i.test(link) || /nhs\.uk\/.*dent/i.test(link)) {
          out.push({ name: String(name).trim(), link });
        } else {
          out.push({ name: String(name).trim(), link });
        }
      }
    }
  }
  return dedupeCards(out);
}

function parsePracticeCardsHTML(html) {
  const patterns = [
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<h2[^>]*class="[^"]*nhsuk-card__heading[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+class="[^"]*nhsuk-list-panel__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      const name = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const link = href.startsWith("http") ? href : "https://www.nhs.uk" + href;
      out.push({ name: name || "Dentist", link });
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

async function getPracticeCardsForPostcode(pc, apiDiag) {
  const key = NHS_KEY;
  const { lat, lon } = await geocode(pc);
  const headers = key ? { "subscription-key": key, Accept: "application/json" } : {};

  // (A) organisations near lat/lon (best)
  if (key && lat && lon) {
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
      apiDiag.calls.push({ url: urlA, keys: Object.keys(jsonA || {}) });
      let cards = parseCardsFromAnyJSON(jsonA);
      if (cards.length) return { source: "api", url: urlA, cards };
    } catch (e) {
      apiDiag.errors.push({ step: "A", msg: String(e?.message || e) });
    }
  }

  // (B) search-postcode-or-place
  if (key) {
    const qs = new URLSearchParams({ "api-version": NHS_VERSION, search: pc.toUpperCase() });
    const urlB = `${NHS_BASE}/search-postcode-or-place?${qs.toString()}`;
    try {
      const jsonB = await fetchJSON(urlB, headers);
      apiDiag.calls.push({ url: urlB, keys: Object.keys(jsonB || {}) });
      let cards = parseCardsFromAnyJSON(jsonB);
      if (cards.length) return { source: "api", url: urlB, cards };
    } catch (e) {
      apiDiag.errors.push({ step: "B", msg: String(e?.message || e) });
    }
  }

  // (C) HTML fallback
  const urlH = `https://www.nhs.uk/service-search/find-a-dentist/results/${encodeURIComponent(pc)}?distance=30`;
  try {
    const html = await fetchText(urlH);
    const cards = parsePracticeCardsHTML(html);
    if (SCAN_SNAPSHOT) {
      const snippet = html.replace(/\s+/g, " ").slice(0, 1500);
      try {
        await mongoose.connection.collection("scanlogs").insertOne({
          pc, url: urlH, htmlSnippet: snippet, when: new Date()
        });
      } catch {}
    }
    return { source: "html", url: urlH, cards, html };
  } catch (e) {
    apiDiag.errors.push({ step: "HTML", msg: String(e?.message || e) });
    return { source: "html", url: urlH, cards: [], html: "" };
  }
}

export async function runScan() {
  const watches = await mongoose.connection.collection("watches").find({}).toArray();

  let checked = 0, found = 0, alertsSent = 0;
  let suspectedCookieWall = false;
  const samples = [];
  const apiDiag = { calls: [], errors: [] };

  const pcs = [...new Set(watches.flatMap(w => {
    const raw = Array.isArray(w.postcode) ? w.postcode : String(w.postcode || "").split(/[,;]+/);
    return raw.map(x => x.trim()).filter(Boolean);
  }))];

  for (const pc of pcs) {
    const r = await getPracticeCardsForPostcode(pc, apiDiag);
    checked += 1;
    if (r.cards?.length) found += r.cards.length;
    if (SCAN_DEBUG && samples.length < 5) samples.push({ pc, src: r.source, n: r.cards.length });
    if (r.source === "html" && !r.cards?.length) suspectedCookieWall = suspectedCookieWall || false;
    await delay(800);
  }

  const result = {
    ok: true,
    checked,
    found,
    alertsSent,
    suspectedCookieWall,
  };

  if (SCAN_DEBUG) {
    result.meta = {
      samples,
      flags: { usedApi: !!NHS_KEY, suspectedCookieWall },
      apiDiag
    };
  }
  return result;
}
