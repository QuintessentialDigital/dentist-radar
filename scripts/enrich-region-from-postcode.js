/**
 * scripts/enrich-region-from-postcode.js
 *
 * Enrich practicevcodes with region using practiceods (postcode-based join).
 *
 * Env:
 *  - MONGO_URI or MONGODB_URI
 *  - DB_NAME (optional; default "dentistradar")
 *  - BATCH_SIZE (optional; default 500)
 *  - ONLY_MISSING (optional; default "true") => only fill docs with missing region
 *  - DRY_RUN (optional; default "false") => logs but does not write
 *
 * Output fields written to PracticeVcode:
 *  - region
 *  - regionSource: "postcode_exact" | "outward_majority" | "unknown"
 *  - regionConfidence: 1.0 | 0.7 | 0.0
 *  - outwardCode
 */

require("dotenv").config();
const mongoose = require("mongoose");

const PracticeOds = require("../models/PracticeOds");
const PracticeVcode = require("../models/PracticeVcode");
// Optional: if you want extra fallback later
// const PracticeStatusLatest = require("../models/PracticeStatusLatest");

function normPostcode(pc) {
  return String(pc || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

// Extract outward code from a normalized postcode (e.g. RG11AA -> RG1)
function outwardFromNormPostcode(pcNorm) {
  // UK outward code is the part before the last 3 characters (inward)
  if (!pcNorm || pcNorm.length < 5) return "";
  return pcNorm.slice(0, pcNorm.length - 3);
}

function pickRegion(doc) {
  // Your PracticeOds seems to store either nhsEnglandRegion or region
  return (
    doc?.nhsEnglandRegion ||
    doc?.region ||
    doc?.nhsRegion ||
    doc?.englandRegion ||
    "Unknown"
  );
}

async function buildLookups() {
  console.log("[REGION] Building lookups from PracticeOds...");

  // We only need postcode + region-ish fields
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

  const postcodeToRegion = new Map(); // exact postcode -> region
  const outwardRegionCounts = new Map(); // outward -> Map(region->count)

  let scanned = 0;
  let usable = 0;

  for await (const doc of cursor) {
    scanned++;
    const pcNorm = normPostcode(doc.postcode);
    if (!pcNorm) continue;

    const region = pickRegion(doc);
    if (!region || region === "Unknown") continue;

    usable++;

    // Exact postcode mapping (first wins is fine; could also choose most common)
    if (!postcodeToRegion.has(pcNorm)) {
      postcodeToRegion.set(pcNorm, region);
    }

    // Outward majority mapping
    const outward = outwardFromNormPostcode(pcNorm);
    if (outward) {
      if (!outwardRegionCounts.has(outward)) outwardRegionCounts.set(outward, new Map());
      const m = outwardRegionCounts.get(outward);
      m.set(region, (m.get(region) || 0) + 1);
    }
  }

  // Convert outward counts to outward -> majority region
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

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI (or MONGODB_URI) is not set.");

  const dbName = process.env.DB_NAME || "dentistradar";
  const batchSize = Number(process.env.BATCH_SIZE || 500);
  const onlyMissing = String(process.env.ONLY_MISSING || "true").toLowerCase() === "true";
  const dryRun = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

  await mongoose.connect(uri, { dbName });

  const { postcodeToRegion, outwardToRegion } = await buildLookups();

  const query = onlyMissing
    ? {
        $or: [
          { region: { $exists: false } },
          { region: null },
          { region: "" },
          { region: "Unknown" },
        ],
      }
    : {};

  const total = await PracticeVcode.countDocuments(query);
  console.log("[REGION] PracticeVcode docs to process:", total);
  console.log("[REGION] onlyMissing:", onlyMissing, "dryRun:", dryRun, "batchSize:", batchSize);

  let processed = 0;
  let updated = 0;
  let exactHits = 0;
  let outwardHits = 0;
  let unknown = 0;

  const cursor = PracticeVcode.find(query)
    .select({ vcode: 1, postcode: 1, postcodeGuess: 1, region: 1 })
    .lean()
    .cursor();

  let ops = [];

  for await (const doc of cursor) {
    processed++;

    const pcRaw = doc.postcode || doc.postcodeGuess || "";
    const pcNorm = normPostcode(pcRaw);
    const outward = outwardFromNormPostcode(pcNorm);

    let region = "Unknown";
    let regionSource = "unknown";
    let regionConfidence = 0.0;

    if (pcNorm && postcodeToRegion.has(pcNorm)) {
      region = postcodeToRegion.get(pcNorm);
      regionSource = "postcode_exact";
      regionConfidence = 1.0;
      exactHits++;
    } else if (outward && outwardToRegion.has(outward)) {
      region = outwardToRegion.get(outward);
      regionSource = "outward_majority";
      regionConfidence = 0.7;
      outwardHits++;
    } else {
      unknown++;
    }

    // Always store outwardCode; it’s useful later
    const update = {
      outwardCode: outward || "",
      region,
      regionSource,
      regionConfidence,
      regionEnrichedAt: new Date(),
    };

    // Only write if we actually got a region (or if not onlyMissing and you want to set Unknown explicitly)
    // Since query already targets missing, we’ll update regardless.
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: update },
      },
    });

    if (ops.length >= batchSize) {
      if (!dryRun) {
        const res = await PracticeVcode.bulkWrite(ops, { ordered: false });
        updated += (res.modifiedCount || 0);
      }
      ops = [];
      if (processed % (batchSize * 2) === 0) {
        console.log(
          `[REGION] Progress ${processed}/${total} | exact=${exactHits} outward=${outwardHits} unknown=${unknown} updated=${updated}`
        );
      }
    }
  }

  if (ops.length) {
    if (!dryRun) {
      const res = await PracticeVcode.bulkWrite(ops, { ordered: false });
      updated += (res.modifiedCount || 0);
    }
  }

  console.log("[REGION] Done.");
  console.log({
    processed,
    updated,
    exactHits,
    outwardHits,
    unknown,
  });

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[REGION] Fatal:", e);
  process.exit(1);
});
