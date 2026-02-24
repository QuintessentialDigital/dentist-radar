/**
 * scripts/enrich-region-from-postcode.js
 *
 * Phase 1: Build postcode->region and outward->region lookups from practiceods.
 * Phase 2: For each practicevcodes doc missing region/postcode:
 *          - fetch NHS page (nhsUrl)
 *          - extract postcode
 *          - map to region using ODS lookup (exact postcode, else outward majority)
 *          - update practicevcodes with postcode, outwardCode, region, source/confidence
 *
 * Env:
 *  - MONGO_URI or MONGODB_URI (you said you use MONGO_URI)
 *  - DB_NAME (optional; default "dentistradar")
 *  - BATCH_SIZE (optional; default 100)
 *  - CONCURRENCY (optional; default 3)
 *  - ONLY_MISSING (optional; default "true")
 *  - DRY_RUN (optional; default "false")
 *  - HTTP_TIMEOUT_MS (optional; default 20000)
 */

require("dotenv").config();
const mongoose = require("mongoose");

const PracticeOds = require("../models/PracticeOds");
const PracticeVcode = require("../models/PracticeVcode");

const UA =
  process.env.CRAWLER_USER_AGENT ||
  "DentistRadar region enrich bot (contact: admin@yourdomain)";

function normPostcode(pc) {
  return String(pc || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

// Outward code = everything except last 3 chars (inward code)
function outwardFromNormPostcode(pcNorm) {
  if (!pcNorm || pcNorm.length < 5) return "";
  return pcNorm.slice(0, pcNorm.length - 3);
}

function pickRegion(doc) {
  return (
    doc?.nhsEnglandRegion ||
    doc?.region ||
    doc?.nhsRegion ||
    doc?.englandRegion ||
    "Unknown"
  );
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract UK postcodes from text.
 * We’ll return the first plausible one found (usually appears in address block).
 */
function extractPostcodeFromText(text) {
  const t = String(text || "").toUpperCase();

  // Reasonable UK postcode regex (covers standard formats, incl. "W1A 1AA")
  const re =
    /\b([A-Z]{1,2}\d[A-Z\d]?)\s*([0-9][A-Z]{2})\b/g;

  const m = re.exec(t);
  if (!m) return "";
  // return normalized (no space)
  return normPostcode(`${m[1]}${m[2]}`);
}

async function fetchText(url, label = "fetch") {
  const timeoutMs = Number(process.env.HTTP_TIMEOUT_MS || 20000);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });

    clearTimeout(id);

    if (!res.ok) {
      console.error(`[REGION] ${label} failed ${res.status} ${url}`);
      return "";
    }

    return await res.text();
  } catch (e) {
    clearTimeout(id);
    console.error(`[REGION] ${label} error ${e?.message || e}`);
    return "";
  }
}

async function buildLookups() {
  console.log("[REGION] Building lookups from practiceods...");

  const cursor = PracticeOds.find({})
    .select({
      postcode: 1,
      nhsEnglandRegion: 1,
      region: 1,
      nhsRegion: 1,
      englandRegion: 1,
    })
    .lean()
    .cursor();

  const postcodeToRegion = new Map();
  const outwardRegionCounts = new Map();

  let scanned = 0;
  let usable = 0;

  for await (const doc of cursor) {
    scanned++;
    const pcNorm = normPostcode(doc.postcode);
    if (!pcNorm) continue;

    const region = pickRegion(doc);
    if (!region || region === "Unknown") continue;

    usable++;

    if (!postcodeToRegion.has(pcNorm)) postcodeToRegion.set(pcNorm, region);

    const outward = outwardFromNormPostcode(pcNorm);
    if (!outward) continue;

    if (!outwardRegionCounts.has(outward)) outwardRegionCounts.set(outward, new Map());
    const m = outwardRegionCounts.get(outward);
    m.set(region, (m.get(region) || 0) + 1);
  }

  const outwardToRegion = new Map();
  for (const [outward, m] of outwardRegionCounts.entries()) {
    let bestRegion = "";
    let bestCount = 0;
    for (const [region, count] of m.entries()) {
      if (count > bestCount) {
        bestCount = count;
        bestRegion = region;
      }
    }
    if (bestRegion) outwardToRegion.set(outward, bestRegion);
  }

  console.log("[REGION] ODS scanned:", scanned);
  console.log("[REGION] ODS usable (postcode+region):", usable);
  console.log("[REGION] postcodeToRegion size:", postcodeToRegion.size);
  console.log("[REGION] outwardToRegion size:", outwardToRegion.size);

  return { postcodeToRegion, outwardToRegion };
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner)
  );

  return results;
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI (or MONGODB_URI) is not set.");

  const dbName = process.env.DB_NAME || "dentistradar";
  const batchSize = Number(process.env.BATCH_SIZE || 100);
  const concurrency = Number(process.env.CONCURRENCY || 3);
  const onlyMissing = String(process.env.ONLY_MISSING || "true").toLowerCase() === "true";
  const dryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

  await mongoose.connect(uri, { dbName });

  const { postcodeToRegion, outwardToRegion } = await buildLookups();

  // Target docs: missing region OR missing postcode (or both)
  const query = onlyMissing
    ? {
        $or: [
          { region: { $exists: false } },
          { region: null },
          { region: "" },
          { region: "Unknown" },
          { postcode: { $exists: false } },
          { postcode: null },
          { postcode: "" },
          { postcodeGuess: { $exists: false } },
          { postcodeGuess: null },
          { postcodeGuess: "" },
        ],
      }
    : {};

  const total = await PracticeVcode.countDocuments(query);
  console.log("[REGION] PracticeVcode docs to process:", total);
  console.log("[REGION] onlyMissing:", onlyMissing, "dryRun:", dryRun, "batchSize:", batchSize, "concurrency:", concurrency);

  let processed = 0;
  let updated = 0;

  let postcodeFound = 0;
  let regionExact = 0;
  let regionOutward = 0;
  let regionUnknown = 0;
  let fetchFailed = 0;

  const cursor = PracticeVcode.find(query)
    .select({ vcode: 1, nhsUrl: 1, postcode: 1, postcodeGuess: 1, region: 1, name: 1 })
    .lean()
    .cursor();

  const buffer = [];
  for await (const doc of cursor) buffer.push(doc);

  // Process in chunks (so we can bulkWrite)
  for (let i = 0; i < buffer.length; i += batchSize) {
    const chunk = buffer.slice(i, i + batchSize);

    const results = await runPool(chunk, concurrency, async (doc) => {
      processed++;

      const existingPc = normPostcode(doc.postcode || doc.postcodeGuess || "");
      let pcNorm = existingPc;

      // Fetch if postcode missing
      if (!pcNorm) {
        const url = doc.nhsUrl ? String(doc.nhsUrl) : "";
        if (!url) {
          return { _id: doc._id, update: { region: "Unknown", regionSource: "unknown", regionConfidence: 0.0 } };
        }

        const html = await fetchText(url, "nhs");
        if (!html) {
          fetchFailed++;
          return {
            _id: doc._id,
            update: {
              region: doc.region || "Unknown",
              regionSource: "fetch_failed",
              regionConfidence: 0.0,
              regionEnrichedAt: new Date(),
            },
          };
        }

        const text = stripHtml(html);
        pcNorm = extractPostcodeFromText(text);

        if (pcNorm) postcodeFound++;
      }

      const outward = outwardFromNormPostcode(pcNorm);

      // Map to region
      let region = "Unknown";
      let regionSource = "unknown";
      let regionConfidence = 0.0;

      if (pcNorm && postcodeToRegion.has(pcNorm)) {
        region = postcodeToRegion.get(pcNorm);
        regionSource = "postcode_exact";
        regionConfidence = 1.0;
        regionExact++;
      } else if (outward && outwardToRegion.has(outward)) {
        region = outwardToRegion.get(outward);
        regionSource = "outward_majority";
        regionConfidence = 0.7;
        regionOutward++;
      } else {
        regionUnknown++;
      }

      const update = {
        outwardCode: outward || "",
        region,
        regionSource,
        regionConfidence,
        regionEnrichedAt: new Date(),
      };

      // Store postcode if we found it
      if (pcNorm) {
        // Keep postcode without space (normalized) to match our join method
        update.postcode = pcNorm;
      }

      return { _id: doc._id, update };
    });

    const ops = results.map((r) => ({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: r.update },
      },
    }));

    if (!dryRun && ops.length) {
      const res = await PracticeVcode.bulkWrite(ops, { ordered: false });
      updated += (res.modifiedCount || 0);
    }

    console.log(
      `[REGION] Progress ${Math.min(i + batchSize, buffer.length)}/${buffer.length} | updated=${updated} postcodeFound=${postcodeFound} exact=${regionExact} outward=${regionOutward} unknown=${regionUnknown} fetchFailed=${fetchFailed}`
    );
  }

  console.log("[REGION] Done.", {
    processed,
    updated,
    postcodeFound,
    regionExact,
    regionOutward,
    regionUnknown,
    fetchFailed,
  });

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[REGION] Fatal:", e);
  process.exit(1);
});
