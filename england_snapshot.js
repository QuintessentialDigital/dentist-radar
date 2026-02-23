/**
 * england_snapshot.js
 *
 * National-ish snapshot runner for DentistRadar (England) using NHS search pages.
 *
 * What it does:
 *  - scans a list of "seed" postcodes with a large radius
 *  - deduplicates practices by V-code
 *  - produces:
 *      - snapshot.json (all unique practices found)
 *      - snapshot.csv  (same, flattened)
 *      - summary.json  (headline metrics + top/bottom areas)
 *  - optionally persists to MongoDB collection: practiceSnapshots
 *
 * Run:
 *   node england_snapshot.js
 *
 * Env (optional):
 *   SNAPSHOT_RADIUS_MILES=50
 *   SNAPSHOT_DELAY_MS=700
 *   SCAN_APPT_CONCURRENCY=4          (already used by scanner.js)
 *   MONGO_URI="mongodb+srv://..."
 *   MONGO_DB="dentistradar"
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scanPostcode } from "./scanner.js"; // uses your production scanner
import "dotenv/config";

// Optional Mongo persistence
let MongoClient = null;
try {
  ({ MongoClient } = await import("mongodb"));
} catch {
  // mongodb package not installed - persistence will be skipped
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RADIUS = Number(process.env.SNAPSHOT_RADIUS_MILES) || 50;
const DELAY_MS = Number(process.env.SNAPSHOT_DELAY_MS) || 700;

const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB = process.env.MONGO_DB || "dentistradar";

const nowIso = new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Seed postcodes
 * - This is a starter set across England (major population centres).
 * - For BBC-grade coverage, expand this list to ~100–120 seeds (one per postcode area).
 */
const SEED_POSTCODES = [
  "B1 1AA",   // Birmingham
  "M1 1AA",   // Manchester
  "LS1 1AA",  // Leeds
  "L1 1AA",   // Liverpool
  "NE1 1AA",  // Newcastle
  "S1 1AA",   // Sheffield
  "NG1 1AA",  // Nottingham
  "BS1 1AA",  // Bristol
  "SO14 0AA", // Southampton
  "PO1 1AA",  // Portsmouth
  "BN1 1AA",  // Brighton
  "CB1 1AA",  // Cambridge
  "OX1 1AA",  // Oxford
  "NR1 1AA",  // Norwich
  "PL1 1AA",  // Plymouth
  "EX1 1AA",  // Exeter
  "GL1 1AA",  // Gloucester
  "CV1 1AA",  // Coventry
  "LE1 1AA",  // Leicester
  "MK9 1AA",  // Milton Keynes
  "RG1 1AA",  // Reading
  "SN1 1AA",  // Swindon
  "YO1 1AA",  // York
  "HU1 1AA",  // Hull
  "DH1 1AA",  // Durham
  "CA1 1AA",  // Carlisle
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postcodeAreaFromPostcode(postcode = "") {
  const m = String(postcode).trim().match(/^[A-Za-z]{1,2}/);
  return m ? m[0].toUpperCase() : "";
}

function toCsvRow(obj, headers) {
  return headers
    .map((h) => {
      const v = obj[h] == null ? "" : String(obj[h]);
      // CSV escape
      const escaped = v.includes(",") || v.includes('"') || v.includes("\n")
        ? `"${v.replace(/"/g, '""')}"`
        : v;
      return escaped;
    })
    .join(",");
}

async function maybeConnectMongo() {
  if (!MONGO_URI || !MongoClient) return null;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  return client;
}

/**
 * IMPORTANT:
 * This is "national-ish coverage" depending on seed list.
 * Increase seed list size for better coverage.
 */
async function runSnapshot() {
  console.log(`\n=== DentistRadar England Snapshot Runner ===`);
  console.log(`Seeds: ${SEED_POSTCODES.length}`);
  console.log(`Radius: ${RADIUS} miles`);
  console.log(`Delay between seeds: ${DELAY_MS} ms\n`);

  const unique = new Map(); // vcode -> practice record + provenance
  const seedStats = [];

  let mongoClient = null;
  let collection = null;

  try {
    mongoClient = await maybeConnectMongo();
    if (mongoClient) {
      collection = mongoClient.db(MONGO_DB).collection("practiceSnapshots");
      // light index safety (won't fail if already exists)
      await collection.createIndex({ vcode: 1, scannedAt: 1 });
      await collection.createIndex({ postcodeArea: 1, scannedAt: 1 });
      console.log(`[Mongo] Connected. Will write to ${MONGO_DB}.practiceSnapshots`);
    } else {
      console.log(`[Mongo] Not connected (MONGO_URI not set or mongodb package missing).`);
    }

    for (let i = 0; i < SEED_POSTCODES.length; i++) {
      const seed = SEED_POSTCODES[i];
      const seedArea = postcodeAreaFromPostcode(seed);

      console.log(`\n[${i + 1}/${SEED_POSTCODES.length}] Scanning seed: ${seed} (area ${seedArea})`);

      const result = await scanPostcode(seed, RADIUS);
      const practices = [
        ...result.accepting,
        ...result.notAccepting,
        ...result.unknown,
      ];

      seedStats.push({
        seedPostcode: seed,
        seedArea,
        scanned: result.scanned,
        accepting: result.acceptingCount,
        notAccepting: result.notAcceptingCount,
        unknown: result.unknownCount,
        tookMs: result.tookMs,
      });

      for (const p of practices) {
        if (!p?.vcode) continue;

        // choose "best" record if duplicates: prefer one with status != unknown and smaller distance
        const existing = unique.get(p.vcode);
        const candidate = {
          ...p,
          seedPostcode: seed,
          seedArea,
          postcodeArea: postcodeAreaFromPostcode(seed),
          scannedAt: new Date(),
          source: "nhs_find_a_dentist",
        };

        if (!existing) {
          unique.set(p.vcode, candidate);
        } else {
          const existingScore =
            (existing.status !== "unknown" ? 2 : 0) +
            (typeof existing.distanceMiles === "number" ? 1 : 0) -
            (typeof existing.distanceMiles === "number" ? existing.distanceMiles / 100 : 0);

          const candidateScore =
            (candidate.status !== "unknown" ? 2 : 0) +
            (typeof candidate.distanceMiles === "number" ? 1 : 0) -
            (typeof candidate.distanceMiles === "number" ? candidate.distanceMiles / 100 : 0);

          if (candidateScore > existingScore) unique.set(p.vcode, candidate);
        }
      }

      console.log(
        `  Seed result: scanned=${result.scanned}, accepting=${result.acceptingCount}, not=${result.notAcceptingCount}, unknown=${result.unknownCount}`
      );
      console.log(`  Unique practices so far: ${unique.size}`);

      await sleep(DELAY_MS);
    }

    const all = Array.from(unique.values());

    // Headline metrics
    const accepting = all.filter((p) => p.status === "accepting").length;
    const notAccepting = all.filter((p) => p.status === "notAccepting").length;
    const unknown = all.filter((p) => p.status === "unknown").length;

    // Group by seedArea (proxy geography)
    const byArea = new Map();
    for (const p of all) {
      const a = p.seedArea || "??";
      if (!byArea.has(a)) byArea.set(a, { area: a, total: 0, accepting: 0, notAccepting: 0, unknown: 0 });
      const row = byArea.get(a);
      row.total++;
      if (p.status === "accepting") row.accepting++;
      else if (p.status === "notAccepting") row.notAccepting++;
      else row.unknown++;
    }

    const areaRows = Array.from(byArea.values()).map((r) => ({
      ...r,
      acceptingRate: r.total ? Number((r.accepting / r.total) * 100).toFixed(2) : "0.00",
    }));

    areaRows.sort((a, b) => Number(b.acceptingRate) - Number(a.acceptingRate));
    const topAreas = areaRows.slice(0, 10);
    const bottomAreas = areaRows.slice(-10).reverse();

    const summary = {
      snapshotAt: new Date().toISOString(),
      seeds: SEED_POSTCODES.length,
      radiusMiles: RADIUS,
      uniquePractices: all.length,
      accepting,
      notAccepting,
      unknown,
      acceptingRatePct: all.length ? Number((accepting / all.length) * 100).toFixed(2) : "0.00",
      topAreas,
      bottomAreas,
      note:
        "This is an indicative snapshot based on scanning NHS Find-a-dentist listings from a set of seed postcodes and deduplicating by practice V-code. It is not an official NHS dataset and coverage depends on seed selection.",
    };

    // Write files
    const outJson = path.join(__dirname, `snapshot_${nowIso}.json`);
    const outCsv = path.join(__dirname, `snapshot_${nowIso}.csv`);
    const outSummary = path.join(__dirname, `summary_${nowIso}.json`);
    const outSeedStats = path.join(__dirname, `seed_stats_${nowIso}.json`);

    fs.writeFileSync(outJson, JSON.stringify(all, null, 2));
    fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2));
    fs.writeFileSync(outSeedStats, JSON.stringify(seedStats, null, 2));

    const headers = [
      "vcode",
      "name",
      "status",
      "distanceText",
      "distanceMiles",
      "address",
      "phone",
      "seedPostcode",
      "seedArea",
      "nhsUrl",
      "appointmentsUrl",
      "scannedAt",
      "source",
    ];
    const csv = [headers.join(",")]
      .concat(all.map((p) => toCsvRow(p, headers)))
      .join("\n");
    fs.writeFileSync(outCsv, csv);

    console.log(`\n=== DONE ===`);
    console.log(`Unique practices: ${all.length}`);
    console.log(`Accepting: ${accepting} (${summary.acceptingRatePct}%)`);
    console.log(`Not accepting: ${notAccepting}`);
    console.log(`Unknown: ${unknown}`);
    console.log(`\nWrote:`);
    console.log(` - ${outSummary}`);
    console.log(` - ${outJson}`);
    console.log(` - ${outCsv}`);
    console.log(` - ${outSeedStats}`);

    // Optional Mongo persistence
    if (collection) {
      // Write minimal snapshot records
      const docs = all.map((p) => ({
        vcode: p.vcode,
        name: p.name,
        status: p.status,
        distanceMiles: p.distanceMiles ?? null,
        distanceText: p.distanceText ?? "",
        address: p.address ?? "",
        phone: p.phone ?? "",
        nhsUrl: p.nhsUrl ?? "",
        appointmentsUrl: p.appointmentsUrl ?? "",
        seedPostcode: p.seedPostcode ?? "",
        seedArea: p.seedArea ?? "",
        postcodeArea: postcodeAreaFromPostcode(p.seedPostcode || ""),
        radiusMiles: RADIUS,
        scannedAt: new Date(),
        source: "nhs_find_a_dentist",
      }));

      // insertMany (unordered so one bad doc doesn't kill everything)
      await collection.insertMany(docs, { ordered: false });
      console.log(`[Mongo] Inserted ${docs.length} documents into practiceSnapshots`);
    }

    return summary;
  } finally {
    if (mongoClient) await mongoClient.close();
  }
}

// Run
runSnapshot().catch((e) => {
  console.error("Snapshot run failed:", e);
  process.exit(1);
});
