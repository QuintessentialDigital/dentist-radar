/**
 * Discover NHS dentist V-codes by querying NHS search results.
 *
 * Env:
 *  - MONGO_URI (or MONGODB_URI)
 *  - SEED_POSTCODES_FILE=./data/seed-postcodes.txt  (one postcode per line)
 *  - RADIUS_MILES=5
 *  - CONCURRENCY=4
 *  - HTTP_TIMEOUT_MS=15000
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const PracticeVcode = require("../models/PracticeVcode");

const UA =
  process.env.CRAWLER_USER_AGENT ||
  "DentistRadar discovery bot (contact: admin@yourdomain)";

function buildNhsSearchUrl(postcode, radiusMiles) {
  const raw = String(postcode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let formatted = raw;
  if (raw.length >= 5) formatted = `${raw.slice(0, raw.length - 3)} ${raw.slice(-3)}`;
  const pathPostcode = formatted.replace(/\s+/, "-");
  const radius = Number(radiusMiles) || 5;

  return `https://www.nhs.uk/service-search/find-a-dentist/results/${encodeURIComponent(
    pathPostcode
  )}?distance=${radius}`;
}

async function fetchText(url, label = "fetch") {
  const timeoutMs = Number(process.env.HTTP_TIMEOUT_MS) || 15000;
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
      console.error(`[DISCOVER] ${label} failed ${res.status} ${url}`);
      return "";
    }
    return await res.text();
  } catch (e) {
    clearTimeout(id);
    console.error(`[DISCOVER] ${label} error ${e?.message || e}`);
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

// Extract V-codes from the text (your proven anchor pattern)
function extractVcodes(text) {
  const re = /V\d{6}/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[0].toUpperCase());
  return Array.from(out);
}

// Best-effort: try to pull a name snippet near the vcode (not perfect, but good enough)
function guessNameNearVcode(text, vcode) {
  const idx = text.indexOf(vcode);
  if (idx === -1) return "";
  const slice = text.slice(idx, idx + 200);
  // Example patterns: "V123456 DEN Some Practice Name ..."
  const m = slice.match(/V\d{6}\s+DEN\s+(.+?)(?=\s+Within|\s+Phone:|\s+View|\s+\d|\s*$)/i);
  return m ? m[1].trim() : "";
}

async function runPool(items, concurrency, worker) {
  const results = [];
  let i = 0;
  async function runner() {
    while (i < items.length) {
      const current = i++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("Set MONGO_URI (or MONGODB_URI).");

  const seedFile = process.env.SEED_POSTCODES_FILE || "./data/seed-postcodes.txt";
  const radius = Number(process.env.RADIUS_MILES || 5);
  const concurrency = Number(process.env.CONCURRENCY || 4);

  const filePath = path.resolve(seedFile);
  const raw = fs.readFileSync(filePath, "utf-8");
  const seeds = raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  if (!seeds.length) throw new Error(`No postcodes found in ${filePath}`);

  await mongoose.connect(uri, { dbName: "dentistradar" });

  let totalFound = 0;
  let totalUpserts = 0;

  await runPool(seeds, concurrency, async (pc) => {
    const url = buildNhsSearchUrl(pc, radius);
    const html = await fetchText(url, "search");
    const text = htmlToText(html);

    const vcodes = extractVcodes(text);
    if (!vcodes.length) return;

    totalFound += vcodes.length;

    const now = new Date();
    const ops = vcodes.map((v) => {
      const name = guessNameNearVcode(text, v);
      const baseUrl = name
        ? `https://www.nhs.uk/services/dentist/${encodeURIComponent(
            name
              .toLowerCase()
              .replace(/&/g, "and")
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "")
          )}/${v}`
        : "";

      return {
        updateOne: {
          filter: { vcode: v },
          update: {
            $set: {
              vcode: v,
              ...(name ? { name } : {}),
              lastSeenAt: now,
              ...(baseUrl ? { nhsUrl: baseUrl } : {}),
            },
            $addToSet: { "sources.postcodes": pc },
            $inc: { "sources.count": 1 },
          },
          upsert: true,
        },
      };
    });

    const res = await PracticeVcode.bulkWrite(ops, { ordered: false });
    totalUpserts += (res.upsertedCount || 0) + (res.modifiedCount || 0);

    console.log(`[DISCOVER] ${pc}: found ${vcodes.length}, upserts+mods ${((res.upsertedCount||0)+(res.modifiedCount||0))}`);
  });

  console.log("[DISCOVER] Done", { seeds: seeds.length, totalFound, totalUpserts });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[DISCOVER] Fatal:", e);
  process.exit(1);
});
