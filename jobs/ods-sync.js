const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const PracticeOds = require("../models/PracticeOds");

function pickKey(headers, candidates) {
  const exact = new Map(headers.map((h) => [String(h).trim(), h]));
  for (const c of candidates) if (exact.has(c)) return exact.get(c);

  const low = new Map(headers.map((h) => [String(h).trim().toLowerCase(), h]));
  for (const c of candidates) if (low.has(c.toLowerCase())) return low.get(c.toLowerCase());

  return null;
}

async function loadText() {
  const url = process.env.ODS_CSV_URL;
  const filePath = process.env.ODS_FILE_PATH;

  if (filePath) {
    return fs.readFileSync(path.resolve(filePath), "utf-8");
  }
  if (!url) throw new Error("Set ODS_CSV_URL or ODS_FILE_PATH.");
  const res = await axios.get(url, { timeout: 60000, responseType: "text" });
  return res.data;
}

async function runOdsSync() {
  const csvText = await loadText();

  // Robust CSV parse: handles quotes, commas, embedded newlines
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    bom: true,
    trim: true,
  });

  if (!records.length) return { upserts: 0 };

  const headers = Object.keys(records[0]);

  const CODE = pickKey(headers, ["Code", "Organisation Code", "Org Code", "OrganisationCode"]);
  const NAME = pickKey(headers, ["Name", "Organisation Name", "OrganisationName"]);
  const POST = pickKey(headers, ["Postcode", "Post Code", "POSTCODE"]);
  const STATUS = pickKey(headers, ["Status", "STATUS"]);
  const A1 = pickKey(headers, ["Address Line 1", "Address1", "Addr1"]);
  const TOWN = pickKey(headers, ["Town", "City"]);
  const COUNTY = pickKey(headers, ["County"]);

  if (!CODE || !NAME || !POST || !STATUS) {
    throw new Error(`Could not map required columns. Headers found: ${headers.join(" | ")}`);
  }

  const now = new Date();
  const BULK_SIZE = Number(process.env.ODS_BULK_SIZE || 500);

  let upserts = 0;
  let skippedInactive = 0;
  let skippedNoCode = 0;

  const ops = [];

  for (const r of records) {
    const statusVal = String(r[STATUS] || "").trim();
    if (statusVal !== "Active") {
      skippedInactive++;
      continue;
    }

    const code = String(r[CODE] || "").trim();
    if (!code) {
      skippedNoCode++;
      continue;
    }

    const doc = {
      code,
      name: String(r[NAME] || "").trim(),
      postcode: String(r[POST] || "").trim(),
      address1: A1 ? String(r[A1] || "").trim() : "",
      town: TOWN ? String(r[TOWN] || "").trim() : "",
      county: COUNTY ? String(r[COUNTY] || "").trim() : "",
      lastOdsSyncAt: now,
    };

    ops.push({
      updateOne: {
        filter: { code },
        update: { $set: doc },
        upsert: true,
      },
    });

    if (ops.length >= BULK_SIZE) {
      const res = await PracticeOds.bulkWrite(ops, { ordered: false });
      upserts += res.upsertedCount + res.modifiedCount;
      ops.length = 0;
    }
  }

  if (ops.length) {
    const res = await PracticeOds.bulkWrite(ops, { ordered: false });
    upserts += res.upsertedCount + res.modifiedCount;
  }

  return { upserts, skippedInactive, skippedNoCode, parsedRows: records.length };
}

module.exports = { runOdsSync };
