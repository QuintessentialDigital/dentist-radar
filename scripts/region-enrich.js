/**
 * region-enrich.js
 * Enrich PracticeOds documents with NHS England region using postcodes.io.
 *
 * Usage:
 *   node region-enrich.js
 *
 * Env required:
 *   MONGODB_URI
 *
 * Optional env:
 *   ENRICH_BATCH=100           // how many ODS docs to process per batch
 *   POSTCODES_IO_BATCH=100     // max 100 (postcodes.io limit)
 *   SLEEP_MS=200              // sleep between API calls
 */

require("dotenv").config();
const mongoose = require("mongoose");

// IMPORTANT: adjust this path if your model path differs
const PracticeOds = require("../models/PracticeOds");

const ENRICH_BATCH = Number(process.env.ENRICH_BATCH || 500);
const POSTCODES_IO_BATCH = Math.min(100, Number(process.env.POSTCODES_IO_BATCH || 100));
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanPostcode(pc) {
  return String(pc || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// Map postcodes.io "region" (UK Gov region) → NHS England Region
function mapToNhsEnglandRegion(ukRegion) {
  const r = String(ukRegion || "").toLowerCase();

  if (!r) return "";

  // NHS England Regions
  if (r === "north east" || r === "yorkshire and the humber") return "North East and Yorkshire";
  if (r === "north west") return "North West";
  if (r === "east midlands" || r === "west midlands") return "Midlands";
  if (r === "east of england") return "East of England";
  if (r === "london") return "London";
  if (r === "south east") return "South East";
  if (r === "south west") return "South West";

  // If something unexpected comes back
  return "";
}

async function postcodesIoLookup(postcodes) {
  // postcodes.io bulk endpoint
  const res = await fetch("https://api.postcodes.io/postcodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postcodes }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`postcodes.io failed ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  // data.result is an array of { query, result }
  return data.result || [];
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri, { dbName: "dentistradar" });

  let totalUpdated = 0;
  let totalScanned = 0;
  let totalMissingPostcode = 0;
  let totalLookupFailures = 0;

  while (true) {
    // Pull docs missing nhsEnglandRegion (or blank)
    const docs = await PracticeOds.find({
      $or: [{ nhsEnglandRegion: { $exists: false } }, { nhsEnglandRegion: "" }],
    })
      .select({ _id: 1, postcode: 1 })
      .limit(ENRICH_BATCH)
      .lean();

    if (!docs.length) break;

    totalScanned += docs.length;

    // Prepare postcodes in batches for postcodes.io
    const items = docs
      .map((d) => ({ _id: d._id, postcode: d.postcode, pcClean: cleanPostcode(d.postcode) }))
      .filter((x) => x.pcClean.length >= 5);

    totalMissingPostcode += docs.length - items.length;

    // Process in chunks of up to 100 (postcodes.io limit)
    for (let i = 0; i < items.length; i += POSTCODES_IO_BATCH) {
      const chunk = items.slice(i, i + POSTCODES_IO_BATCH);
      const queries = chunk.map((x) => x.pcClean);

      let results;
      try {
        results = await postcodesIoLookup(queries);
      } catch (e) {
        totalLookupFailures += chunk.length;
        // Don’t hard fail entire run; continue
        console.error("[REGION] Lookup batch failed:", e.message);
        await sleep(SLEEP_MS);
        continue;
      }

      // results: [{ query: "S59JH", result: {...} } or result: null]
      const bulkOps = [];

      for (let j = 0; j < chunk.length; j++) {
        const item = chunk[j];
        const r = results[j] || {};
        const rr = r.result || null;

        const ukRegion = rr?.region || "";
        const nhsEnglandRegion = mapToNhsEnglandRegion(ukRegion);

        // If no lookup result, skip update
        if (!rr || !nhsEnglandRegion) continue;

        bulkOps.push({
          updateOne: {
            filter: { _id: item._id },
            update: {
              $set: {
                ukRegion,
                nhsEnglandRegion,
                adminDistrict: rr?.admin_district || "",
                adminCounty: rr?.admin_county || "",
              },
            },
          },
        });
      }

      if (bulkOps.length) {
        const res = await PracticeOds.bulkWrite(bulkOps, { ordered: false });
        totalUpdated += res.modifiedCount || 0;
        console.log(
          `[REGION] Updated ${res.modifiedCount || 0} docs (batch ${i / POSTCODES_IO_BATCH + 1})`
        );
      } else {
        console.log(`[REGION] No updates for this batch (batch ${i / POSTCODES_IO_BATCH + 1})`);
      }

      await sleep(SLEEP_MS);
    }
  }

  console.log("[REGION] Done.");
  console.log({
    totalScanned,
    totalUpdated,
    totalMissingPostcode,
    totalLookupFailures,
  });

  await mongoose.disconnect();
}

run().catch((e) => {
  console.error("[REGION] Fatal:", e);
  process.exit(1);
});
