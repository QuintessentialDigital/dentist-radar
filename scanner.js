// scanner.js – DentistRadar NHS scanner (v8.0 – production stable)
//
// Final production-stable version:
// - Robust block splitting (one block per Vxxxxxx DEN)
// - Clean name extraction
// - Clean address extraction
// - Supports "Within X mile(s)"
// - Keeps proven acceptance logic
// - Concurrency limited appointments fetch

import "dotenv/config";

/* ---------------- URL BUILD ---------------- */

function buildNhsSearchUrl(postcode, radiusMiles) {
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

/* ---------------- FETCH ---------------- */

async function fetchText(url, label = "fetch") {
  const timeoutMs = Number(process.env.SCAN_TIMEOUT_MS) || 12000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          process.env.SCAN_UA ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
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
    console.error(`[SCAN] ${label} error`, err?.message);
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

/* ---------------- BLOCK EXTRACTION ---------------- */

function extractResultBlocks(text) {
  if (!text) return [];

  const anchorRegex = /V\d{6}\s+DEN/gi;
  const anchors = [];
  let m;

  while ((m = anchorRegex.exec(text)) !== null) {
    anchors.push(m.index);
  }

  if (anchors.length === 0) return [];

  const blocks = [];

  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1] : text.length;

    let snippet = text.slice(start, end).trim();

    // attach nearest "Within X mile(s)" before anchor
    const prefixStart = Math.max(0, start - 120);
    const prefix = text.slice(prefixStart, start);
    const within = prefix.match(/Within\s+[\d.,]+\s+miles?/i);
    if (within) {
      snippet = `${within[0]} ${snippet}`;
    }

    blocks.push(snippet);
  }

  return blocks;
}

/* ---------------- HELPERS ---------------- */

function extractVCode(text) {
  const m = text.match(/V\d{6}/i);
  return m ? m[0].toUpperCase() : null;
}

function extractPhone(text) {
  const m = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return m ? m[0].trim() : "Not available";
}

function parseDistance(text) {
  const m =
    text.match(/Within\s+([\d.,]+)\s*miles?/i) ||
    text.match(/([\d.,]+)\s*miles?/i);

  if (!m) return { text: "", miles: null };

  const miles = parseFloat(m[1].replace(",", "."));
  return {
    text: m[0],
    miles: Number.isFinite(miles) ? miles : null,
  };
}

/* ---------------- ACCEPTANCE LOGIC ---------------- */

function classifyAcceptance(lower) {
  if (!lower) return "unknown";

  if (lower.includes("not accepting new nhs patients")) return "notAccepting";
  if (lower.includes("not taking on new nhs patients")) return "notAccepting";
  if (lower.includes("currently not accepting nhs patients")) return "notAccepting";

  if (
    lower.includes(
      "when availability allows, this dentist accepts new nhs patients"
    )
  )
    return "accepting";
  if (lower.includes("accepts new nhs patients")) return "accepting";
  if (lower.includes("accepting new nhs patients")) return "accepting";
  if (lower.includes("taking on new nhs patients")) return "accepting";

  return "unknown";
}

/* ---------------- PARSE PRACTICE ---------------- */

function parsePractice(block, postcode) {
  const lower = block.toLowerCase();

  const vcode = extractVCode(block);

  // NAME
  let name = "Unknown practice";
  const nameMatch = block.match(
    /V\d{6}\s+DEN\s+(.+?)(?=\s+\d|,\s*\d|\s+Phone:|\s+View dentist details|\s+When availability allows|\s+Not accepting new NHS patients|$)/i
  );
  if (nameMatch) name = nameMatch[1].trim();

  // DISTANCE
  const dist = parseDistance(block);

  // ADDRESS
  let address = "";
  const addrMatch = block.match(
    /V\d{6}\s+DEN\s+.+?\s+(.+?)(?=\s+Phone:|\s+View dentist details|\s+When availability allows|\s+Not accepting new NHS patients|\s+Within\s|$)/i
  );
  if (addrMatch) address = addrMatch[1].trim();

  const phone = extractPhone(block);

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
    distanceText: dist.text,
    distanceMiles: dist.miles,
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

  const searchUrl = buildNhsSearchUrl(postcode, radius);
  console.log(`[SCAN] Searching NHS for ${postcode} (${radius}mi)`);

  const html = await fetchText(searchUrl, "search");
  const text = htmlToText(html);

  const blocks = extractResultBlocks(text);
  console.log(`[SCAN] Parsed ${blocks.length} practices`);

  const parsed = blocks.map((b) => parsePractice(b, postcode));

  const filtered = parsed.filter((p) => {
    if (!p.distanceMiles) return true;
    return p.distanceMiles <= radius + 0.2;
  });

  const concurrency = Number(process.env.SCAN_APPT_CONCURRENCY) || 4;

  const enriched = await runPool(filtered, concurrency, async (p) => {
    if (!p.appointmentsUrl) return p;

    const apptHtml = await fetchText(p.appointmentsUrl, "appointments");
    const lower = htmlToText(apptHtml).toLowerCase();

    p.status = classifyAcceptance(lower);
    return p;
  });

  const accepting = enriched.filter((p) => p.status === "accepting");
  const notAccepting = enriched.filter((p) => p.status === "notAccepting");
  const unknown = enriched.filter((p) => p.status === "unknown");

  return {
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
}
