// One-time seeder for Practices from a list of NHS detail URLs
// Usage:
//   MONGO_URI="..." POSTCODE_COORDS="RG41 4UW:51.411,-0.864" \
//   PRACTICE_URLS="https://www.nhs.uk/services/dentists/<p1>/<id>;https://www.nhs.uk/services/dentists/<p2>/<id>" \
//   node seed_practices.js

import mongoose from "mongoose";
import axios from "axios";
import * as cheerio from "cheerio";

const { MONGO_URI, PRACTICE_URLS = "", POSTCODE_COORDS = "" } = process.env;
if (!MONGO_URI) throw new Error("MONGO_URI required");
const URLS = PRACTICE_URLS.split(";").map(s => s.trim()).filter(Boolean);

const PostcodeSchema = new mongoose.Schema(
  { postcode: { type: String, unique: true, index: true }, lat: Number, lon: Number },
  { collection: "Postcodes", versionKey: false }
);
const PracticeSchema = new mongoose.Schema(
  { name: String, postcode: String, lat: Number, lon: Number,
    detailsUrl: String, nhsUrl: String, url: String },
  { collection: "Practices", versionKey: false }
);
const Postcode  = mongoose.models.Postcode  || mongoose.model("Postcode", PostcodeSchema);
const Practice  = mongoose.models.Practice  || mongoose.model("Practice", PracticeSchema);

const normText = (s) => String(s||"").replace(/\s+/g," ").trim();
const normPc   = (pc) => String(pc||"").toUpperCase().replace(/\s+/g," ").trim();

function parsePostcodeCoordsEnv(raw) {
  const map = new Map();
  String(raw||"").split(";").map(s=>s.trim()).filter(Boolean).forEach(pair=>{
    const [pc, coords] = pair.split(":").map(s=>s.trim());
    if (!pc || !coords) return;
    const [lat, lon] = coords.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) map.set(normPc(pc), { lat, lon });
  });
  return map;
}
const POSTCODE_COORDS_MAP = parsePostcodeCoordsEnv(POSTCODE_COORDS);

async function coordsForPostcode(pc) {
  const n = normPc(pc);
  if (POSTCODE_COORDS_MAP.has(n)) return POSTCODE_COORDS_MAP.get(n);
  const doc = await Postcode.findOne({ postcode: n }).select("lat lon").lean();
  return doc ? { lat: doc.lat, lon: doc.lon } : null;
}

async function fetchHtml(u) {
  try {
    const { data } = await axios.get(u, {
      headers: { "User-Agent":"Mozilla/5.0", "Accept-Language":"en-GB,en;q=0.9" },
      timeout: 15000
    });
    return data;
  } catch {
    return null;
  }
}

async function extractPractice(u) {
  const html = await fetchHtml(u);
  if (!html) return null;
  const $ = cheerio.load(html);
  const name = normText($("h1").first().text()) || "Dental practice";

  // try to find postcode anywhere in the page text
  const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi;
  let text = normText($.root().text()).toUpperCase();
  let pc = null, m;
  while ((m = UK_POSTCODE_RE.exec(text)) !== null) pc = normPc(m[1]);

  let lat = null, lon = null;
  if (pc) {
    const c = await coordsForPostcode(pc);
    if (c) { lat = c.lat; lon = c.lon; }
  }

  return {
    name,
    postcode: pc || "",
    lat, lon,
    detailsUrl: u,
    nhsUrl: u,
    url: u
  };
}

(async () => {
  if (!URLS.length) {
    console.log("No PRACTICE_URLS provided; nothing to seed.");
    process.exit(0);
  }
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5 });
  console.log("Connected to Mongo");

  for (const u of URLS) {
    const doc = await extractPractice(u);
    if (!doc) { console.log("Skip (no html):", u); continue; }
    const existing = await Practice.findOne({ detailsUrl: u }).lean();
    if (existing) {
      await Practice.updateOne({ _id: existing._id }, { $set: doc });
      console.log("Updated:", doc.name, "→", u);
    } else {
      await Practice.create(doc);
      console.log("Inserted:", doc.name, "→", u);
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})();
