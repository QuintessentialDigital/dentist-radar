// scanner.js – DentistRadar pure NHS scanner (v3)
//
// Exports:
//   - scanPostcode(postcode, radiusMiles)
//       -> { postcode, radiusMiles, acceptingCount, notAcceptingCount, unknownCount,
//            scanned, accepting[], notAccepting[], unknown[], tookMs }
//
// No DB, no email here – server.js handles those.

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

  // Turn "RG414UW" -> "RG41 4UW"
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
    // Graceful behaviour: for 404/500 on search page, return empty HTML
    if (res.status === 404 || res.status === 500) {
      return "";
    }
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  return await res.text();
}

// Extract dentist profile links from search results
function extractPracticeLinks(searchHtml) {
  if (!searchHtml) return [];

  const links = new Set();

  // Look for /services/dentist/ URLs
  const regex = /href="(\/services\/dentist\/[^"]+)"/gi;
  let match;
  while ((match = regex.exec(searchHtml)) !== null) {
    const path = match[1];
    if (path.includes("/services/dentist/")) {
      links.add(`https://www.nhs.uk${path}`);
    }
  }

  const arr = Array.from(links);
  console.log(`[SCAN] Found ${arr.length} practice link(s) in search results.`);
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

function extractAppointmentsSection(detailHtml) {
  return (
    textBetween(detailHtml, "Appointments", "Back to top") ||
    textBetween(detailHtml, "Appointments", "Opening times")
  );
}

function classifyAcceptance(appointmentHtml = "") {
  if (!appointmentHtml) return "unknown";

  const text = appointmentHtml.toLowerCase();

  const acceptingPatterns = [
    "accepts new nhs patients",
    "currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "taking on new nhs patients",
    "is taking new nhs patients",
    "accepting new nhs patients",
    "accepting new adult nhs patients",
    "accepting new child nhs patients",
    "this dentist currently accepts new nhs patients",
  ];

  const notAcceptingPatterns = [
    "not accepting new nhs patients",
    "not taking on new nhs patients",
    "currently not accepting nhs patients",
    "not currently accepting new nhs patients",
    "this dentist is not taking on any new nhs patients",
  ];

  if (acceptingPatterns.some((p) => text.includes(p))) return "accepting";
  if (notAcceptingPatterns.some((p) => text.includes(p))) return "notAccepting";
  return "unknown";
}

/**
 * Core scanner: postcode + radius -> classify practices by acceptance status.
 */
export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const searchUrl = buildNhsSearchUrl(postcode, radiusMiles);
  console.log(
    `[SCAN] Searching NHS for ${postcode} (${radiusMiles} miles) – ${searchUrl}`
  );

  const searchHtml = await fetchText(searchUrl);
  const practiceLinks = extractPracticeLinks(searchHtml);

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const practiceUrl of practiceLinks) {
    try {
      await sleep(400); // be gentle with NHS
      const detailHtml = await fetchText(practiceUrl);
      if (!detailHtml) {
        console.warn(`[SCAN] Empty detail HTML for ${practiceUrl}`);
        continue;
      }

      const appointmentHtml = extractAppointmentsSection(detailHtml);
      const status = classifyAcceptance(appointmentHtml);

      const practice = {
        name: extractPracticeName(detailHtml),
        address: extractAddress(detailHtml),
        phone: extractPhone(detailHtml),
        nhsUrl: practiceUrl,
        // placeholders for fields your email template uses
        patientType: undefined, // can be set later from patterns if needed
        childOnly: false,
        distanceText: "", // distance isn't on detail page; could parse from searchHtml in future
        status,
      };

      if (status === "accepting") accepting.push(practice);
      else if (status === "notAccepting") notAccepting.push(practice);
      else unknown.push(practice);
    } catch (err) {
      console.error(
        `[SCAN] Error fetching practice ${practiceUrl}:`,
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
    scanned: practiceLinks.length,
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
