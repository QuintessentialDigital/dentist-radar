// nhs-snapshot.js (FULL FILE - appointments-first + strict classification)
//
// Fixes:
// 1) Only processes valid dentist V-codes (V123456)
// 2) Builds correct NHS dentist URL using slug + V-code
// 3) Fetches /appointments FIRST (more reliable for "confirmed / not confirmed")
// 4) Strict classifier that treats "has not confirmed..." as UNKNOWN
// 5) Removes overly-broad "accepting + nhs" rule that caused false positives
// 6) Never leaves nhsUrl empty on failure (stores attempted url)

const axios = require("axios");
const PracticeOds = require("../models/PracticeOds");
const PracticeStatusLatest = require("../models/PracticeStatusLatest");
const PracticeStatusEvent = require("../models/PracticeStatusEvent");

const UA =
  process.env.CRAWLER_USER_AGENT ||
  "HealthRadar/DentistRadar snapshot bot (contact: admin@yourdomain)";

const VCODE_REGEX = /^V\d{6}$/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function toSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStatusFromText(allText) {
  const t = String(allText || "").toLowerCase().replace(/\s+/g, " ");

  // ---- Explicit "not confirmed" → UNKNOWN (avoid false positives)
  if (t.includes("has not confirmed whether they are accepting new nhs patients"))
    return "unknown";
  if (t.includes("has not confirmed") && t.includes("accepting new nhs patients"))
    return "unknown";
  if (t.includes("not confirmed") && t.includes("accepting new nhs patients"))
    return "unknown";

  // ---- Strong negatives
  if (t.includes("not accepting new nhs patients")) return "not_accepting";
  if (t.includes("not taking on new nhs patients")) return "not_accepting";
  if (t.includes("currently not accepting nhs patients")) return "not_accepting";
  if (t.includes("not accepting nhs patients")) return "not_accepting";

  // ---- Strong positives (only explicit/standard phrasing)
  if (t.includes("when availability allows, this dentist accepts new nhs patients"))
    return "accepting";
  if (t.includes("accepting new nhs patients")) return "accepting";
  if (t.includes("accepts new nhs patients")) return "accepting";
  if (t.includes("taking on new nhs patients")) return "accepting";

  return "unknown";
}

function extractEvidenceSnippet(htmlOrText) {
  const plain = stripHtml(htmlOrText);
  const lower = plain.toLowerCase();

  const needles = [
    "has not confirmed",
    "not accepting new nhs patients",
    "not taking on new nhs patients",
    "accepting new nhs patients",
    "accepts new nhs patients",
    "when availability allows",
  ];

  let idx = -1;
  for (const n of needles) {
    idx = lower.indexOf(n);
    if (idx !== -1) break;
  }

  if (idx === -1) return "";
  return plain.slice(Math.max(0, idx - 140), Math.min(plain.length, idx + 260));
}

async function fetchWithAxios(url) {
  const res = await axios.get(url, {
    timeout: Number(process.env.HTTP_TIMEOUT_MS || 25000),
    maxRedirects: 5,
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-GB,en;q=0.9",
    },
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const html = res.data || "";
  const finalUrl = res.request?.res?.responseUrl || url;
  return { html, finalUrl };
}

async function fetchPracticePage(code, name) {
  const slug = toSlug(name);

  const urlSlug = slug
    ? `https://www.nhs.uk/services/dentist/${slug}/${encodeURIComponent(code)}`
    : null;

  // Fallback (may or may not work for all)
  const urlDirect = `https://www.nhs.uk/services/dentist/${encodeURIComponent(code)}`;

  const urls = [urlSlug, urlDirect].filter(Boolean);

  let lastErr;
  for (const url of urls) {
    try {
      return await fetchWithAxios(url);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchAppointmentsPage(code, name) {
  const slug = toSlug(name);

  const url = slug
    ? `https://www.nhs.uk/services/dentist/${slug}/${encodeURIComponent(
        code
      )}/appointments`
    : `https://www.nhs.uk/services/dentist/${encodeURIComponent(code)}/appointments`;

  return await fetchWithAxios(url);
}

function canonicalBaseUrl(url) {
  return String(url || "").replace(/\/appointments\/?$/, "");
}

async function selectBatch(batchSize) {
  // Only consider checked V-codes
  const checkedCodes = await PracticeStatusLatest.find({
    code: { $regex: VCODE_REGEX },
  })
    .select({ code: 1 })
    .lean();

  const checkedSet = new Set(checkedCodes.map((x) => x.code));

  // First: V-code practices never checked
  const neverChecked = await PracticeOds.find({
    code: { $regex: VCODE_REGEX, $nin: Array.from(checkedSet) },
  })
    .limit(batchSize)
    .lean();

  if (neverChecked.length >= batchSize) {
    return neverChecked;
  }

  // If we need more, re-check oldest (V-codes only)
  const oldest = await PracticeStatusLatest.find({
    code: { $regex: VCODE_REGEX },
  })
    .sort({ checkedAt: 1 })
    .limit(batchSize - neverChecked.length)
    .lean();

  const oldestCodes = oldest.map((x) => x.code);

  const oldestPractices = await PracticeOds.find({
    code: { $regex: VCODE_REGEX, $in: oldestCodes },
  }).lean();

  return [...neverChecked, ...oldestPractices];
}

async function runNhsSnapshotBatch() {
  const batchSize = Number(process.env.BATCH_SIZE || 200);
  const rateMin = Number(process.env.RATE_MIN_MS || 800);
  const rateMax = Number(process.env.RATE_MAX_MS || 1600);

  const batch = await selectBatch(batchSize);
  const checkedAt = new Date();

  let okCount = 0;
  let errCount = 0;
  let skippedNonV = 0;

  for (const p of batch) {
    const code = p.code;

    if (!code || !VCODE_REGEX.test(code)) {
      skippedNonV++;
      continue;
    }

    await sleep(randBetween(rateMin, rateMax));

    let status = "unknown";
    let nhsUrl = "";
    let evidence = "";
    let ok = true;
    let error = "";

    try {
      // 1) Appointments page first (most reliable for "confirmed")
      const { html: apptHtml, finalUrl: apptFinalUrl } =
        await fetchAppointmentsPage(code, p.name);

      nhsUrl = canonicalBaseUrl(apptFinalUrl);
      status = normalizeStatusFromText(stripHtml(apptHtml));
      evidence = extractEvidenceSnippet(apptHtml);

      // 2) Fallback: if still unknown, try main page
      if (status === "unknown") {
        const { html: mainHtml, finalUrl } = await fetchPracticePage(code, p.name);
        nhsUrl = finalUrl;
        const status2 = normalizeStatusFromText(stripHtml(mainHtml));
        if (status2 !== "unknown") {
          status = status2;
          evidence = extractEvidenceSnippet(mainHtml);
        }
      }
    } catch (e) {
      ok = false;
      error = String(e?.message || e).slice(0, 500);
      status = "unknown";

      const slug = toSlug(p.name);
      nhsUrl = slug
        ? `https://www.nhs.uk/services/dentist/${slug}/${code}`
        : `https://www.nhs.uk/services/dentist/${code}`;
    }

    const latestDoc = {
      code,
      name: p.name || "",
      postcode: p.postcode || "",
      // Region fields should come from PracticeOds enrichment if present
      region: p.nhsEnglandRegion || p.region || "Unknown",
      nhsUrl,
      status,
      statusEvidence: evidence,
      checkedAt,
      ok,
      error,
    };

    await PracticeStatusLatest.updateOne(
      { code },
      { $set: latestDoc },
      { upsert: true }
    );

    await PracticeStatusEvent.create({
      code,
      region: p.nhsEnglandRegion || p.region || "Unknown",
      status,
      checkedAt,
      nhsUrl,
      ok,
      error,
    });

    if (ok) okCount++;
    else errCount++;
  }

  return { batchSize: batch.length, okCount, errCount, skippedNonV, checkedAt };
}

module.exports = { runNhsSnapshotBatch };
