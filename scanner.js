/**
 * DentistRadar — scanner.js (v6.6)
 * Robust discovery WITHOUT NHS results pages:
 *  - NHS site search (nhs-meta collection)
 *  - DuckDuckGo HTML: site:nhs.uk/services/dentists "<OUTWARD>"
 * Then: follow to /appointments and classify acceptance; email via Postmark; per-day dedupe.
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
  INCLUDE_CHILD_ONLY = "false",
  DEBUG_DISCOVERY = "false",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";

/* ────────────────────────────────────────────────────────────────
   Mongo Models
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
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-GB,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const normText = (s) =>
  String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function outwardCode(pc) {
  const m = String(pc || "").trim().toUpperCase().match(/^([A-Z]{1,2}\d[A-Z\d]?)/);
  return m ? m[1] : String(pc || "").trim().split(/\s+/)[0];
}

async function httpGet(url, extraHeaders = {}) {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: { ...BASE_HEADERS, ...extraHeaders },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    const body = String(res.data || "");
    if (res.status >= 400) return null;
    if (!body || body.length < 150) return null;
    return body;
  } catch {
    return null;
  }
}

async function postmarkEmail(toList, subject, html) {
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
   Discovery: NHS site search
   Example: https://www.nhs.uk/search?collection=nhs-meta&query=dentist%20RG41
──────────────────────────────────────────────────────────────── */
async function discoverViaNhsSearch(pc, radiusMiles) {
  // radiusMiles is not used directly (site search is keyword based), but we bias by outward code
  const oc = outwardCode(pc);
  const q = encodeURIComponent(`dentist ${oc}`);
  const urls = [];
  for (let page = 1; page <= 5; page++) {
    const u = `https://www.nhs.uk/search?collection=nhs-meta&query=${q}&page=${page}`;
    urls.push(u);
  }
  const out = new Set();
  for (const u of urls) {
    const html = await httpGet(u, { Referer: "https://www.nhs.uk/" });
    if (!html) continue;
    const $ = cheerio.load(html);
    // typical result anchors
    $('a[href^="https://www.nhs.uk/services/dentists/"], a[href^="/services/dentists/"]').each((_, a) => {
      const href = $(a).attr("href") || "";
      const abs = href.startsWith("http") ? href : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
      if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) out.add(abs.split("#")[0]);
    });

    // also crawl any hidden script blobs for links
    $('script:not([src])').each((_, s) => {
      const txt = $(s).html() || "";
      const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
      const matches = txt.match(rx);
      if (matches) matches.forEach((m) => out.add(m.split("#")[0]));
    });

    if (DEBUG) console.log(`[NHS SEARCH] ${u} → ${out.size} unique links so far`);
    await sleep(120);
    if (out.size >= 120) break;
  }
  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Discovery: DuckDuckGo HTML
   Example: https://duckduckgo.com/html/?q=site%3Anhs.uk%2Fservices%2Fdentists%20%22RG41%22
──────────────────────────────────────────────────────────────── */
async function discoverViaDuckDuckGo(pc, radiusMiles) {
  const oc = outwardCode(pc);
  const q = encodeURIComponent(`site:nhs.uk/services/dentists "${oc}"`);
  const pages = 5;
  const out = new Set();
  for (let p = 0; p < pages; p++) {
    const u = `https://duckduckgo.com/html/?q=${q}&s=${p * 30}`;
    const html = await httpGet(u, { Referer: "https://duckduckgo.com/" });
    if (!html) continue;
    const $ = cheerio.load(html);
    // DDG html SERP links usually under .result__a
    $('a.result__a, a[href^="https://www.nhs.uk/services/dentists/"]').each((_, a) => {
      const href = ($(a).attr("href") || "").trim();
      if (!href) return;
      // DDG sometimes wraps redirect urls; prefer direct nhs links
      const m = href.match(/https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/);
      const finalUrl = m ? m[0] : href;
      if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(finalUrl)) {
        out.add(finalUrl.split("#")[0]);
      }
    });
    if (DEBUG) console.log(`[DDG] ${u} → ${out.size} unique links so far`);
    await sleep(150);
    if (out.size >= 120) break;
  }
  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Appointments fetch & acceptance
──────────────────────────────────────────────────────────────── */
async function loadAppointmentsHtml(detailUrl) {
  const html = await httpGet(detailUrl, { Referer: "https://www.nhs.uk/" });
  if (!html) return null;

  const $ = cheerio.load(html);
  let href =
    $('a[href*="/appointments"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href") ||
    $('a[href*="appointments-and-opening-times"]').attr("href") ||
    $('a[href*="opening-times"]').attr("href");

  if (!href) return html; // fall back to detail text
  const apptUrl = new URL(href, detailUrl).toString();
  const apptHtml = await httpGet(apptUrl, { Referer: detailUrl });
  return apptHtml || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

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
   Scan job
──────────────────────────────────────────────────────────────── */
async function discoverDetailUrls(postcode, radiusMiles) {
  const set = new Set();

  // NHS Search first
  try {
    const a = await discoverViaNhsSearch(postcode, radiusMiles);
    a.forEach((u) => set.add(u));
  } catch {}

  // DDG fallback
  if (set.size < 30) {
    try {
      const b = await discoverViaDuckDuckGo(postcode, radiusMiles);
      b.forEach((u) => set.add(u));
    } catch {}
  }

  // Trim to a sensible cap
  return Array.from(set).slice(0, 150);
}

async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan (HTML/search): ${postcode} (${radiusMiles} miles) ---`);

  const detailUrls = await discoverDetailUrls(postcode, radiusMiles);
  console.log(`[DISCOVERY] Found ${detailUrls.length} dentist detail URL(s).`);

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
          // keep scanning
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
    await postmarkEmail(recipients, subject, body);
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
    { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } },
  ]);
  return rows.map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).filter(validEmail),
  }));
}

export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);
  console.log("🦷 DentistRadar: Using HTML search-based scanner");
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
      childOnly: res.childOnly.length,
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
