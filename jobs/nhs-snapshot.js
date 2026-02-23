// nhs-snapshot.js (FULL FILE - fixed)
// Fixes:
// 1) Only processes valid dentist V-codes (V123456)
// 2) Builds the correct NHS dentist URL using slug + V-code
// 3) Falls back to /services/dentist/<VCODE> (in case NHS supports redirect)
// 4) Never leaves nhsUrl empty on failure (stores attempted url)
// 5) Keeps your existing status + evidence logic

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

function normalizeStatusFromText(allText) {
  const t = String(allText || "").toLowerCase().replace(/\s+/g, " ");

  // Strong negative first
  if (t.includes("not accepting") && t.includes("nhs")) return "not_accepting";
  if (t.includes("not taking on") && t.includes("nhs")) return "not_accepting";
  if (t.includes("currently not accepting") && t.includes("nhs"))
    return "not_accepting";

  // Positive
  if (
    t.includes("accepting") &&
    t.includes("nhs") &&
    !t.includes("not accepting")
  )
    return "accepting";
  if (t.includes("accepts new nhs patients")) return "accepting";
  if (t.includes("accepting new nhs patients")) return "accepting";
  if (t.includes("taking on new nhs patients")) return "accepting";

  return "unknown";
}

function extractEvidenceSnippet(html) {
  const plain = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Try to capture around "nhs"
  const lower = plain.toLowerCase();
  const idx =
    lower.indexOf("accepting") !== -1
      ? lower.indexOf("accepting")
      : lower.indexOf("nhs");

  if (idx === -1) return "";
  return plain.slice(Math.max(0, idx - 120), Math.min(plain.length, idx + 220));
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

  // Fallback (may redirect for some, may 404 for others)
  const urlDirect = `https://www.nhs.uk/services/dentist/${encodeURIComponent(
    code
  )}`;

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

    // Safety: skip non V-codes
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
      const { html, finalUrl } = await fetchPracticePage(code, p.name);
      nhsUrl = finalUrl;
      status = normalizeStatusFromText(html);
      evidence = extractEvidenceSnippet(html);
    } catch (e) {
      ok = false;
      error = String(e?.message || e).slice(0, 500);
      status = "unknown";
      // Never leave empty — helps debugging
      const slug = toSlug(p.name);
      nhsUrl = slug
        ? `https://www.nhs.uk/services/dentist/${slug}/${code}`
        : `https://www.nhs.uk/services/dentist/${code}`;
    }

    const latestDoc = {
      code,
      name: p.name || "",
      postcode: p.postcode || "",
      region: p.region || "Unknown",
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
      region: p.region || "Unknown",
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
