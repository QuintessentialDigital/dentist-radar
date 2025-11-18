// scanner.js – DentistRadar NHS scanner (v6 – results-page based, enriched)
//
// Exports:
//   - scanPostcode(postcode, radiusMiles)
//       -> {
//            postcode, radiusMiles,
//            acceptingCount, notAcceptingCount, unknownCount,
//            scanned,
//            accepting: [ { name, address, phone, distanceText, status, patientType, childOnly, nhsUrl } ],
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
 * Parse patient type from block text:
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
 * Classify acceptance status from the result block text.
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
    return "accepting";

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
 * Build NHS profile URL from the practice name and the V-code in the block.
 * Example:
 *   Name: "Winnersh Dental Practice"
 *   Block contains: "V006578 DEN"
 *   URL: https://www.nhs.uk/services/dentist/winnersh-dental-practice-v006578
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

  // Correct NHS pattern:
  //   /services/dentist/{slug}/{VCODE}
  return `https://www.nhs.uk/services/dentist/${slug}/${vCode}`;
}



/**
 * Parse a single result block into a practice object.
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
  const phone = extractPhoneFromBlock(block);

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
 * using ONLY the search results page text (no appointments pages),
 * and building NHS profile URLs from the V-code.
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

  blocks.forEach((block) => {
    const practice = parsePracticeFromBlock(block, postcode);
    practice.nhsUrl = buildNhsProfileUrl(practice.name, block);

    if (practice.status === "accepting") {
      accepting.push(practice);
    } else if (practice.status === "notAccepting") {
      notAccepting.push(practice);
    } else {
      unknown.push(practice);
    }
  });

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
