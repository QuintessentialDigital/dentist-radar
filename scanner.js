// scanner.js – DentistRadar NHS scanner (v9 – production hardened)
//
// Fixes:
//  - Robust extraction using "Vxxxxxx DEN" anchors
//  - Correct parsing for "Within X mile(s)"
//  - Clean name extraction
//  - Concurrency limit for appointments
//  - TTL cache to protect upstream NHS + your infra

import "dotenv/config";

/* ---------------- CONFIG ---------------- */

const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 12000;
const SCAN_APPT_CONCURRENCY = Number(process.env.SCAN_APPT_CONCURRENCY) || 4;
const SCAN_CACHE_TTL_MS = Number(process.env.SCAN_CACHE_TTL_MS) || 5 * 60 * 1000;
const SCAN_CACHE_MAX = Number(process.env.SCAN_CACHE_MAX) || 2000;

const DEFAULT_UA =
  process.env.SCAN_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/* ---------------- CACHE ---------------- */

const scanCache = new Map();

function cacheKey(postcode, radius) {
  return `${postcode.toUpperCase()}|${radius}`;
}

function cacheGet(key) {
  const hit = scanCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SCAN_CACHE_TTL_MS) {
    scanCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  scanCache.set(key, { at: Date.now(), value });

  if (scanCache.size > SCAN_CACHE_MAX) {
    const entries = Array.from(scanCache.entries());
    entries.sort((a, b) => a[1].at - b[1].at);
    const toDelete = Math.ceil(SCAN_CACHE_MAX * 0.1);
    for (let i = 0; i < toDelete; i++) scanCache.delete(entries[i][0]);
  }
}

/* ---------------- HELPERS ---------------- */

function buildSearchUrl(postcode, radiusMiles) {
  const raw = String(postcode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let formatted = raw;
  if (raw.length >= 5) {
    formatted = `${raw.slice(0, raw.length - 3)} ${raw.slice(-3)}`;
  }
  const pathPostcode = formatted.replace(/\s+/, "-");
  const radius = Number(radiusMiles) || 5;

  return `https://www.nhs.uk/service-search/find-a-dentist/results/${encodeURIComponent(
    pathPostcode
  )}?distance=${radius}`;
}

async function fetchText(url, label = "fetch") {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    clearTimeout(id);

    if (!res.ok) {
      console.error(`[SCAN] ${label} failed ${res.status}`);
      return "";
    }

    return await res.text();
  } catch (err) {
    clearTimeout(id);
    console.error(
      `[SCAN] ${label} error:`,
      err?.name === "AbortError" ? "timeout" : err?.message
    );
    return "";
  }
}

function htmlToText(html = "") {
  if (!html) return "";
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

function extractPhone(text) {
  const match = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return match ? match[0] : "Not available";
}

function parseDistanceMiles(text) {
  if (!text) return null;

  let m =
    text.match(/Within\s+([\d.,]+)\s*miles?/i) ||
    text.match(/([\d.,]+)\s*miles?/i);

  if (!m) return null;

  const n = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/* ---------------- EXTRACTION ---------------- */

function extractResultBlocks(text) {
  if (!text) return [];

  const rx = /V\d{6}\s+DEN/gi;
  const blocks = [];
  const seen = new Set();
  let m;

  while ((m = rx.exec(text)) !== null) {
    const idx = m.index;
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + 600);
    const snippet = text.slice(start, end).trim();

    const v = snippet.match(/V\d{6}/i)?.[0];
    if (!v || seen.has(v)) continue;
    seen.add(v);

    blocks.push(snippet);
  }

  return blocks;
}

function parsePractice(block, postcode) {
  const lower = block.toLowerCase();

  // Name extraction
  let name = "Unknown practice";
  const nameMatch = block.match(/V\d{6}\s+DEN\s+(.+?)(?=\s+\d|,| Within| Address| Phone|$)/i);
  if (nameMatch) name = nameMatch[1].trim();

  // Distance
  const distanceMatch = block.match(/Within\s+([\d.,]+\s*miles?)/i);
  const distanceText = distanceMatch ? distanceMatch[0] : "";
  const distanceMiles = parseDistanceMiles(distanceText);

  // Address
  const addressMatch = block.match(/DEN\s+.+?\s+(.+?\d{2,}.*?)(?= Phone| Within|$)/i);
  const address = addressMatch ? addressMatch[1].trim() : "";

  const phone = extractPhone(block);
  const vcode = block.match(/V\d{6}/i)?.[0] || null;

  const slug = name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

  const nhsUrl = vcode
    ? `https://www.nhs.uk/services/dentist/${slug}/${vcode}`
    : "";

  return {
    name,
    address,
    phone,
    distanceText,
    distanceMiles,
    status: "unknown",
    postcode,
    nhsUrl,
    appointmentsUrl: nhsUrl ? `${nhsUrl}/appointments` : "",
    vcode,
  };
}

/* ---------------- CONCURRENCY ---------------- */

async function runPool(items, concurrency, workerFn) {
  const results = [];
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await workerFn(items[current]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner)
  );

  return results;
}

/* ---------------- MAIN SCAN ---------------- */

export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const radius = Number(radiusMiles) || 5;

  const key = cacheKey(postcode, radius);
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const searchUrl = buildSearchUrl(postcode, radius);
  const html = await fetchText(searchUrl, "search");
  const text = htmlToText(html);

  const blocks = extractResultBlocks(text);
  console.log(`[SCAN] Parsed ${blocks.length} practices`);

  const practicesRaw = blocks.map((b) => parsePractice(b, postcode));

  const practices = practicesRaw.filter((p) => {
    if (!p.distanceMiles) return true;
    return p.distanceMiles <= radius + 0.2;
  });

  const enriched = await runPool(practices, SCAN_APPT_CONCURRENCY, async (p) => {
    if (!p.appointmentsUrl) return p;

    const apptHtml = await fetchText(p.appointmentsUrl, "appointments");
    const lower = htmlToText(apptHtml).toLowerCase();

    if (lower.includes("not accepting new nhs patients")) p.status = "notAccepting";
    else if (lower.includes("accepting new nhs patients")) p.status = "accepting";
    else p.status = "unknown";

    return p;
  });

  const accepting = enriched.filter((p) => p.status === "accepting");
  const notAccepting = enriched.filter((p) => p.status === "notAccepting");
  const unknown = enriched.filter((p) => p.status === "unknown");

  const result = {
    postcode,
    radiusMiles: radius,
    acceptingCount: accepting.length,
    notAcceptingCount: notAccepting.length,
    unknownCount: unknown.length,
    scanned: enriched.length,
    accepting,
    notAccepting,
    unknown,
    tookMs: Date.now() - started,
  };

  cacheSet(key, result);

  return result;
}
