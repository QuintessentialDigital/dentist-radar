// nhs-snapshot.js (CANONICAL URL + practicevcodes source + appointments authoritative)

const axios = require("axios");

// IMPORTANT: swap source from ODS -> VCODE master
const PracticeVcode = require("../models/PracticeVcode");

const PracticeStatusLatest = require("../models/PracticeStatusLatest");
const PracticeStatusEvent = require("../models/PracticeStatusEvent");

const UA =
  process.env.CRAWLER_USER_AGENT ||
  "DentistRadar snapshot bot (contact: admin@yourdomain)";

const VCODE_REGEX = /^V\d{6}$/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { status, lock, reason }
// lock=true means "do NOT override this based on other pages"
function parseNhsAcceptance(allText) {
  const t = String(allText || "").toLowerCase().replace(/\s+/g, " ");

  // NOT ACCEPTING (strongest)
  if (/not\s+accepting\s+new\s+nhs\s+patients/.test(t))
    return { status: "not_accepting", lock: true, reason: "explicit_not_accepting" };

  if (/not\s+taking\s+on\s+new\s+nhs\s+patients/.test(t))
    return { status: "not_accepting", lock: true, reason: "explicit_not_taking_on" };

  if (/currently\s+not\s+accepting\s+nhs\s+patients/.test(t))
    return { status: "not_accepting", lock: true, reason: "explicit_currently_not" };

  // NOT CONFIRMED => UNKNOWN (absolute override)
  if (
    /(has\s+not\s+confirmed|hasn't\s+confirmed|not\s+confirmed)\b/.test(t) &&
    /new\s+nhs\s+patients/.test(t)
  ) {
    return { status: "unknown", lock: true, reason: "not_confirmed" };
  }

  // ACCEPTING (explicit only)
  if (/when\s+availability\s+allows.{0,80}accepts\s+new\s+nhs\s+patients/.test(t))
    return { status: "accepting", lock: true, reason: "availability_allows_accepts" };

  if (/accepting\s+new\s+nhs\s+patients/.test(t))
    return { status: "accepting", lock: true, reason: "explicit_accepting" };

  if (/accepts\s+new\s+nhs\s+patients/.test(t))
    return { status: "accepting", lock: true, reason: "explicit_accepts" };

  if (/taking\s+on\s+new\s+nhs\s+patients/.test(t))
    return { status: "accepting", lock: true, reason: "explicit_taking_on" };

  return { status: "unknown", lock: false, reason: "no_signal" };
}

function extractEvidenceSnippet(htmlOrText) {
  const plain = stripHtml(htmlOrText);
  const lower = plain.toLowerCase();

  const needles = [
    "has not confirmed",
    "hasn't confirmed",
    "not confirmed",
    "not accepting new nhs patients",
    "not taking on new nhs patients",
    "currently not accepting nhs patients",
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
  return plain.slice(Math.max(0, idx - 160), Math.min(plain.length, idx + 320));
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
  return { html, finalUrl, statusCode: res.status };
}

function canonicalBaseUrl(url) {
  return String(url || "").replace(/\/appointments\/?$/, "");
}

function safeBaseUrl(nhsUrl) {
  const u = String(nhsUrl || "").trim();
  if (!u) return "";
  return u.replace(/\/appointments\/?$/, "").replace(/\/+$/, "");
}

async function selectBatch(batchSize) {
  // Only consider checked V-codes
  const checkedCodes = await PracticeStatusLatest.find({
    code: { $regex: VCODE_REGEX },
  })
    .select({ code: 1 })
    .lean();

  const checkedSet = new Set(checkedCodes.map((x) => x.code));

  // First: practices never checked (from practicevcodes universe)
  const neverChecked = await PracticeVcode.find({
    vcode: { $regex: VCODE_REGEX, $nin: Array.from(checkedSet) },
  })
    .limit(batchSize)
    .lean();

  if (neverChecked.length >= batchSize) return neverChecked;

  // If we need more, re-check oldest
  const oldest = await PracticeStatusLatest.find({
    code: { $regex: VCODE_REGEX },
  })
    .sort({ checkedAt: 1 })
    .limit(batchSize - neverChecked.length)
    .lean();

  const oldestCodes = oldest.map((x) => x.code);

  const oldestPractices = await PracticeVcode.find({
    vcode: { $regex: VCODE_REGEX, $in: oldestCodes },
  }).lean();

  return [...neverChecked, ...oldestPractices];
}

async function runNhsSnapshotBatch() {

  const batchSizeEnv = parseInt(process.env.BATCH_SIZE || "", 10);
  const batchSize = Number.isFinite(batchSizeEnv) && batchSizeEnv > 0 ? batchSizeEnv : 200;

  const rateMinEnv = parseInt(process.env.RATE_MIN_MS || "", 10);
  const rateMin = Number.isFinite(rateMinEnv) && rateMinEnv >= 0 ? rateMinEnv : 900;

  const rateMaxEnv = parseInt(process.env.RATE_MAX_MS || "", 10);
  const rateMaxCandidate = Number.isFinite(rateMaxEnv) && rateMaxEnv >= 0 ? rateMaxEnv : 1800;
  const rateMax = Math.max(rateMin, rateMaxCandidate);

  console.log("[SNAP] Using batchSize/rate:", { batchSize, rateMin, rateMax });
  
  const batch = await selectBatch(batchSize);
  const checkedAt = new Date();

  let okCount = 0;
  let errCount = 0;
  let skippedNonV = 0;

  for (const p of batch) {
    const code = p.vcode || p.code; // safety
    if (!code || !VCODE_REGEX.test(code)) {
      skippedNonV++;
      continue;
    }

    await sleep(randBetween(rateMin, rateMax));

    let status = "unknown";
    let evidence = "";
    let ok = true;
    let error = "";

    // Debug fields
    let statusSource = "";
    let statusReason = "";
    let appointmentsUrlUsed = "";
    let baseUrlUsed = "";
    let httpStatus = null;

    // Canonical base URL from discovery/enrichment
    const baseUrl = safeBaseUrl(p.nhsUrl);
    baseUrlUsed = baseUrl;

    // If missing base URL, fail fast (should be rare)
    if (!baseUrl) {
      ok = false;
      error = "missing_nhsUrl_on_practicevcodes";
      statusSource = "error";
      statusReason = "missing_base_url";
    } else {
      try {
        // 1) Appointments authoritative
        const apptUrl = `${baseUrl}/appointments`;
        const { html: apptHtml, finalUrl: apptFinalUrl, statusCode } =
          await fetchWithAxios(apptUrl);

        appointmentsUrlUsed = apptFinalUrl;
        httpStatus = statusCode;

        const apptParsed = parseNhsAcceptance(stripHtml(apptHtml));
        status = apptParsed.status;
        evidence = extractEvidenceSnippet(apptHtml);
        statusSource = "appointments";
        statusReason = apptParsed.reason;

        // 2) Fallback only if "no signal"
        if (apptParsed.lock === false && status === "unknown") {
          const { html: mainHtml, finalUrl, statusCode: mainStatus } =
            await fetchWithAxios(baseUrl);
          httpStatus = mainStatus;

          const mainParsed = parseNhsAcceptance(stripHtml(mainHtml));
          if (mainParsed.lock === true && mainParsed.status !== "unknown") {
            status = mainParsed.status;
            evidence = extractEvidenceSnippet(mainHtml);
            statusSource = "main";
            statusReason = mainParsed.reason;
          }
        }
      } catch (e) {
        ok = false;
        const sc = e?.response?.status;
        const msg = e?.message || String(e);
        error = sc ? `HTTP_${sc}: ${msg}` : msg;
        status = "unknown";
        statusSource = "error";
        statusReason = "fetch_failed";
      }
    }

    const latestDoc = {
      code, // store as code for snapshot collections
      // carry through metadata from practicevcodes
      name: p.name || "",
      postcode: p.postcode || p.postcodeGuess || "",
      region: p.region || "Unknown",
      nhsUrl: baseUrl || canonicalBaseUrl(appointmentsUrlUsed) || "",
      status,
      statusEvidence: evidence,
      checkedAt,
      statusSource,
      statusReason,
      appointmentsUrlUsed,
      baseUrlUsed,
      httpStatus,
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
      nhsUrl: latestDoc.nhsUrl,
      ok,
      error,
      statusSource,
      statusReason,
      appointmentsUrlUsed,
      baseUrlUsed,
      httpStatus,
    });

    if (ok) okCount++;
    else errCount++;
  }

  return { batchSize: batch.length, okCount, errCount, skippedNonV, checkedAt };
}

module.exports = { runNhsSnapshotBatch };
