const fs = require("fs");
const path = require("path");
const axios = require("axios");
const PracticeOds = require("../models/PracticeOds");

function pickKey(headers, candidates) {
  const exact = new Map(headers.map((h) => [h.trim(), h]));
  for (const c of candidates) if (exact.has(c)) return exact.get(c);

  const low = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  for (const c of candidates) if (low.has(c.toLowerCase())) return low.get(c.toLowerCase());

  return null;
}

function parseCsv(text) {
  // Minimal CSV parser for well-behaved ODS exports
  // If your file has complex quoting, we can swap this with csv-parse later.
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    if (cols.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => (row[h] = cols[idx]));
    rows.push(row);
  }
  return { headers, rows };
}

async function loadOdsCsvText() {
  const url = process.env.ODS_CSV_URL;
  const filePath = process.env.ODS_FILE_PATH;

  if (filePath) {
    return fs.readFileSync(path.resolve(filePath), "utf-8");
  }
  if (!url) {
    throw new Error("Set ODS_CSV_URL (preferred) or ODS_FILE_PATH for ODS dental practices CSV.");
  }

  const res = await axios.get(url, { timeout: 60000, responseType: "text" });
  return res.data;
}

async function runOdsSync() {
  const csvText = await loadOdsCsvText();
  const { headers, rows } = parseCsv(csvText);

  // Common ODS header candidates (you may need to adjust once you see actual export)
  const CODE = pickKey(headers, ["Organisation Code", "Org Code", "Code", "OrganisationCode"]);
  const NAME = pickKey(headers, ["Organisation Name", "Name", "OrganisationName"]);
  const POST = pickKey(headers, ["Postcode", "Post Code", "POSTCODE"]);
  const A1 = pickKey(headers, ["Address Line 1", "Address1", "Addr1"]);
  const A2 = pickKey(headers, ["Address Line 2", "Address2", "Addr2"]);
  const TOWN = pickKey(headers, ["Town", "City"]);
  const COUNTY = pickKey(headers, ["County"]);

  if (!CODE || !NAME || !POST) {
    throw new Error(`Could not map required columns. Headers found: ${headers.join(" | ")}`);
  }

  const now = new Date();
  let upserts = 0;

  for (const r of rows) {
    const code = (r[CODE] || "").trim();
    if (!code) continue;

    const doc = {
      code,
      name: (r[NAME] || "").trim(),
      postcode: (r[POST] || "").trim(),
      address1: A1 ? (r[A1] || "").trim() : "",
      address2: A2 ? (r[A2] || "").trim() : "",
      town: TOWN ? (r[TOWN] || "").trim() : "",
      county: COUNTY ? (r[COUNTY] || "").trim() : "",
      lastOdsSyncAt: now,
    };

    await PracticeOds.updateOne({ code }, { $set: doc }, { upsert: true });
    upserts++;
  }

  return { upserts };
}

module.exports = { runOdsSync };
