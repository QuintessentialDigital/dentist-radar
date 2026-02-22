// scanner.js – DentistRadar NHS scanner (v7.4 – robust result parsing + within-distance support)
//
// Safe patch based on your working v7.2:
//  - Fixes "Parsed 0 result blocks" by extracting blocks around "Vxxxxxx DEN"
//  - Adds support for distance format "Within X mile(s)"
//  - Adds name fallback parsing "Vxxxxxx DEN <Practice Name>"
//  - Keeps your proven acceptance classifiers + appointments logic intact

import "dotenv/config";

/**
 * Build the NHS dentist search URL.
 * Example:
 *   https://www.nhs.uk/service-search/find-a-dentist/results/RG41-4UW?distance=10
 */
function buildNhsSearchUrl(postcode, radiusMiles) {
  const raw = String(postcode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let formatted = raw;

  // "RG414UW" -> "RG41 4UW"
  if (raw.length >= 5) {
    formatted = `${raw.slice(0, raw.length - 3)} ${raw.slice(-3)}`;
  }

  const pathPostcode = formatted.replace(/\s+/, "-"); // "RG41-4UW"
  const radius = Number(radiusMiles) || 5;

  const url = `https://www.nhs.uk/service-search/find-a-dentist/results/${encodeURIComponent(
    pathPostcode
  )}?distance=${radius}`;

  return url;
}

function extractVCodeFromBlock(block = "") {
  const match = block.match(/V\d{6}/i);
  return match ? match[0].toUpperCase() : null;
}

/**
 * Fetch with timeout so NHS can't hang the whole cron.
 */
async function fetchText(url, label = "fetch") {
  const timeoutMs = Number(process.env.SCAN_TIMEOUT_MS) || 12000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // More realistic UA than the old "DentistRadar scanner"
        "User-Agent":
          process.env.SCAN_UA ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

/**
 * Turn HTML into a linear text string for regex / substring search.
 */
function htmlToText(html = "") {
  if (!html) return "";
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/**
 * Extract individual "result blocks" from the search results text.
 *
 * NHS changed the old "Result for ... End of result for ..." markers.
 * We now anchor blocks around "Vxxxxxx DEN" which is present in your observed output.
 */
function extractResultBlocks(text) {
  if (!text) return [];

  const rx = /V\d{6}\s+DEN/gi;
  const blocks = [];
  const seen = new Set();
  let m;

  while ((m = rx.exec(text)) !== null) {
    const idx = m.index;

    // capture a bit before (so we include "Within X mile") and after (name + address)
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + 700);
    const snippet = text.slice(start, end).trim();

    const v = extractVCodeFromBlock(snippet);
    if (!v || seen.has(v)) continue;
    seen.add(v);

    blocks.push(`Result for ${snippet}`);
  }

  return blocks;
}

/**
 * Parse patient type from block/appointments text:
 *   - Adults & children
 *   - Children only
 *   - Adults only
 */
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

/**
 * Classify acceptance status from NHS *appointments* page text.
 */
function classifyAcceptanceFromAppointments(lower) {
  if (!lower) return "unknown";

  // Not accepting
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";
  if (lower.includes("is not taking on any new nhs patients")) return "notAccepting";
  if (lower.includes("is not currently taking on new nhs patients"))
    return "notAccepting";

  // No update
  if (
    lower.includes(
      "has not given a recent update on whether they're taking new nhs patients"
    ) ||
    lower.includes(
      "has not given a recent update on whether they are taking new nhs patients"
    )
  ) {
    return "unknown";
  }

  // Accepting (keep wide net — NHS wording varies)
  if (
    lower.includes(
      "when availability allows, this dentist accepts new nhs patients"
    )
  )
    return "accepting";
  if (lower.includes("accepts new nhs patients")) return "accepting";
  if (lower.includes("accepting new nhs patients")) return "accepting";
  if (lower.includes("taking on new nhs patients")) return "accepting";
  if (lower.includes("is taking new nhs patients")) return "accepting";
  if (lower.includes("accepting new adult nhs patients")) return "accepting";
  if (lower.includes("accepting new child nhs patients")) return "accepting";
  if (
    lower.includes(
      "only taking new nhs patients for specialist dental care by referral"
    )
  )
    return "accepting";

  return "unknown";
}

/**
 * Fallback classifier based on the search-results block text.
 */
function classifyAcceptanceFromSearchBlock(lower) {
  if (!lower) return "unknown";

  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";

  if (
    lower.includes(
      "has not given a recent update on whether they're taking new nhs patients"
    )
  ) {
    return "unknown";
  }

  if (
    lower.includes(
      "when availability allows, this dentist accepts new nhs patients"
    )
  )
    return "accepting";
  if (lower.includes("accepts new nhs patients")) return "accepting";
  if (lower.includes("accepting new nhs patients")) return "accepting";
  if (lower.includes("taking on new nhs patients")) return "accepting";
  if (lower.includes("is taking new nhs patients")) return "accepting";
  if (lower.includes("accepting new adult nhs patients")) return "accepting";
  if (lower.includes("accepting new child nhs patients")) return "accepting";

  return "unknown";
}

function extractPhoneFromBlock(text) {
  if (!text) return "Not available";
  const match = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return match ? match[0].trim() : "Not available";
}

/**
 * Parse distance text into numeric miles.
 * Supports:
 *  - "This organisation is 1 mile away"
 *  - "Within 1 mile"
 *  - "2.3 miles"
 */
function parseDistanceMiles(distanceText) {
  if (!distanceText) return null;

  let m =
    distanceText.match(/Within\s+([\d.,]+)\s*miles?/i) ||
    distanceText.match(/([\d.,]+)\s*miles?/i);

  if (!m) return null;
  const raw = m[1].replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build NHS profile URL from practice name + V-code.
 */
function buildNhsProfileUrl(name, rawBlock, vcodeFromPractice) {
  let vCode = vcodeFromPractice || null;

  if (!vCode) {
    const idMatch = rawBlock.match(/V\d{6}/i);
    if (!idMatch) return "";
    vCode = idMatch[0].toUpperCase();
  }

  let cleanedName = name
    .replace(/&nbsp;?/gi, " ")
    .replace(/\bandnbsp\b/gi, " ")
    .trim();

  const slug = cleanedName
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return `https://www.nhs.uk/services/dentist/${slug}/${vCode}`;
}

/**
 * Parse a single result block into a base practice object.
 * NHS now frequently looks like:
 *   "Within 1 mile V006578 DEN Winnersh Dental Practice 410, READING ROAD, ... RG41 5EP"
 */
function parsePracticeFromBlock(block, postcode) {
  const lower = block.toLowerCase();

  // Name
  let name = "Unknown practice";

  // Primary (older): "Result for <name>"
  const nameMatch = block.match(
    /Result for\s+(.+?)(?=\s{2,}|This organisation is|Address for this organisation is|Phone:|$)/i
  );
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  // New fallback: "V006578 DEN Winnersh Dental Practice"
  if (name === "Unknown practice") {
    const m = block.match(/V\d{6}\s+DEN\s+(.+?)(?=\s+\d|,|\s+Within| Address| Phone|$)/i);
    if (m) name = m[1].trim();
  }

  name = name.replace(/\s+V\d{6}\s+DEN$/i, "").trim();

  // Distance text
  let distanceText = "";
  const distOld = block.match(/This organisation is\s+(.+?)\s+away/i);
  if (distOld) {
    distanceText = distOld[1].trim();
  } else {
    const within = block.match(/Within\s+([\d.,]+\s+miles?)/i);
    if (within) distanceText = within[0].trim(); // keep "Within 1 mile"
  }
  const distanceMiles = parseDistanceMiles(distanceText);

  // Address (best-effort)
  let address = "";
  const addrMatch = block.match(
    /DEN\s+.+?\s+(.+?)(?:Phone:|This dentist surgery|When availability allows|Not accepting new NHS patients|has not given a recent update|$)/i
  );
  if (addrMatch) {
    address = addrMatch[1].trim();
  }

  const phone = extractPhoneFromBlock(block);
  const vcode = extractVCodeFromBlock(block);
  const { patientType, childOnly } = parsePatientType(lower);

  const nhsUrl = buildNhsProfileUrl(name, block, vcode) || "";
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

/**
 * Simple concurrency pool (no deps)
 */
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

/**
 * Core scanner: postcode + radius -> classify practices by acceptance status.
 */
export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const radius = Number(radiusMiles) || 5;

  console.log(
    `[SCAN] (v7.4) Searching NHS for ${postcode} (${radius} miles) – ${buildNhsSearchUrl(
      postcode,
      radius
    )}`
  );

  const searchUrl = buildNhsSearchUrl(postcode, radius);
  const html = await fetchText(searchUrl, "search");
  const text = htmlToText(html);

  const blocks = extractResultBlocks(text);

  console.log(
    `[SCAN] (v7.4) Parsed ${blocks.length} result block(s) from search results.`
  );

  const basePracticesRaw = blocks.map((block) => {
    const p = parsePracticeFromBlock(block, postcode);
    return { practice: p, searchLower: block.toLowerCase() };
  });

  const RADIUS_TOLERANCE = 0.2;
  const basePractices = basePracticesRaw.filter(({ practice }) => {
    if (practice.distanceMiles == null || isNaN(practice.distanceMiles)) return true;
    return practice.distanceMiles <= radius + RADIUS_TOLERANCE;
  });

  console.log(
    `[SCAN] (v7.4) After radius filter (${radius} mi): kept ${basePractices.length}/${basePracticesRaw.length} practices.`
  );

  // Appointments fetch with concurrency limit (protects you + NHS)
  const concurrency = Number(process.env.SCAN_APPT_CONCURRENCY) || 4;

  const enriched = await runPool(basePractices, concurrency, async (item) => {
    const p = item.practice;
    const searchLower = item.searchLower;

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

    if (finalStatus === "unknown") {
      finalStatus = classifyAcceptanceFromSearchBlock(searchLower);
    }

    p.status = finalStatus;
    return p;
  });

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const p of enriched) {
    if (p.status === "accepting") accepting.push(p);
    else if (p.status === "notAccepting") notAccepting.push(p);
    else unknown.push(p);
  }

  const tookMs = Date.now() - started;

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
    tookMs,
  };

  console.log("[SCAN] (v7.4) Result summary:", {
    postcode: result.postcode,
    radiusMiles: result.radiusMiles,
    accepting: result.acceptingCount,
    notAccepting: result.notAcceptingCount,
    unknown: result.unknownCount,
    scanned: result.scanned,
    tookMs: result.tookMs,
  });

  return result;
}
