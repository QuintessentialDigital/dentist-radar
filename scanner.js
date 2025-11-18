// scanner.js – DentistRadar NHS scanner (v5 – results-page based with patient type)
//
// Exports:
//   - scanPostcode(postcode, radiusMiles)
//       -> {
//            postcode, radiusMiles,
//            acceptingCount, notAcceptingCount, unknownCount,
//            scanned,
//            accepting: [ { name, address, phone, distanceText, status, patientType, childOnly } ],
//            notAccepting: [...],
//            unknown: [...],
//            tookMs
//          }
//
// Logic:
//   1) Build NHS search URL: /results/POSTCODE?distance=X
//   2) Fetch search HTML
//   3) Convert to plain text
//   4) Split into "Result for ... End of result for ..." blocks
//   5) For each block:
//        - Parse name, distance, address, phone
//        - Classify accepting/notAccepting/unknown from wording
//        - Extract patientType (Adults & children, Children only, Adults only) + childOnly flag
//
// No DB / email here – server.js handles that.

import "dotenv/config";

/**
 * Build the NHS dentist search URL.
 *
 * NHS pattern (current):
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

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (DentistRadar scanner)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    console.error(`[SCAN] Fetch failed ${res.status} for ${url}`);
    // Graceful for 404/500 – behave like "no results"
    if (res.status === 404 || res.status === 500) {
      return "";
    }
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  return await res.text();
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
 * We expect repetitive patterns like:
 *   "Result for Winnersh Dental Practice ... End of result for Winnersh Dental Practice"
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
 * Parse patient type from a result block:
 *   - Adults & children
 *   - Children only
 *   - Adults only
 * Sets:
 *   patientType: string
 *   childOnly: boolean
 */
function parsePatientType(lowerText) {
  let patientType = "Unknown";
  let childOnly = false;

  const hasAdults =
    lowerText.includes("adults aged 18 or over") ||
    lowerText.includes("adult nhs patients");
  const hasChildren =
    lowerText.includes("children aged 0 to 17") ||
    lowerText.includes("children aged 0 to 18") ||
    lowerText.includes("children aged under 18") ||
    lowerText.includes("child nhs patients") ||
    lowerText.includes("children only");

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
 * Classify acceptance status from the result block text.
 * Uses the same phrases you'd see on the NHS results page.
 */
function classifyAcceptanceFromBlock(lower) {
  // Not accepting patterns
  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients"))
    return "notAccepting";
  if (lower.includes("not currently accepting new nhs patients"))
    return "notAccepting";
  if (
    lower.includes(
      "this dentist is not taking on any new nhs patients"
    )
  )
    return "notAccepting";
  if (
    lower.includes(
      "this dentist is not currently taking on new nhs patients"
    )
  )
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
  if (
    lower.includes(
      "only taking new nhs patients for specialist dental care by referral"
    )
  )
    return "accepting"; // still "accepting" from a discovery POV

  return "unknown";
}

/**
 * Parse a single result block into a practice object.
 */
function parsePracticeFromBlock(block, postcode) {
  const lower = block.toLowerCase();

  // Name
  let name = "Unknown practice";
  const nameMatch = block.match(
    /Result for\s+(.+?)(?=\s{2,}|This organisation is|Address for this organisation is|Phone:|$)/i
  );
  if (nameMatch) {
    name = nameMatch[1].trim();
  }

  // Distance
  let distanceText = "";
  const distMatch = block.match(
    /This organisation is\s+(.+?)\s+away/i
  );
  if (distMatch) {
    distanceText = distMatch[1].trim(); // e.g. "1 mile"
  }

  // Address
  let address = "";
  const addrMatch = block.match(
    /Address for this organisation is\s+(.+?)(?:Phone:|This dentist surgery|When availability allows|Not accepting new NHS patients|has not given a recent update|End of result for|$)/i
  );
  if (addrMatch) {
    address = addrMatch[1].trim();
  }

  // Phone
  let phone = "Not available";
  const phoneMatch = block.match(
    /Phone:\s*Phone number for this organisation is\s+([0-9 ()+]+?)(?:\s{2,}|$)/i
  );
  if (phoneMatch) {
    phone = phoneMatch[1].trim();
  }

  const { patientType, childOnly } = parsePatientType(lower);
  const status = classifyAcceptanceFromBlock(lower);

  return {
    name,
    address,
    phone,
    distanceText,
    status,
    patientType,
    childOnly,
    postcode: postcode || "",
  };
}

/**
 * Core scanner: postcode + radius -> classify practices by acceptance status,
 * using ONLY the search results page text (no appointments pages).
 */
export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const searchUrl = buildNhsSearchUrl(postcode, radiusMiles);
  console.log(
    `[SCAN] Searching NHS for ${postcode} (${radiusMiles} miles) – ${searchUrl}`
  );

  const html = await fetchText(searchUrl);
  const text = htmlToText(html);
  const blocks = extractResultBlocks(text);

  console.log(
    `[SCAN] Parsed ${blocks.length} result block(s) from search results.`
  );

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const block of blocks) {
    const practice = parsePracticeFromBlock(block, postcode);

    if (practice.status === "accepting") {
      accepting.push(practice);
    } else if (practice.status === "notAccepting") {
      notAccepting.push(practice);
    } else {
      unknown.push(practice);
    }
  }

  const tookMs = Date.now() - started;

  const result = {
    postcode,
    radiusMiles: Number(radiusMiles) || 5,
    acceptingCount: accepting.length,
    notAcceptingCount: notAccepting.length,
    unknownCount: unknown.length,
    scanned: blocks.length,
    accepting,
    notAccepting,
    unknown,
    tookMs,
  };

  console.log("[SCAN] Result summary:", {
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
