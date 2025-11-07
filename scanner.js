/**
 * DentistRadar — scanner.js (v6.6.1)
 * - HTML discovery with stronger browser headers (local)
 * - Optional UK-edge discovery via DISCOVERY_PROXY_URL (Cloudflare/Vercel)
 * - Appointments acceptance parsing + Postmark email + Mongo EmailLog dedupe
 * - No extra npm deps
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

  // Optional UK-edge discovery endpoint that returns { urls: [] }
  DISCOVERY_PROXY_URL = ""
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";

/* ────────────────────────────────────────────────────────────────
   Mongo models
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
   HTTP utils (enhanced browser headers + manual cookies)
──────────────────────────────────────────────────────────────── */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-GB,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
  // client hints – many CDNs use these to decide SSR content
  "sec-ch-ua": '"Chromium";v="120", "Not=A?Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  // consent cookie to bypass banners
  "Cookie": "nhsuk-cookie-consent=accepted",
  // nudge towards UK (some edges look at xff; harmless if ignored)
  "X-Forwarded-For": "81.2.69.142"  // a public UK IP (BT range)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGet(url, referer = "https://www.nhs.uk/") {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: { ...BASE_HEADERS, Referer: referer },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500
    });
    const body = String(res.data || "");
    if (res.status >= 400) return null;
    if (!body || body.length < 200) return null;
    return body;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────
   Build NHS results URLs (single definition)
──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  const urls = [];
  const pages = 10;
  const sizes = [24, 48, 96];

  // /results/<PC>?distance=R[&page=N][&results=X]
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes)
      urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
  }
  // /results/<PC>&distance=R[&page=N]
  for (let p = 1; p <= pages; p++)
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
  // querystring variant
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes)
      urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
  }
  // legacy
  for (let p = 1; p <= pages; p++)
    urls.push(`${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);

  return Array.from(new Set(urls));
}

/* ────────────────────────────────────────────────────────────────
   Extract dentist detail URLs from results HTML
──────────────────────────────────────────────────────────────── */
function extractDetailUrlsFromResults(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  const push = (href) => {
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) out.add(abs.split("#")[0]);
  };

  $('a[href*="/services/dentists/"]').each((_, a) => push($(a).attr("href")));

  // JSON-LD & hydration scripts
  $('script[type="application/ld+json"], script:not([src])').each((_, s) => {
    const txt = $(s).text() || "";
    const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
    const matches = txt.match(rx);
    if (matches) matches.forEach((m) => out.add(m.split("#")[0]));
  });

  // raw HTML catch-all
  const raw = $.root().html() || "";
  const rx2 = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
  const hits = raw.match(rx2);
  if (hits) hits.forEach((m) => out.add(m.split("#")[0]));

  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Appointments → acceptance classify
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

  if (!href) return html;
  const apptUrl = new URL(href, detailUrl).toString();
  const apptHtml = await httpGet(apptUrl, detailUrl);
  return apptHtml || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  $("h1,h2,h3").each((_, h) => {
    const heading = String($(h).text() || "").trim().toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 25) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol"].includes(tag)) section.push(String(cur.text() || "").replace(/\s+/g, " ").trim());
        cur = cur.next(); hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  if (!buckets.length) buckets.push(String($.root().text() || "").replace(/\s+/g, " ").trim());
  buckets.sort((a,b)=> b.length - a.length);
  return buckets[0] || "";
}

function classifyAcceptance(text) {
  const t = String(text || "").replace(/\s+/g, " ").replace(/’/g, "'").trim().toLowerCase();
  const childOnly =
    (t.includes("only accepts") || t.includes("currently only accepts") || t.includes("accepting only")) &&
    (t.includes("children") || /under\s*18/.test(t) || t.includes("aged 17 or under"));
  const accepting =
    t.includes("this dentist currently accepts new nhs patients") ||
    ((t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting") || t.includes("currently accepting")) &&
     t.includes("nhs patients") && !childOnly);
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
   Discovery: local → then proxy if needed
──────────────────────────────────────────────────────────────── */
async function discoverDetailUrlsLocal(postcode, radiusMiles) {
  const urlsToTry = buildResultUrls(postcode, radiusMiles);
  const detailSet = new Set();

  for (const url of urlsToTry) {
    const html = await httpGet(url);
    if (!html) continue;

    if (DEBUG) {
      const $ = cheerio.load(html);
      const title = String($("title").first().text() || "").replace(/\s+/g, " ").trim();
      console.log(`[PAGE] ${url} — <title>: "${title}" len=${html.length}`);
    }

    const details = extractDetailUrlsFromResults(html);
    if (details.length) {
      console.log(`[PAGE LINKS] ${url} → ${details.length} dentist links`);
      details.forEach((u) => detailSet.add(u));
    }

    await sleep(120);
    if (detailSet.size >= 80) break;
  }

  return Array.from(detailSet);
}

async function discoverDetailUrlsViaProxy(postcode, radiusMiles) {
  if (!DISCOVERY_PROXY_URL) return [];
  try {
    const res = await axios.post(
      DISCOVERY_PROXY_URL,
      { postcode, radius: radiusMiles },
      { timeout: 15000, headers: { "Content-Type": "application/json" } }
    );
    const urls = Array.isArray(res.data?.urls) ? res.data.urls : [];
    return urls.filter(u => /^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(u));
  } catch (e) {
    console.log("[PROXY] Discovery failed:", e?.response?.status || e?.message);
    return [];
  }
}

async function discoverDetailUrls(postcode, radiusMiles) {
  // 1) Try locally with strong headers
  let urls = await discoverDetailUrlsLocal(postcode, radiusMiles);
  if (urls.length) return urls;

  // 2) Fallback to UK-edge proxy if configured
  if (DISCOVERY_PROXY_URL) {
    console.log("[DISCOVERY] Local yielded 0, trying proxy…");
    urls = await discoverDetailUrlsViaProxy(postcode, radiusMiles);
  }
  return urls;
}

/* ────────────────────────────────────────────────────────────────
   Scan job
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
        } catch {}
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
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

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
  console.log("🦷 DentistRadar: HTML scanner (local → proxy fallback)");
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
    .catch((e) => { console.error(e); process.exit(1); });
}
