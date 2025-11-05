/**
 * DentistRadar — scanner.api.js (NHS API + Appointments acceptance) — v5.0
 * Discovery:
 *   - postcode -> lat/lon (postcodes.io)
 *   - NHS API (env-configurable) -> array of practices with {url, name, lat, lon}
 * Detection:
 *   - fetch practice detail page; hop to /appointments; parse text; classify
 * Alerts:
 *   - Postmark email; per-day dedupe via EmailLog
 *
 * Exports: runScan(opts?) — same signature your server.js expects
 */

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";

/* ── ENV ────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",

  NHS_API_ENDPOINT,                // e.g. https://api.nhs.uk/... (must accept lat/lon/radius query)
  NHS_API_KEY,
  NHS_API_KEY_HEADER = "subscription-key",
  NHS_API_RADIUS_UNIT = "miles",   // miles | km

  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");
if (!NHS_API_ENDPOINT) throw new Error("NHS_API_ENDPOINT is required");
if (!NHS_API_KEY) throw new Error("NHS_API_KEY is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/* ── Mongo models (guarded) ─────────────────────────────────────────── */
function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}
const WatchSchema = new mongoose.Schema(
  { email: String, postcode: String, radius: Number },
  { collection: "Watch", timestamps: true, versionKey: false }
);
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const EmailLogSchema = new mongoose.Schema(
  { practiceUrl: String, dateKey: String, status: String, sentAt: { type: Date, default: Date.now } },
  { collection: "EmailLog", versionKey: false }
);
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true });

const Watch = model("Watch", WatchSchema);
const EmailLog = model("EmailLog", EmailLogSchema);

async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { maxPoolSize: 10 });
  console.log("✅ MongoDB connected");
}

/* ── Utils ──────────────────────────────────────────────────────────── */
const normText = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc   = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9" }
    });
    return res.data;
  } catch {
    return null;
  }
}

/* ── Postcode → lat/lon ─────────────────────────────────────────────── */
async function geocodePostcode(postcode) {
  const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  if (!data || data.status !== 200 || !data.result) throw new Error("geocode_failed");
  return { lat: data.result.latitude, lon: data.result.longitude };
}

/* ── NHS API: flexible field extraction ─────────────────────────────── */
function pluck(obj, paths) {
  for (const p of paths) {
    const v = p.split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

// find public detail URL, name, and coords in a wide variety of payloads
function mapPractice(rec) {
  // Common place for URL across NHS payloads
  const url =
    pluck(rec, ["url", "Url", "URI", "Uri", "link", "Link", "website", "Website", "publicWebsite", "PublicWebsite"]) ||
    pluck(rec, ["_links.self.href", "_links.website.href"]) ||
    pluck(rec, ["organisationUrl", "serviceUrl"]);

  // name/label
  const name = pluck(rec, ["name", "Name", "organisationName", "OrganisationName", "title", "Title"]);

  // coordinates
  const lat =
    pluck(rec, ["lat", "latitude", "Latitude", "location.lat", "location.latitude", "geo.lat", "geo.latitude"]) ??
    pluck(rec, ["position.lat", "position.latitude", "coordinates.lat"]);
  const lon =
    pluck(rec, ["lon", "lng", "longitude", "Longitude", "location.lon", "location.lng", "geo.lon", "geo.longitude"]) ??
    pluck(rec, ["position.lon", "position.lng", "position.longitude", "coordinates.lon", "coordinates.lng"]);

  return { url, name, lat: Number(lat), lon: Number(lon) };
}

async function fetchPracticesFromNhsApi(lat, lon, radiusMiles) {
  // Convert radius if API expects km
  const radius = Number(radiusMiles) || 10;
  const r = NHS_API_RADIUS_UNIT.toLowerCase() === "km" ? radius * 1.60934 : radius;

  // We assume the NHS endpoint supports lat/lon/radius as query params.
  // Example shape: GET {endpoint}?lat=..&lon=..&radius=..&type=dentist
  const endpoint = new URL(NHS_API_ENDPOINT);
  const qs = endpoint.searchParams;
  // Only set if not already in the configured endpoint
  if (!qs.has("lat"))    qs.set("lat", String(lat));
  if (!qs.has("lon"))    qs.set("lon", String(lon));
  if (!qs.has("radius")) qs.set("radius", String(r));
  if (!qs.has("type"))   qs.set("type", "dentist");

  const url = endpoint.toString();
  const headers = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Language": "en-GB,en;q=0.9",
  };
  headers[NHS_API_KEY_HEADER] = NHS_API_KEY;

  const res = await axios.get(url, { headers, timeout: 15000 }).catch((e) => {
    const msg = e?.response?.data || e?.message;
    throw new Error("nhs_api_error: " + JSON.stringify(msg).slice(0, 300));
  });

  const payload = res.data;
  // Normalise to array
  const items = Array.isArray(payload) ? payload :
                Array.isArray(payload?.items) ? payload.items :
                Array.isArray(payload?.results) ? payload.results :
                Array.isArray(payload?.value) ? payload.value :
                Array.isArray(payload?.organisations) ? payload.organisations :
                [];

  const mapped = items.map(mapPractice)
    .filter(p => p.url && isFinite(p.lat) && isFinite(p.lon));

  // Ensure we point to the public detail page (some APIs return homepages)
  // If it's already on nhs.uk/services/dentists, keep as-is. Otherwise accept the URL (some NHS APIs return the public detail URL outright).
  return mapped.map(p => ({ ...p, url: p.url.split("#")[0] }));
}

/* ── Appointments fetch + acceptance classification ─────────────────── */
async function loadAppointmentsHtml(detailUrl) {
  const html = await httpGet(detailUrl);
  if (!html) return null;

  const $ = cheerio.load(html);
  let href =
    $('a[href*="/appointments"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href") ||
    $('a[href*="appointments-and-opening-times"]').attr("href") ||
    $('a[href*="opening-times"]').attr("href");

  if (!href) return html; // fall back to main detail page
  const apptUrl = new URL(href, detailUrl).toString();
  return (await httpGet(apptUrl)) || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  $("h1,h2,h3").each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol"].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next(); hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  const wrappers = ["main", ".nhsuk-main-wrapper", "#content", "#maincontent", ".nhsuk-width-container", ".nhsuk-u-reading-width"];
  for (const sel of wrappers) {
    const t = normText($(sel).text());
    if (t && t.length > 120) buckets.push(t);
  }

  if (!buckets.length) buckets.push(normText($.root().text()));
  buckets.sort((a,b)=> b.length - a.length);
  return buckets[0] || "";
}

function classifyAcceptance(text) {
  const t = normText(text).replace(/’/g, "'").toLowerCase();

  const childOnly =
    (t.includes("only accepts") || t.includes("currently only accepts") || t.includes("accepting only")) &&
    (t.includes("children aged 17 or under") || t.includes("children only") || /under\s*18/.test(t));

  const accepting =
    t.includes("this dentist currently accepts new nhs patients") ||
    ((t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting") || t.includes("currently accepting")) &&
      t.includes("nhs patients") &&
      !childOnly);

  if (childOnly) return "CHILD_ONLY";
  if (accepting) return "ACCEPTING";
  return "NONE";
}

/* ── Email (Postmark) ──────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN, "Content-Type": "application/json" }, timeout: 12000 }
    );
    console.log(`📧 Email sent to ${toList.length} — ${subject}`);
  } catch (e) {
    console.log("Postmark error:", e?.response?.data || e.message);
  }
}

/* ── Discovery via NHS API ─────────────────────────────────────────── */
async function discoverDetailUrlsViaNhsApi(postcode, radiusMiles) {
  // 1) Geocode
  const { lat, lon } = await geocodePostcode(postcode);

  // 2) NHS API
  const practices = await fetchPracticesFromNhsApi(lat, lon, radiusMiles);

  // 3) Normalize to public detail URLs (prefer nhs.uk/services/dentists if present)
  const urls = [];
  for (const p of practices) {
    // If the API returns a non-NHS website, we still attempt it (many link back to NHS pages internally).
    if (typeof p.url === "string" && p.url.startsWith("http")) {
      urls.push(p.url);
    }
  }
  // De-dupe
  return Array.from(new Set(urls));
}

/* ── One job ───────────────────────────────────────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan (NHS API): ${postcode} (${radiusMiles} miles) ---`);

  const detailUrls = await discoverDetailUrlsViaNhsApi(postcode, radiusMiles);
  console.log(`[DISCOVERY] NHS API returned ${detailUrls.length} candidate URL(s).`);

  if (!detailUrls.length) return { accepting: [], childOnly: [] };

  const limit = pLimit(CONCURRENCY);
  const accepting = [];
  const childOnly = [];
  const dateKey = dayjs().format("YYYY-MM-DD");

  await Promise.all(detailUrls.map((url) => limit(async () => {
    const already = await EmailLog.findOne({ practiceUrl: url, dateKey }).lean();
    if (already) return;

    const apptHtml = await loadAppointmentsHtml(url);
    if (!apptHtml) return;

    const verdict = classifyAcceptance(extractAppointmentsText(apptHtml));
    if (verdict === "ACCEPTING") {
      accepting.push(url);
      await EmailLog.create({ practiceUrl: url, dateKey, status: "ACCEPTING" });
    } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
      childOnly.push(url);
      await EmailLog.create({ practiceUrl: url, dateKey, status: "CHILD_ONLY" });
    }
  })));

  if ((accepting.length || childOnly.length) && recipients?.length) {
    const render = (arr, label) =>
      arr.length ? `<b>${label}:</b><br>${arr.map((u) => `<a href="${u}">${u}</a>`).join("<br>")}<br><br>` : "";

    const subject = `DentistRadar — ${postcode} (${radiusMiles} mi): ${accepting.length} accepting${INCLUDE_CHILD ? `, ${childOnly.length} child-only` : ""}`;
    const body = `<div style="font-family:system-ui;-webkit-font-smoothing:antialiased">
      <h3 style="margin:0 0 8px">DentistRadar — ${postcode} (${radiusMiles} mi)</h3>
      <div style="color:#666;margin:0 0 10px">${dayjs().format("YYYY-MM-DD HH:mm")}</div>
      ${render(accepting, "Accepting (adults/all)")}
      ${INCLUDE_CHILD ? render(childOnly, "Children-only") : ""}
      <hr style="border:0;border-top:1px solid #eee;margin:12px 0">
      <div style="font-size:12px;color:#777">We read the NHS <b>Appointments</b> page text. Please call the practice to confirm before travelling.</div>
    </div>`;
    await sendEmail(recipients, subject, body);
  } else {
    console.log("No accepting practices found or no recipients.");
  }

  return { accepting, childOnly };
}

/* ── Runner (export) ───────────────────────────────────────────────── */
async function buildJobs(filterPostcode) {
  const match = filterPostcode ? { postcode: normPc(filterPostcode) } : {};
  const rows = await Watch.aggregate([
    { $match: match },
    { $group: { _id: "$postcode", radius: { $first: "$radius" }, emails: { $addToSet: "$email" } } },
    { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } }
  ]);
  return rows.map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).filter(validEmail)
  }));
}

export async function runScan(opts = {}) {
  await connectMongo(MONGO_URI);
  const jobs = await buildJobs(opts.postcode);
  if (!jobs.length) {
    console.log("[RESULT] No Watch entries.");
    return { jobs: 0, summaries: [] };
  }

  const summaries = [];
  for (const job of jobs) {
    const res = await scanJob(job);
    summaries.push({
      postcode: job.postcode,
      radiusMiles: job.radiusMiles,
      accepting: res.accepting.length,
      childOnly: res.childOnly.length
    });
    await sleep(100);
  }
  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

if (import.meta.url === `file://${process.argv[1]}`) {
  runScan().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
