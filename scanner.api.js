/**
 * DentistRadar — scanner.js (v6.0, API-free)
 * Public-site discovery (HTML) + Appointments acceptance parsing
 * - Build NHS results URLs from postcode+radius (tries multiple known patterns)
 * - Parse results pages → practice detail URLs
 * - Open detail → hop to /appointments → classify ACCEPTING / CHILD_ONLY / NONE
 * - Email (Postmark) with per-day de-dupe via EmailLog
 *
 * Exports: runScan(opts?)
 */

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";

/* ────────────────────────────────────────────────────────────────
   ENV
   ──────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",

  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/* ────────────────────────────────────────────────────────────────
   Mongo Models (guarded)
   ──────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────
   Utils
   ──────────────────────────────────────────────────────────────── */
const normText = (s) =>
  String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url, referer = "") {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": referer || "https://www.nhs.uk/",
        "Cache-Control": "no-cache"
      },
      // Follow redirects automatically (axios does)
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500
    });
    if (res.status >= 400) return null;
    return res.data;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────
   Build NHS results page URLs (try all common patterns)
   ──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";

  // We try both query-style and path-style endpoints, with paging up to 6.
  const urls = [];

  // Newer pattern (observed):
  // /service-search/find-a-dentist/results/{POSTCODE}?distance=25
  for (let page = 1; page <= 6; page++) {
    const u = `${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${page > 1 ? `&page=${page}` : ""}`;
    urls.push(u);
  }

  // Query param variant:
  // /service-search/find-a-dentist/results?postcode=RG41%204UW&distance=25
  for (let page = 1; page <= 6; page++) {
    const u = `${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}`;
    urls.push(u);
  }

  // Older “other-services” pattern (sometimes 410/404, but we still try):
  for (let page = 1; page <= 6; page++) {
    const u = `${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${page > 1 ? `&page=${page}` : ""}`;
    urls.push(u);
  }

  // Deduplicate
  return Array.from(new Set(urls));
}

/* ────────────────────────────────────────────────────────────────
   Parse results page → detail URLs
   ──────────────────────────────────────────────────────────────── */
function extractDetailUrlsFromResults(html) {
  const $ = cheerio.load(html);
  const urls = new Set();

  // Primary: cards linking to detail
  $('a.nhsuk-card__link, a[href^="/services/dentists/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    if (/^\/services\/dentists\//i.test(href)) {
      urls.add(`https://www.nhs.uk${href.split("#")[0]}`);
    } else if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(href)) {
      urls.add(href.split("#")[0]);
    }
  });

  // Fallback: any anchor containing “/services/dentists/”
  $('a[href*="/services/dentists/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    const abs = href.startsWith("http")
      ? href
      : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) {
      urls.add(abs.split("#")[0]);
    }
  });

  return Array.from(urls);
}

/* ────────────────────────────────────────────────────────────────
   Appointments → acceptance
   ──────────────────────────────────────────────────────────────── */
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

  if (!href) return html; // fall back to detail page if no explicit link
  const apptUrl = new URL(href, detailUrl).toString();
  const apptHtml = await httpGet(apptUrl, detailUrl);
  return apptHtml || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  // Prefer sections near “Appointments/Openings”
  $("h1,h2,h3").each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 25) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol"].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next(); hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  // Fallback: main wrapper text
  const wrappers = ["main",".nhsuk-main-wrapper","#content","#maincontent",".nhsuk-width-container",".nhsuk-u-reading-width"];
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
    (t.includes("children") || /under\s*18/.test(t) || t.includes("aged 17 or under"));

  const accepting =
    t.includes("this dentist currently accepts new nhs patients") ||
    ((t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting") || t.includes("currently accepting")) &&
     t.includes("nhs patients") &&
     !childOnly);

  if (childOnly) return "CHILD_ONLY";
  if (accepting) return "ACCEPTING";
  return "NONE";
}

/* ────────────────────────────────────────────────────────────────
   Email via Postmark
   ──────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────
   Discovery: results pages → detail URLs (multi-pattern)
   ──────────────────────────────────────────────────────────────── */
async function discoverDetailUrls(postcode, radiusMiles) {
  const urlsToTry = buildResultUrls(postcode, radiusMiles);
  const detailSet = new Set();

  for (const url of urlsToTry) {
    const html = await httpGet(url);
    if (!html) continue;
    const details = extractDetailUrlsFromResults(html);
    details.forEach((u) => detailSet.add(u));
    // small delay to be polite
    await sleep(150);
    // If we already have a decent set, continue; else keep going
  }
  return Array.from(detailSet);
}

/* ────────────────────────────────────────────────────────────────
   One job
   ──────────────────────────────────────────────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan (HTML): ${postcode} (${radiusMiles} miles) ---`);

  const detailUrls = await discoverDetailUrls(postcode, radiusMiles);
  console.log(`[DISCOVERY] NHS public site yielded ${detailUrls.length} detail URL(s).`);

  if (!detailUrls.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const accepting = [];
  const childOnly = [];
  const dateKey = dayjs().format("YYYY-MM-DD");

  await Promise.all(
    detailUrls.map((url) =>
      limit(async () => {
        try {
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
        } catch {
          // continue scanning others
        }
      })
    )
  );

  if ((accepting.length || childOnly.length) && recipients?.length) {
    const render = (arr, label) =>
      arr.length ? `<b>${label}:</b><br>${arr.map((u) => `<a href="${u}">${u}</a>`).join("<br>")}<br><br>` : "";
    const subject = `DentistRadar — ${postcode} (${radiusMiles} mi): ${accepting.length} accepting${
      INCLUDE_CHILD ? `, ${childOnly.length} child-only` : ""
    }`;
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

/* ────────────────────────────────────────────────────────────────
   Runner export
   ──────────────────────────────────────────────────────────────── */
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
  console.log("🦷 DentistRadar: Using HTML (public site) scanner");
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
  runScan()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
