// scanner.js – DentistRadar NHS scanner (v8.0 – robust HTML extraction + caching + concurrency)
//
// Key upgrades vs v7.2:
//  - Extract results from raw HTML (links + context) instead of brittle text markers
//  - Fallback extraction via V-code and "This organisation is ... away" text
//  - TTL cache to reduce upstream calls (critical for 1000+ users/day)
//  - Concurrency limit for appointments fetches (prevents throttling / overload)

import "dotenv/config";

/* ----------------------------- CONFIG ----------------------------- */

const SCAN_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS) || 12000;
const SCAN_APPT_CONCURRENCY = Number(process.env.SCAN_APPT_CONCURRENCY) || 4;
const SCAN_CACHE_TTL_MS = Number(process.env.SCAN_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min
const SCAN_CACHE_MAX = Number(process.env.SCAN_CACHE_MAX) || 2000;

// Use a realistic UA (your old one screams "bot")
const DEFAULT_UA =
  process.env.SCAN_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/* ----------------------------- CACHE ------------------------------ */

const scanCache = new Map(); // key -> { at, value }

function cacheKey(postcode, radiusMiles) {
  return `${String(postcode || "").trim().toUpperCase()}|${Number(radiusMiles) || 0}`;
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

  // naive cap (good enough): delete oldest ~10% when over max
  if (scanCache.size > SCAN_CACHE_MAX) {
    const entries = Array.from(scanCache.entries());
    entries.sort((a, b) => a[1].at - b[1].at);
    const toDelete = Math.ceil(SCAN_CACHE_MAX * 0.1);
    for (let i = 0; i < toDelete; i++) scanCache.delete(entries[i][0]);
  }
}

/* --------------------------- UTILITIES ---------------------------- */

function buildNhsSearchUrl(postcode, radiusMiles) {
  const raw = String(postcode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let formatted = raw;

  // "RG414UW" -> "RG41 4UW"
  if (raw.length >= 5) {
    formatted = `${raw.slice(0, raw.length - 3)} ${raw.slice(-3)}`;
  }

  const pathPostcode = formatted.replace(/\s+/, "-"); // "RG41-4UW"
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
      redirect: "follow",
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    clearTimeout(id);

    if (!res.ok) {
      console.error(`[SCAN] ${label} failed ${res.status} for ${url}`);
      return "";
    }

    return await res.text();
  } catch (err) {
    clearTimeout(id);
    console.error(
      `[SCAN] ${label} error for ${url}:`,
      err?.name === "AbortError" ? "timeout" : err?.message || err
    );
    return "";
  }
}

function htmlToText(html = "") {
  if (!html) return "";
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function parseDistanceMiles(distanceText) {
  if (!distanceText) return null;
  const m = distanceText.match(/([\d.,]+)\s*mile/i);
  if (!m) return null;
  const raw = m[1].replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function extractPhoneFromBlock(text) {
  if (!text) return "Not available";
  const match = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return match ? match[0].trim() : "Not available";
}

function extractVCodeFromText(text = "") {
  const match = text.match(/V\d{6}/i);
  return match ? match[0].toUpperCase() : null;
}

function parsePatientType(lowerText) {
  const hasAdults =
    lowerText.includes("adult nhs patients") ||
    lowerText.includes("adults aged") ||
    lowerText.includes(" adults ") ||
    lowerText.includes(" adult ");
  const hasChildren =
    lowerText.includes("child nhs patients") ||
    lowerText.includes("children aged") ||
    lowerText.includes(" children ") ||
    lowerText.includes(" child ");

  let patientType = "Unknown";
  let childOnly = false;

  if (hasAdults && hasChildren) {
    patientType = "Adults & children";
    childOnly = false;
  } else if (hasChildren && !hasAdults) {
    patientType = "Children only";
    childOnly = true;
  } else if (hasAdults && !hasChildren) {
    patientType = "Adults only";
    childOnly = false;
  }

  return { patientType, childOnly };
}

function classifyAcceptanceFromAppointments(lower) {
  if (!lower) return "unknown";

  // Not accepting
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";
  if (lower.includes("is not taking on any new nhs patients")) return "notAccepting";
  if (lower.includes("is not currently taking on new nhs patients")) return "notAccepting";

  // No update
  if (
    lower.includes("has not given a recent update on whether they're taking new nhs patients") ||
    lower.includes("has not given a recent update on whether they are taking new nhs patients")
  ) {
    return "unknown";
  }

  // Accepting
  if (lower.includes("when availability allows, this dentist accepts new nhs patients"))
    return "accepting";
  if (lower.includes("accepts new nhs patients")) return "accepting";
  if (lower.includes("accepting new nhs patients")) return "accepting";
  if (lower.includes("taking on new nhs patients")) return "accepting";
  if (lower.includes("is taking new nhs patients")) return "accepting";
  if (lower.includes("accepting new adult nhs patients")) return "accepting";
  if (lower.includes("accepting new child nhs patients")) return "accepting";
  if (lower.includes("only taking new nhs patients for specialist dental care by referral"))
    return "accepting";

  return "unknown";
}

function classifyAcceptanceFromSearchText(lower) {
  if (!lower) return "unknown";

  // Not accepting
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";

  // No update
  if (lower.includes("has not given a recent update on whether they're taking new nhs patients"))
    return "unknown";

  // Accepting
  if (lower.includes("when availability allows, this dentist accepts new nhs patients"))
    return "accepting";
  if (lower.includes("accepts new nhs patients")) return "accepting";
  if (lower.includes("accepting new nhs patients")) return "accepting";
  if (lower.includes("taking on new nhs patients")) return "accepting";

  return "unknown";
}

/* ------------------------ RESULT EXTRACTION ------------------------ */

/**
 * Best-effort extraction from search HTML:
 *  - Finds dentist profile links: /services/dentist/<slug>/V123456
 *  - Captures nearby HTML context (so we can parse name/distance/address)
 *
 * This avoids brittle "Result for ..." markers entirely.
 */
function extractResultSnippetsFromHtml(html) {
  if (!html) return [];

  const snippets = [];
  const seenV = new Set();

  // Grab occurrences of dentist profile URLs in the HTML
  // Example: /services/dentist/winnersh-dental-practice/V006578
  const linkRegex = /\/services\/dentist\/[^"'\s<>]+\/V\d{6}/gi;
  let m;

  while ((m = linkRegex.exec(html)) !== null) {
    const idx = m.index;
    const urlPart = m[0];
    const v = extractVCodeFromText(urlPart);
    if (!v || seenV.has(v)) continue;
    seenV.add(v);

    // Capture context around the link
    const start = Math.max(0, idx - 4000);
    const end = Math.min(html.length, idx + 4000);
    const contextHtml = html.slice(start, end);

    // Convert that context to text for parsing
    const contextText = htmlToText(contextHtml);

    // Wrap to keep compatibility with existing parsing style
    snippets.push(`Result for ${contextText}`);
  }

  return snippets;
}

/**
 * Fallback extraction from plain text:
 *  - V-code snippets
 *  - distance phrase snippets
 */
function extractResultSnippetsFromText(text) {
  if (!text) return [];

  // A) V-code snippets
  const vcodeRegex = /V\d{6}/gi;
  const seen = new Set();
  const blocks = [];

  let m;
  while ((m = vcodeRegex.exec(text)) !== null) {
    const v = m[0].toUpperCase();
    if (seen.has(v)) continue;
    seen.add(v);

    const idx = m.index;
    const start = Math.max(0, idx - 240);
    const end = Math.min(text.length, idx + 1300);
    const snippet = text.slice(start, end).trim();
    if (snippet.length < 40) continue;
    blocks.push(`Result for ${snippet}`);
  }
  if (blocks.length > 0) return blocks;

  // B) distance phrase snippets
  const distRegex = /This organisation is\s+[\s\S]{0,40}?\s+away/gi;
  const dBlocks = [];
  const seenIdx = new Set();

  let d;
  while ((d = distRegex.exec(text)) !== null) {
    const idx = d.index;
    if (seenIdx.has(idx)) continue;
    seenIdx.add(idx);

    const start = Math.max(0, idx - 400);
    const end = Math.min(text.length, idx + 1200);
    const snippet = text.slice(start, end).trim();
    if (snippet.length < 60) continue;
    dBlocks.push(`Result for ${snippet}`);
  }

  return dBlocks;
}

/**
 * Extract blocks using:
 *  1) HTML link-based extraction (best)
 *  2) Legacy "Result for ... End..." (if present)
 *  3) Text fallbacks (V-code / distance phrase)
 */
function extractResultBlocks(html) {
  if (!html) return [];

  // 1) Best: parse dentist links from HTML
  const linkBlocks = extractResultSnippetsFromHtml(html);
  if (linkBlocks.length > 0) return linkBlocks;

  // 2) Legacy marker-based extraction (kept for compatibility)
  const text = htmlToText(html);
  const legacy = [];
  const regex = /Result for\s+([\s\S]*?)(?=End of result for|Result for\s+|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    legacy.push(`Result for ${body}`);
  }
  if (legacy.length > 0) return legacy;

  // 3) Fallback extraction from text
  return extractResultSnippetsFromText(text);
}

/* --------------------------- PARSING ------------------------------ */

function buildNhsProfileUrlFromBlock(block) {
  // Prefer extracting the canonical /services/dentist/.../V123456 from the block if present
  const m = block.match(/https?:\/\/www\.nhs\.uk\/services\/dentist\/[^"'\s<>]+\/V\d{6}/i);
  if (m) return m[0].replace(/\/$/, "");

  const m2 = block.match(/\/services\/dentist\/[^"'\s<>]+\/V\d{6}/i);
  if (m2) return `https://www.nhs.uk${m2[0]}`.replace(/\/$/, "");

  // Fallback: build from name + vcode (your old approach)
  return "";
}

function buildNhsProfileUrlFromNameAndVcode(name, vCode) {
  if (!name || !vCode) return "";
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `https://www.nhs.uk/services/dentist/${slug}/${vCode}`;
}

function parsePracticeFromBlock(block, postcode) {
  const lower = block.toLowerCase();

  // Name (best-effort)
  let name = "Unknown practice";
  const nameMatch = block.match(
    /Result for\s+(.+?)(?=\s{2,}|This organisation is|Address for this organisation is|Phone:|$)/i
  );
  if (nameMatch) name = nameMatch[1].trim();

  // Strip trailing "Vxxxxxx DEN"
  name = name.replace(/\s+V\d{6}\s+DEN$/i, "").trim();

  // Distance
  let distanceText = "";
  const distMatch = block.match(/This organisation is\s+(.+?)\s+away/i);
  if (distMatch) distanceText = distMatch[1].trim();
  const distanceMiles = parseDistanceMiles(distanceText);

  // Address
  let address = "";
  const addrMatch = block.match(
    /Address for this organisation is\s+(.+?)(?:Phone:|This dentist surgery|When availability allows|Not accepting new NHS patients|has not given a recent update|End of result for|$)/i
  );
  if (addrMatch) address = addrMatch[1].trim();

  // Phone
  const phone = extractPhoneFromBlock(block);

  // V-code
  const vcode = extractVCodeFromText(block);

  const { patientType, childOnly } = parsePatientType(lower);

  // NHS URL
  let nhsUrl = buildNhsProfileUrlFromBlock(block);
  if (!nhsUrl && vcode && name && name !== "Unknown practice") {
    nhsUrl = buildNhsProfileUrlFromNameAndVcode(name, vcode);
  }

  // appointments URL
  const appointmentsUrl = nhsUrl ? `${nhsUrl.replace(/\/$/, "")}/appointments` : "";

  return {
    name,
    address,
    phone,
    distanceText,
    distanceMiles,
    status: "unknown",
    patientType,
    childOnly,
    postcode: postcode || "",
    nhsUrl,
    appointmentsUrl,
    vcode,
  };
}

/* ------------------------- CONCURRENCY ---------------------------- */

// simple concurrency pool (no dependencies)
async function runPool(items, concurrency, workerFn) {
  const results = [];
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await workerFn(items[current], current);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, runner));
  return results;
}

/* ----------------------------- SCAN ------------------------------- */

export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const radius = Number(radiusMiles) || 5;

  // 0) Cache (critical for scale)
  const key = cacheKey(postcode, radius);
  const cached = cacheGet(key);
  if (cached) {
    return {
      ...cached,
      tookMs: Date.now() - started,
      cached: true,
    };
  }

  const searchUrl = buildNhsSearchUrl(postcode, radius);
  console.log(
    `[SCAN] (v8.0) Searching NHS for ${postcode} (${radius} miles) – ${searchUrl}`
  );

  // 1) Fetch NHS search results HTML
  const html = await fetchText(searchUrl, "search");

  // Basic guard: sometimes you get cookie/consent/interstitial HTML
  if (!html || html.length < 500) {
    console.error("[SCAN] search returned unusually short HTML:", html?.length || 0);
  }

  // 2) Extract blocks (robust)
  const blocks = extractResultBlocks(html);
  console.log(`[SCAN] (v8.0) Parsed ${blocks.length} result block(s) from search results.`);

  // 3) Parse practices
  const parsedRaw = blocks.map((block) => parsePracticeFromBlock(block, postcode));

  // 4) Radius filter (strict)
  const RADIUS_TOLERANCE = 0.2;
  const parsed = parsedRaw.filter((p) => {
    if (p.distanceMiles == null || isNaN(p.distanceMiles)) return true;
    return p.distanceMiles <= radius + RADIUS_TOLERANCE;
  });

  console.log(
    `[SCAN] (v8.0) After radius filter (${radius} mi): kept ${parsed.length}/${parsedRaw.length} practices.`
  );

  // 5) Fetch appointments pages (concurrency-limited)
  const enriched = await runPool(parsed, SCAN_APPT_CONCURRENCY, async (p) => {
    let finalStatus = "unknown";

    if (p.appointmentsUrl) {
      const apptHtml = await fetchText(p.appointmentsUrl, "appointments");
      const apptText = htmlToText(apptHtml).toLowerCase();

      if (apptText) {
        finalStatus = classifyAcceptanceFromAppointments(apptText);

        const { patientType, childOnly } = parsePatientType(apptText);
        if (patientType !== "Unknown") {
          p.patientType = patientType;
          p.childOnly = childOnly;
        }
      }
    }

    // Fallback classification from the search block text (if still unknown)
    if (finalStatus === "unknown") {
      const lower = String(p.name || "").toLowerCase(); // tiny hint
      finalStatus = classifyAcceptanceFromSearchText(lower);
    }

    p.status = finalStatus;
    return p;
  });

  // 6) Group results
  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const p of enriched) {
    if (p.status === "accepting") accepting.push(p);
    else if (p.status === "notAccepting") notAccepting.push(p);
    else unknown.push(p);
  }

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

  console.log("[SCAN] (v8.0) Result summary:", {
    postcode: result.postcode,
    radiusMiles: result.radiusMiles,
    accepting: result.acceptingCount,
    notAccepting: result.notAcceptingCount,
    unknown: result.unknownCount,
    scanned: result.scanned,
    tookMs: result.tookMs,
  });

  // 7) Store cache
  cacheSet(key, result);

  return result;
}
