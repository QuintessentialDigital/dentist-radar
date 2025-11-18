// scanner.js – DentistRadar NHS scanner (v4 – appointments-based)
//
// Exports:
//   - scanPostcode(postcode, radiusMiles)
//       -> {
//            postcode, radiusMiles,
//            acceptingCount, notAcceptingCount, unknownCount,
//            scanned,
//            accepting: [ { name, address, phone, nhsUrl, distanceText, status } ],
//            notAccepting: [...],
//            unknown: [...],
//            tookMs
//          }
//
// Logic:
//   1) Build NHS search URL: /results/POSTCODE?distance=X
//   2) Fetch search HTML
//   3) Extract all /services/dentist/.../appointments links
//   4) For each appointments page:
//        - Parse name/address/phone
//        - Classify accepting/notAccepting/unknown from appointments text
//
// No DB / email here – server.js handles that.

import "dotenv/config";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    // Graceful behaviour: for 404/500, return empty HTML
    if (res.status === 404 || res.status === 500) {
      return "";
    }
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  return await res.text();
}

/**
 * Extract all appointments links from the search results page.
 *
 * We look for href="/services/dentist/.../appointments"
 */
function extractAppointmentLinks(searchHtml) {
  if (!searchHtml) return [];

  const links = new Set();

  const regex = /href="(\/services\/dentist\/[^"]*\/appointments)"/gi;
  let match;
  while ((match = regex.exec(searchHtml)) !== null) {
    const path = match[1];
    if (path.includes("/services/dentist/") && path.endsWith("/appointments")) {
      links.add(`https://www.nhs.uk${path}`);
    }
  }

  const arr = Array.from(links);
  console.log(
    `[SCAN] Found ${arr.length} appointments link(s) in search results.`
  );
  return arr;
}

function textBetween(html, startMarker, endMarker) {
  if (!html) return "";
  const lowerHtml = html.toLowerCase();
  const start = lowerHtml.indexOf(startMarker.toLowerCase());
  if (start === -1) return "";
  const end = lowerHtml.indexOf(
    endMarker.toLowerCase(),
    start + startMarker.length
  );
  const slice = end === -1 ? html.slice(start) : html.slice(start, end);
  return slice.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function stripTagsToText(html = "") {
  if (!html) return "";
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function extractPracticeName(detailHtml) {
  if (!detailHtml) return "Unknown practice";
  const match = detailHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return match ? match[1].trim() : "Unknown practice";
}

function extractAddress(detailHtml) {
  const block =
    textBetween(detailHtml, "Address", "Get directions") ||
    textBetween(detailHtml, "Address", "Opening times");
  return block || "Address not available";
}

// Simple UK phone extractor
function extractPhone(detailHtml) {
  if (!detailHtml) return "Not available";
  const text = detailHtml.replace(/<[^>]+>/g, " ");
  const phoneMatch = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return phoneMatch ? phoneMatch[0].trim() : "Not available";
}

/**
 * Extract the appointments section text from the appointments page.
 * We basically take the main content area and turn it into text.
 */
function extractAppointmentsText(appointmentsHtml) {
  // Keep it simple: strip to text and use classifier on that.
  return stripTagsToText(appointmentsHtml);
}

/**
 * Classify acceptance status from appointments text.
 * This is where we encode all the wording you shared from the appointments page.
 */
function classifyAcceptanceFromAppointmentsText(text = "") {
  if (!text) return "unknown";

  const lower = text.toLowerCase();

  const acceptingPatterns = [
    // Existing / older patterns
    "accepts new nhs patients",
    "currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "taking on new nhs patients",
    "is taking new nhs patients",
    "accepting new nhs patients",
    "accepting new adult nhs patients",
    "accepting new child nhs patients",
    "this dentist currently accepts new nhs patients",
    // Patterns you described for appointments page
    "this dentist currently accepts new nhs patients for routine dental care if they are",
    "when availability allows, this dentist accepts new nhs patients if they are",
    "when availability allows, this dentist accepts new adult nhs patients if they are",
    "when availability allows, this dentist accepts new child nhs patients if they are",
    // Specialist but still accepting via referral
    "only taking new nhs patients for specialist dental care by referral",
  ];

  const notAcceptingPatterns = [
    "not accepting new nhs patients",
    "not taking on new nhs patients",
    "currently not accepting nhs patients",
    "not currently accepting new nhs patients",
    "this dentist is not taking on any new nhs patients",
    "this dentist is not currently taking on new nhs patients",
  ];

  if (acceptingPatterns.some((p) => lower.includes(p))) return "accepting";
  if (notAcceptingPatterns.some((p) => lower.includes(p)))
    return "notAccepting";

  return "unknown";
}

/**
 * Core scanner: postcode + radius -> classify practices by acceptance status,
 * using ONLY the appointments page for acceptance.
 */
export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const searchUrl = buildNhsSearchUrl(postcode, radiusMiles);
  console.log(
    `[SCAN] Searching NHS for ${postcode} (${radiusMiles} miles) – ${searchUrl}`
  );

  const searchHtml = await fetchText(searchUrl);
  const appointmentLinks = extractAppointmentLinks(searchHtml);

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const apptUrl of appointmentLinks) {
    try {
      await sleep(400); // be gentle with NHS
      const appointmentsHtml = await fetchText(apptUrl);
      if (!appointmentsHtml) {
        console.warn(`[SCAN] Empty appointments HTML for ${apptUrl}`);
        continue;
      }

      const appointmentsText = extractAppointmentsText(appointmentsHtml);
      const status = classifyAcceptanceFromAppointmentsText(appointmentsText);

      // Use appointments page itself to get name/address/phone
      const name = extractPracticeName(appointmentsHtml);
      const address = extractAddress(appointmentsHtml);
      const phone = extractPhone(appointmentsHtml);

      // Derive main NHS page (without /appointments)
      let nhsUrl = apptUrl;
      if (nhsUrl.endsWith("/appointments")) {
        nhsUrl = nhsUrl.replace(/\/appointments\/?$/i, "");
      }

      const practice = {
        name,
        address,
        phone,
        nhsUrl,
        distanceText: "", // distance isn't on appointments page; could add later from searchHtml
        status,
      };

      if (status === "accepting") accepting.push(practice);
      else if (status === "notAccepting") notAccepting.push(practice);
      else unknown.push(practice);
    } catch (err) {
      console.error(
        `[SCAN] Error fetching appointments ${apptUrl}:`,
        err.message || err
      );
    }
  }

  const tookMs = Date.now() - started;

  const result = {
    postcode,
    radiusMiles: Number(radiusMiles) || 5,
    acceptingCount: accepting.length,
    notAcceptingCount: notAccepting.length,
    unknownCount: unknown.length,
    scanned: appointmentLinks.length,
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
