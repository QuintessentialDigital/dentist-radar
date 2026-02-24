// nhs-snapshot.js (CLEAN FULL FILE - appointments authoritative + locked classification)

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
  // Covers: "has not confirmed if they currently accept new NHS patients..."
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
    "accept new nhs patients",
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
  return { html, finalUrl };
}

async function fetchPracticePage(code, name) {
  const slug = toSlug(name);

  const urlSlug = slug
    ? `https://www.nhs.uk/services/dentist/${slug}/${encodeURIComponent(code)}`
    : null;

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
    ? `https://www.nhs.uk/services/dentist/${slug}/${encodeURIComponent(code)}/appointments`
    : `https://www.nhs.uk/services/dentist/${encodeURIComponent(code)}/appointments`;

  return await fetchWithAxios(url);
}

function canonicalBaseUrl(url) {
  return String(url || "").replace(/\/appointments\/?$/, "");
}

async function selectBatch(batchSize) {
  const checkedCodes = await PracticeStatusLatest.find({
    code: { $regex: VCODE_REGEX },
  })
    .select({ code: 1 })
    .lean();

  const checkedSet = new Set(checkedCodes.map((x) => x.code));

  const neverChecked = await PracticeOds.find({
    code: { $regex: VCODE_REGEX, $nin: Array.from(checkedSet) },
  })
    .limit(batchSize)
    .lean();

  if (neverChecked.length >= batchSize) return neverChecked;

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

    // Debug fields (to prove what happened)
    let statusSource = "";
    let statusReason = "";
    let appointmentsUrlUsed = "";

    try {
      // ---- 1) Appointments is authoritative
      const { html: apptHtml, finalUrl: apptFinalUrl } =
        await fetchAppointmentsPage(code, p.name);

      appointmentsUrlUsed = apptFinalUrl;
      nhsUrl = canonicalBaseUrl(apptFinalUrl);

      const apptParsed = parseNhsAcceptance(stripHtml(apptHtml));

      status = apptParsed.status;
      evidence = extractEvidenceSnippet(apptHtml);
      statusSource = "appointments";
      statusReason = apptParsed.reason;

      // ---- 2) Only fallback if appointments had NO signal (lock=false) AND is unknown
      if (apptParsed.lock === false && status === "unknown") {
        const { html: mainHtml, finalUrl } = await fetchPracticePage(code, p.name);
        const mainParsed = parseNhsAcceptance(stripHtml(mainHtml));

        // Only upgrade if main page has locked explicit signal
        if (mainParsed.lock === true && mainParsed.status !== "unknown") {
          status = mainParsed.status;
          evidence = extractEvidenceSnippet(mainHtml);
          nhsUrl = finalUrl;
          statusSource = "main";
          statusReason = mainParsed.reason;
        }
      }
    } catch (e) {
      ok = false;
      error = String(e?.message || e).slice(0, 500);
      status = "unknown";
      statusSource = "error";
      statusReason = "fetch_failed";

      const slug = toSlug(p.name);
      nhsUrl = slug
        ? `https://www.nhs.uk/services/dentist/${slug}/${code}`
        : `https://www.nhs.uk/services/dentist/${code}`;
    }

    const latestDoc = {
      code,
      name: p.name || "",
      postcode: p.postcode || "",
      region: p.nhsEnglandRegion || p.region || "Unknown",
      nhsUrl,
      status,
      statusEvidence: evidence,
      checkedAt,
      statusSource,
      statusReason,
      appointmentsUrlUsed,
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
