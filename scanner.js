// scanner.js – DentistRadar NHS scanner (v7.1 – search + appointments, strict radius)
//
// Exports:
//   - scanPostcode(postcode, radiusMiles)
//       -> {
//            postcode, radiusMiles,
//            acceptingCount, notAcceptingCount, unknownCount,
//            scanned,
//            accepting: [ { name, address, phone, distanceText, distanceMiles, status, patientType, childOnly, nhsUrl, appointmentsUrl } ],
//            notAccepting: [...],
//            unknown: [...],
//            tookMs
//          }

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

async function fetchText(url, label = "fetch") {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (DentistRadar scanner)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      console.error(`[SCAN] ${label} failed ${res.status} for ${url}`);
      // For 404/500, behave like "no content" instead of crashing
      if (res.status === 404 || res.status === 500) {
        return "";
      }
      throw new Error(`${label} failed ${res.status} for ${url}`);
    }

    return await res.text();
  } catch (err) {
    console.error(`[SCAN] ${label} error for ${url}:`, err?.message || err);
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
 */
function extractResultBlocks(text) {
  if (!text) return [];

  const blocks = [];
  const regex = /Result for\s+([\s\S]*?)(?=End of result for|Result for\s+|$)/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const body = match[1].trim();
    if (!body) continue;
    const block = `Result for ${body}`;
    blocks.push(block);
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
 * We treat this as the primary source of truth.
 */
function classifyAcceptanceFromAppointments(lower) {
  if (!lower) return "unknown";

  // Not accepting patterns
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";
  if (lower.includes("is not taking on any new nhs patients")) return "notAccepting";
  if (lower.includes("is not currently taking on new nhs patients"))
    return "notAccepting";

  // Unknown / no update patterns
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

  // Accepting patterns
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
 * Used only if appointments page is unavailable or unclear.
 */
function classifyAcceptanceFromSearchBlock(lower) {
  if (!lower) return "unknown";

  // Not accepting patterns
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients")) return "notAccepting";
  if (lower.includes("this dentist is not taking on any new nhs patients"))
    return "notAccepting";
  if (lower.includes("this dentist is not currently taking on new nhs patients"))
    return "notAccepting";

  // Unknown / no update patterns
  if (
    lower.includes(
      "has not given a recent update on whether they're taking new nhs patients"
    )
  ) {
    return "unknown";
  }

  // Accepting patterns
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

/**
 * Extract a UK-looking phone number from a block of text.
 */
function extractPhoneFromBlock(text) {
  if (!text) return "Not available";
  const match = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return match ? match[0].trim() : "Not available";
}

/**
 * Parse distance text ("1 mile", "2.3 miles") into a numeric miles value.
 */
function parseDistanceMiles(distanceText) {
  if (!distanceText) return null;
  const m = distanceText.match(/([\d.,]+)\s*mile/i);
  if (!m) return null;
  const raw = m[1].replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build NHS profile URL from the practice name and the V-code in the block.
 * Example:
 *   Name: "Winnersh Dental Practice"
 *   Block contains: "V006578 DEN"
 *   URL: https://www.nhs.uk/services/dentist/winnersh-dental-practice/v006578
 */
function buildNhsProfileUrl(name, rawBlock) {
  // Find the V-code, e.g. "V186502"
  const idMatch = rawBlock.match(/V\d{6}/i);
  if (!idMatch) return "";

  const vCode = idMatch[0].toUpperCase(); // "V186502"

  // Clean HTML entities like &nbsp; and artefacts like "andnbsp"
  let cleanedName = name
    .replace(/&nbsp;?/gi, " ")
    .replace(/\bandnbsp\b/gi, " ")
    .trim();

  // Slugify the practice name
  const slug = cleanedName
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // NHS pattern:
  //   /services/dentist/{slug}/{VCODE}
  return `https://www.nhs.uk/services/dentist/${slug}/${vCode}`;
}

/**
 * Parse a single result block into a base practice object (without final status yet).
 */
function parsePracticeFromBlock(block, postcode) {
  const lower = block.toLowerCase();

  // Name (includes V-code in the raw text, which we strip after)
  let name = "Unknown practice";
  const nameMatch = block.match(
    /Result for\s+(.+?)(?=\s{2,}|This organisation is|Address for this organisation is|Phone:|$)/i
  );
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  // Strip trailing "V006578 DEN" style codes from display name
  name = name.replace(/\s+V\d{6}\s+DEN$/i, "").trim();

  // Distance (text)
  let distanceText = "";
  const distMatch = block.match(/This organisation is\s+(.+?)\s+away/i);
  if (distMatch) {
    distanceText = distMatch[1].trim(); // e.g. "1 mile" or "7.2 miles"
  }

  // Parse numeric distance (miles) if possible
  const distanceMiles = parseDistanceMiles(distanceText);

  // Address
  let address = "";
  const addrMatch = block.match(
    /Address for this organisation is\s+(.+?)(?:Phone:|This dentist surgery|When availability allows|Not accepting new NHS patients|has not given a recent update|End of result for|$)/i
  );
  if (addrMatch) {
    address = addrMatch[1].trim();
  }

  // Phone
  const phone = extractPhoneFromBlock(block);

  const { patientType, childOnly } = parsePatientType(lower);

  return {
    name,
    address,
    phone,
    distanceText,
    distanceMiles, // numeric for filtering + fallback rendering
    status: "unknown", // placeholder; will be filled after appointments scan
    patientType,
    childOnly,
    postcode: postcode || "",
    nhsUrl: "", // placeholder; set next
    appointmentsUrl: "",
  };
}

/**
 * Core scanner: postcode + radius -> classify practices by acceptance status.
 *
 * Algorithm:
 *   1) Fetch NHS search results page.
 *   2) Parse into result blocks.
 *   3) Build base practice objects + NHS profile URLs.
 *   4) STRICT RADIUS: drop practices whose distanceMiles > radiusMiles (if distance known).
 *   5) For each remaining practice, fetch its Appointments page (primary truth for acceptance).
 *   6) Classify from appointments; fallback to search block if still unknown.
 *   7) Return grouped lists + counts.
 */
export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const radius = Number(radiusMiles) || 5;
  const searchUrl = buildNhsSearchUrl(postcode, radius);
  console.log(
    `[SCAN] (v7.1) Searching NHS for ${postcode} (${radius} miles) – ${searchUrl}`
  );

  // Step 1: search results
  const html = await fetchText(searchUrl, "search");
  const text = htmlToText(html);
  const blocks = extractResultBlocks(text);

  console.log(
    `[SCAN] (v7.1) Parsed ${blocks.length} result block(s) from search results.`
  );

  // Step 2: build base practices
  const basePracticesRaw = blocks.map((block) => {
    const p = parsePracticeFromBlock(block, postcode);
    p.nhsUrl = buildNhsProfileUrl(p.name, block) || "";
    if (p.nhsUrl) {
      p.appointmentsUrl = `${p.nhsUrl.replace(/\/$/, "")}/appointments-and-opening-times`;
    } else {
      p.appointmentsUrl = "";
    }
    // Keep the lowercased search text for fallback classification
    return { practice: p, searchLower: block.toLowerCase() };
  });

  // Step 3: strict radius filter
  // - Keep practices where distanceMiles is null (NHS didn’t specify, we keep them just in case).
  // - Drop only those where distanceMiles > radius (+ small tolerance).
  const RADIUS_TOLERANCE = 0.2; // 0.2 miles tolerance to avoid float weirdness
  const basePractices = basePracticesRaw.filter(({ practice }) => {
    if (practice.distanceMiles == null || isNaN(practice.distanceMiles)) {
      return true; // keep if distance unknown
    }
    return practice.distanceMiles <= radius + RADIUS_TOLERANCE;
  });

  console.log(
    `[SCAN] (v7.1) After radius filter (${radius} mi): kept ${basePractices.length}/${basePracticesRaw.length} practices.`
  );

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  // Step 4: For each practice, try to refine status using appointments page
  for (const item of basePractices) {
    const p = item.practice;
    const searchLower = item.searchLower;

    let finalStatus = "unknown";

    if (p.appointmentsUrl) {
      const apptHtml = await fetchText(p.appointmentsUrl, "appointments");
      const apptText = htmlToText(apptHtml).toLowerCase();

      if (apptText) {
        const classified = classifyAcceptanceFromAppointments(apptText);
        finalStatus = classified;

        // Optionally refine patient type from appointments text too
        const { patientType, childOnly } = parsePatientType(apptText);
        if (patientType !== "Unknown") {
          p.patientType = patientType;
          p.childOnly = childOnly;
        }
      }
    }

    // If still unknown after appointments, fallback to search block classification
    if (finalStatus === "unknown") {
      finalStatus = classifyAcceptanceFromSearchBlock(searchLower);
    }

    p.status = finalStatus;

    if (finalStatus === "accepting") {
      accepting.push(p);
    } else if (finalStatus === "notAccepting") {
      notAccepting.push(p);
    } else {
      unknown.push(p);
    }
  }

  const tookMs = Date.now() - started;

  const result = {
    postcode,
    radiusMiles: radius,
    acceptingCount: accepting.length,
    notAcceptingCount: notAccepting.length,
    unknownCount: unknown.length,
    scanned: basePractices.length,
    accepting,
    notAccepting,
    unknown,
    tookMs,
  };

  console.log("[SCAN] (v7.1) Result summary:", {
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
