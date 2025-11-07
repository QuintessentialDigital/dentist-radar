/**
 * DentistRadar — scanner.js (v6.3)
 * HTML-first, v1.9-style discovery + acceptance
 * Improvements:
 *  - Cookie jar + pre-seeded NHS consent cookie (avoids empty/shell HTML)
 *  - Realistic browser headers
 *  - Same multi-URL discovery and robust link extraction
 *  - Appointments page acceptance classifier (ACCEPTING / CHILD_ONLY / NONE)
 *  - Postmark email + per-day dedupe
 */

import axios from "axios";
import { wrapper as axiosCookieJarSupport } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
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

  // Optional extra debug (prints titles, first 400 chars, etc.)
  DEBUG_DISCOVERY = "false"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";

/* ────────────────────────────────────────────────────────────────
   Axios + Cookie jar
──────────────────────────────────────────────────────────────── */
const jar = new CookieJar();
axiosCookieJarSupport(axios);
const client = axios.create({ jar, withCredentials: true });

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

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
};

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

async function httpGet(url, referer = "https://www.nhs.uk/") {
  try {
    const res = await client.get(url, {
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
   Consent seeding
   (avoid empty shells by telling NHS we've accepted cookies)
──────────────────────────────────────────────────────────────── */
async function seedConsent() {
  // Add a likely consent cookie; if NHS changes name/value, a homepage GET will still set the right cookies into the jar.
  try {
    await jar.setCookie("nhsuk-cookie-consent=accepted; Domain=nhs.uk; Path=/; Max-Age=31536000; SameSite=Lax", "https://www.nhs.uk/");
  } catch {}
  // Touch homepage to pick up any Set-Cookie the site needs:
  await httpGet("https://www.nhs.uk/");
}

/* ────────────────────────────────────────────────────────────────
   Build NHS results URLs (broad set)
──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  const urls = [];
  const pages = 10;
  const resultSizes = [24, 48, 96];

  // A) /results/<PC>?distance=R[&page=N][&results=X]
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
    for (const size of resultSizes) {
      urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${page > 1 ? `&page=${page}` : ""}&results=${size}`);
    }
  }

  // B) /results/<PC>&distance=R[&page=N]  (user-reported)
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
  }

  // C) /results?postcode=<PC>&distance=R[&page=N][&results=X]
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
    for (const size of resultSizes) {
      urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}&results=${size}`);
    }
  }

  // D) “other-services” legacy
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
  }

  return Array.from(new Set(urls));
}

/* ────────────────────────────────────────────────────────────────
   Extract detail URLs
──────────────────────────────────────────────────────────────── */
function extractDetailUrlsFromResults(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  const push = (href) => {
    if (!href) return;
    const abs = href.startsWith("http")
      ? href
      : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) {
      out.add(abs.split("#")[0]);
    }
  };

  // A) Common link styles
  $('a.nhsuk-card__link, a.nhsuk-list-card__link, a.nhsuk-link--no-visited-state, a[href^="/services/dentists/"], a[href*="/services/dentists/"]').each((_, a) => {
    push($(a).attr("href"));
  });

  // B) Any anchor in list/grid containers
  $('.nhsuk-grid-row a, .nhsuk-list a, ul li a, ol li a').each((_, a) => {
    const href = $(a).attr("href") || "";
    if (/\/services\/dentists\//i.test(href)) push(href);
  });

  // C) JSON-LD blobs
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const txt = $(s).text() || "";
      const json = JSON.parse(txt);
      const collect = (node) => {
        if (!node) return;
        if (typeof node === "string") {
          if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(node)) push(node);
          return;
        }
        if (Array.isArray(node)) return node.forEach(collect);
        if (typeof node === "object") {
          for (const k of Object.keys(node)) collect(node[k]);
        }
      };
      collect(json);
    } catch {}
  });

  // D) Hydration scripts (Next/React) — regex sweep
  $('script:not([src])').each((_, s) => {
    const txt = $(s).html() || "";
    const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
    const matches = txt.match(rx);
    if (matches) matches.forEach((m) => out.add(m.split("#")[0]));
  });

  // E) Raw HTML catch-all
  const body = $.root().html() || "";
  const rxAll = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
  const hits = body.match(rxAll);
  if (hits) hits.forEach((m) => out.add(m.split("#")[0]));

  return Array.from(out);
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

  if (!href) return html; // fall back to detail text
  const apptUrl = new URL(href, detailUrl).toString();
  const apptHtml = await httpGet(apptUrl, detailUrl);
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
    await client.post(
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
   Discovery + Scan job
──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  const urls = [];
  const pages = 10;
  const resultSizes = [24, 48, 96];

  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
    for (const size of resultSizes) {
      urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${page > 1 ? `&page=${page}` : ""}&results=${size}`);
    }
  }
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
  }
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
    for (const size of resultSizes) {
      urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${page > 1 ? `&page=${page}` : ""}&results=${size}`);
    }
  }
  for (let page = 1; page <= pages; page++) {
    urls.push(`${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${page > 1 ? `&page=${page}` : ""}`);
  }
  return Array.from(new Set(urls));
}

async function discoverDetailUrls(postcode, radiusMiles) {
  await seedConsent(); // <<< important
  const urlsToTry = buildResultUrls(postcode, radiusMiles);
  const detailSet = new Set();

  for (const url of urlsToTry) {
    const html = await httpGet(url);
    if (!html) continue;

    // Debug helpers
    if (DEBUG) {
      const $ = cheerio.load(html);
      const title = normText($("title").first().text());
      console.log(`[PAGE] ${url} — <title>: "${title}" len=${html.length}`);
      console.log(`[SNIP] ${normText($.text()).slice(0, 400)}`);
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
          // continue
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
  if (mongoose.connection.readyState !== 1) {
    await connectMongo(MONGO_URI);
  }
  console.log("🦷 DentistRadar: Using HTML (public site) scanner + cookies");
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
