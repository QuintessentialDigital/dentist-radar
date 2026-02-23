const axios = require("axios");
const PracticeOds = require("../models/PracticeOds");
const PracticeStatusLatest = require("../models/PracticeStatusLatest");
const PracticeStatusEvent = require("../models/PracticeStatusEvent");

const UA = process.env.CRAWLER_USER_AGENT || "HealthRadar/DentistRadar snapshot bot (contact: admin@yourdomain)";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function normalizeStatusFromText(allText) {
  const t = allText.toLowerCase().replace(/\s+/g, " ");
  // Strong negative first
  if (t.includes("not accepting") && t.includes("nhs")) return "not_accepting";
  // Positive
  if (t.includes("accepting") && t.includes("nhs") && !t.includes("not accepting")) return "accepting";
  return "unknown";
}

function extractEvidenceSnippet(html) {
  // Keep it simple: just return a short surrounding snippet
  // (We can make this smarter with cheerio later if needed)
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const idx = plain.toLowerCase().indexOf("accepting");
  if (idx === -1) return "";
  return plain.slice(Math.max(0, idx - 80), Math.min(plain.length, idx + 160));
}

async function fetchPracticePage(code) {
  // NHS.uk supports /services/dentist/<code> redirect → canonical page
  const url = `https://www.nhs.uk/services/dentist/${encodeURIComponent(code)}`;
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

async function selectBatch(batchSize) {
  const strategy = process.env.BATCH_STRATEGY || "stale_first";

  if (strategy === "stale_first") {
    // join-like approach: pick ODS practices, order by last checked (from latest table)
    // Mongo doesn’t join easily without aggregation; we do a pragmatic two-step:
    // 1) fetch codes already checked sorted by oldest
    // 2) fill remainder from never-checked codes

    const checked = await PracticeStatusLatest.find({})
      .sort({ checkedAt: 1 })
      .limit(batchSize)
      .select({ code: 1 })
      .lean();

    const checkedCodes = checked.map((x) => x.code);
    let batch = [];

    // First: re-check stale ones
    if (checkedCodes.length) {
      const stale = await PracticeOds.find({ code: { $in: checkedCodes } })
        .limit(batchSize)
        .lean();
      batch = batch.concat(stale);
    }

    // Then: include never-checked codes
    if (batch.length < batchSize) {
      const remaining = batchSize - batch.length;
      const neverCheckedCodes = await PracticeOds.find({ code: { $nin: checkedCodes } })
        .limit(remaining)
        .lean();
      batch = batch.concat(neverCheckedCodes);
    }

    return batch;
  }

  // Default: simple scan
  return PracticeOds.find({}).limit(batchSize).lean();
}

async function runNhsSnapshotBatch() {
  const batchSize = Number(process.env.BATCH_SIZE || 200);
  const rateMin = Number(process.env.RATE_MIN_MS || 800);
  const rateMax = Number(process.env.RATE_MAX_MS || 1600);

  const batch = await selectBatch(batchSize);
  const checkedAt = new Date();

  let okCount = 0;
  let errCount = 0;

  for (const p of batch) {
    const code = p.code;
    if (!code) continue;

    await sleep(randBetween(rateMin, rateMax));

    let status = "unknown";
    let nhsUrl = "";
    let evidence = "";
    let ok = true;
    let error = "";

    try {
      const { html, finalUrl } = await fetchPracticePage(code);
      nhsUrl = finalUrl;
      status = normalizeStatusFromText(html);
      evidence = extractEvidenceSnippet(html);
    } catch (e) {
      ok = false;
      error = String(e?.message || e).slice(0, 500);
      status = "unknown";
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

    await PracticeStatusLatest.updateOne({ code }, { $set: latestDoc }, { upsert: true });

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

  return { batchSize: batch.length, okCount, errCount, checkedAt };
}

module.exports = { runNhsSnapshotBatch };
