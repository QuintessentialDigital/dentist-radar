/**
 * DentistRadar — scanner.js (Playwright discovery, axios parsing) — v3.2
 * - Discovers NHS dentist detail URLs from postcode+radius using a real browser (Playwright).
 * - Loads each practice's Appointments page and classifies acceptance using your canonical messages.
 * - Emails watchers via Postmark. De-duplicates per practice URL per day in EmailLog.
 *
 * Mongo collections used: Watch, Postcodes, EmailLog (no Practices table needed).
 *
 * REQUIRED ENV:
 *   MONGO_URI
 *   POSTMARK_SERVER_TOKEN
 *   EMAIL_FROM
 *
 * OPTIONAL ENV:
 *   POSTMARK_MESSAGE_STREAM="outbound"
 *   MAX_CONCURRENCY="6"
 *   INCLUDE_CHILD_ONLY="false"
 *   DEBUG_APPTS="0|1"
 *   POSTCODE_COORDS="RG41 4UW:51.411,-0.864;SW1A 1AA:51.501,-0.142"
 *   HEADLESS="true"      // Playwright headless mode
 *   PW_SLOWMO="0"        // e.g. "250" for debug
 *
 * package.json (ensure):
 *   "dependencies": {
 *     "@playwright/test": "^1.48.2", "axios": "^1.7.8", "axios-retry": "^3.9.1",
 *     "cheerio": "^1.0.0", "dayjs": "^1.11.13", "mongoose": "^8.7.0", "p-limit": "^5.0.0"
 *   },
 *   "scripts": { "postinstall": "npx playwright install --with-deps chromium" }
 */

import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import dayjs from "dayjs";
import axiosRetry from "axios-retry";
import mongoose from "mongoose";
import { chromium } from "@playwright";

/* ─────────────────────────
   ENV
   ───────────────────────── */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  DEBUG_APPTS = "0",
  POSTCODE_COORDS = "",
  HEADLESS = "true",
  PW_SLOWMO = "0"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const DEBUG = String(DEBUG_APPTS) === "1";

/* ─────────────────────────
   Mongo models (guarded)
   ───────────────────────── */
function getModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

const WatchSchema = new mongoose.Schema(
  { email: String, postcode: String, radius: Number },
  { collection: "Watch", timestamps: true, versionKey: false }
);
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const EmailLogSchema = new mongoose.Schema(
  {
    practiceUrl: String,
    dateKey: String, // YYYY-MM-DD
    status: { type: String, enum: ["ACCEPTING", "CHILD_ONLY", "WELCOME", "OTHER"] },
    to: String,
    subject: String,
    providerId: String,
    sentAt: { type: Date, default: Date.now }
  },
  { collection: "EmailLog", versionKey: false }
);
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true });

const PostcodeSchema = new mongoose.Schema(
  { postcode: { type: String, unique: true, index: true }, lat: Number, lon: Number },
  { collection: "Postcodes", versionKey: false }
);

const Watch = getModel("Watch", WatchSchema);
const EmailLog = getModel("EmailLog", EmailLogSchema);
const Postcode = getModel("Postcode", PostcodeSchema);

let connectingPromise = null;
async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = mongoose.connect(uri, { maxPoolSize: 10 }).finally(() => { connectingPromise = null; });
  return connectingPromise;
}

/* ─────────────────────────
   HTTP helpers
   ───────────────────────── */
axiosRetry(axios, {
  retries: 3,
  retryDelay: (n) => 700 * n + Math.floor(Math.random() * 300),
  retryCondition: (e) => {
    const s = e?.response?.status;
    return !s || [429, 403, 404, 410, 408, 500, 502, 503, 504].includes(s);
  }
});

async function httpGet(url) {
  try {
    const { data, status } = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
        "Accept-Language": "en-GB,en;q=0.9"
      },
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });
    if (status >= 300) return null;
    return data;
  } catch (e) {
    console.error("[GET]", url, e?.response?.status || e?.message);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────────────────
   Utils
   ───────────────────────── */
const normText = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

function parsePostcodeCoordsEnv(raw) {
  const map = new Map();
  String(raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [pcRaw, coords] = pair.split(":").map((s) => (s || "").trim());
      if (!pcRaw || !coords) return;
      const [latStr, lonStr] = coords.split(",").map((s) => (s || "").trim());
      const lat = Number(latStr),
        lon = Number(lonStr);
      if (Number.isFinite(lat) && Number.isFinite(lon)) map.set(normPc(pcRaw), { lat, lon });
    });
  return map;
}
const POSTCODE_COORDS_MAP = parsePostcodeCoordsEnv(POSTCODE_COORDS);

async function coordsForPostcode(pcRaw) {
  const pc = normPc(pcRaw);
  if (!pc) return null;
  if (POSTCODE_COORDS_MAP.has(pc)) return POSTCODE_COORDS_MAP.get(pc);
  const doc = await Postcode.findOne({ postcode: pc }).select("lat lon").lean();
  if (!doc) return null;
  return { lat: doc.lat, lon: doc.lon };
}
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ─────────────────────────
   Watch → jobs
   ───────────────────────── */
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

/* ─────────────────────────
   Playwright discovery (supports query & path-style NHS URLs)
   ───────────────────────── */
function buildResultsUrls(pc, radiusMiles) {
  const enc = encodeURIComponent(pc);
  const r = Math.max(1, Math.min(30, Math.round(radiusMiles)));
  const urls = new Set();

  // Query-string family
  urls.add(`https://www.nhs.uk/service-search/find-a-dentist/results?postcode=${enc}&distance=${r}`);
  urls.add(`https://www.nhs.uk/service-search/find-a-dentist/results?postcode=${enc}&distance=${r}&results=24`);

  // Path-style family (what you highlighted)
  urls.add(`https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}`);
  urls.add(`https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}&results=24`);

  // Legacy fallback
  urls.add(`https://www.nhs.uk/service-search/other-services/Dentists/Location/${enc}?results=24&distance=${r}`);

  // Paginate up to 6 pages for each base
  const bases = Array.from(urls);
  for (const base of bases) {
    for (let p = 2; p <= 6; p++) {
      const sep = base.includes("?") ? "&" : "?";
      urls.add(`${base}${sep}page=${p}`);
    }
  }
  return Array.from(urls);
}

async function collectDetailLinksOnPage(page) {
  return await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      try {
        const abs = new URL(href, location.href).toString();
        if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs) && !/\/appointments/i.test(abs)) {
          out.add(abs.split("#")[0]);
        }
      } catch {}
    });
    return Array.from(out);
  });
}

async function discoverDetailUrlsWithPlaywright(postcode, radiusMiles) {
  const urls = new Set();
  const browser = await chromium.launch({
    headless: String(HEADLESS).toLowerCase() !== "false",
    slowMo: Math.max(0, Number(PW_SLOWMO) || 0)
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    locale: "en-GB"
  });
  const page = await context.newPage();

  try {
    const candidates = buildResultsUrls(postcode, radiusMiles);
    for (const u of candidates) {
      try {
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1200); // allow hydration
        const first = await collectDetailLinksOnPage(page);
        first.forEach((x) => urls.add(x));

        // Try "Next" pagination if available
        for (let i = 0; i < 5; i++) {
          const next = await page.locator('a:has-text("Next"), a[aria-label="Next"], nav a[rel="next"]').first();
          if (!(await next.count())) break;
          await next.click().catch(() => {});
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(800);
          const more = await collectDetailLinksOnPage(page);
          let added = 0;
          more.forEach((x) => { if (!urls.has(x)) { urls.add(x); added++; } });
          if (added === 0) break;
        }
      } catch (e) {
        console.log("[PW] skip:", u, "-", e?.message || e);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`[DISCOVERY] Playwright collected ${urls.size} detail URL(s).`);
  return Array.from(urls);
}

/* ─────────────────────────
   Appointments loader
   ───────────────────────── */
async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  if (/\/appointments(\/|$|\?|#)/i.test(detailsUrl)) return httpGet(detailsUrl);

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) {
    try {
      const fallback = new URL("appointments", detailsUrl).toString();
      const html = await httpGet(fallback);
      if (html) return html;
    } catch {}
    return null;
  }

  const $ = cheerio.load(detailsHtml);
  let href;
  const labels = ["appointments", "appointments and opening times", "appointments & opening times", "opening times"];
  $("a").each((_, el) => {
    const t = normText($(el).text()).toLowerCase();
    if (labels.some((l) => t.includes(l))) { href = $(el).attr("href"); if (href) return false; }
  });
  if (!href) href = $('a[href*="/appointments"]').first().attr("href");
  if (!href) href = $('a[href*="appointments-and-opening-times"]').first().attr("href");
  if (!href) href = $('a[href*="opening-times"]').first().attr("href");

  if (!href) return { __inline__: true, html: detailsHtml };

  const apptUrl = new URL(href, detailsUrl).toString();
  return httpGet(apptUrl);
}

/* ─────────────────────────
   Extract + classify (acceptance)
   ───────────────────────── */
function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  $("h1,h2,h3").each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(); let hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol"].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next(); hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) candidates.push(joined);
    }
  });

  const wrappers = ["main",".nhsuk-main-wrapper","#content","#maincontent",".nhsuk-u-reading-width",".nhsuk-width-container"];
  for (const sel of wrappers) {
    const t = normText($(sel).text());
    if (t && t.length > 80) candidates.push(t);
  }

  const notices = [".nhsuk-inset-text",".nhsuk-warning-callout",".nhsuk-notification-banner__content",".nhsuk-panel"];
  for (const sel of notices) {
    $(sel).each((_, el) => { const t = normText($(el).text()); if (t) candidates.push(t); });
  }

  if (!candidates.length) candidates.push(normText($.root().text()));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || "";
}

function classifyAcceptance(raw) {
  const t = normText(String(raw || "")).replace(/’/g, "'");

  const childOnly =
    ((/(only\s+accepts?|currently\s+only\s+accepts?|accepting\s+only)\s+(new\s+)?nhs\s+patients/i.test(t) &&
      /children\s+(aged\s+17\s+or\s+under|only|under\s*18)/i.test(t)) ||
     /this dentist currently only accepts? new nhs patients.*children\s+aged\s+17\s+or\s+under/i.test(t));

  const accepting =
    /this dentist currently accepts? new nhs patients/i.test(t) ||
    (/(accepts|is accepting|are accepting|currently accepting)\s+(new\s+)?nhs\s+patients/i.test(t) && !childOnly);

  const notConfirmed =
    /this dentist has not confirmed if they currently accept new nhs patients/i.test(t) ||
    /has\s+not\s+confirmed\s+if\s+.*accept/i.test(t);

  if (childOnly) return { status: "CHILD_ONLY" };
  if (accepting) return { status: "ACCEPTING" };
  if (notConfirmed) return { status: "NOT_CONFIRMED" };
  return { status: "NOT_CONFIRMED" };
}

/* ─────────────────────────
   Email via Postmark
   ───────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN, Accept: "application/json", "Content-Type": "application/json" }, timeout: 10000 }
    );
    console.log(`Email sent → ${toList.length} recipient(s): ${subject}`);
  } catch (e) {
    console.error("Postmark send error:", e?.response?.data || e?.message);
  }
}

/* ─────────────────────────
   Core scan (one job)
   ───────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) — Playwright results discovery ---`);

  const centre = await coordsForPostcode(postcode);
  if (!centre) {
    console.log("[WARN] No coords for job postcode. Add to Postcodes or use POSTCODE_COORDS.");
    return { accepting: [], childOnly: [] };
  }

  // 1) Discover detail URLs with Playwright
  const detailUrls = await discoverDetailUrlsWithPlaywright(postcode, radiusMiles);
  if (!detailUrls.length) {
    console.log("[INFO] No practice detail URLs discovered for this postcode this run.");
    return { accepting: [], childOnly: [] };
  }

  // Postcode extraction helper for distance filtering
  const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/gi;
  const extractPracticePostcode = (html) => {
    const text = normText(cheerio.load(html).root().text()).toUpperCase();
    let best = null, m;
    while ((m = UK_POSTCODE_RE.exec(text)) !== null) best = normPc(m[1]);
    return best;
  };

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");
  const accepting = [];
  const childOnly = [];

  await Promise.all(detailUrls.map(detailsUrl => limit(async () => {
    const exists = await EmailLog.findOne({ practiceUrl: detailsUrl, dateKey }).lean();
    if (exists) return;

    // Distance filtering (grab details or appointments html)
    let detailsHtml = await httpGet(detailsUrl);
    if (!detailsHtml) {
      const apptTry = await loadAppointmentsHtml(detailsUrl);
      detailsHtml = typeof apptTry === "string" ? apptTry : apptTry?.__inline__?.html ? apptTry.html : "";
      if (!detailsHtml) return;
    }
    let pc = extractPracticePostcode(detailsHtml);
    if (!pc) {
      const apptRes = await loadAppointmentsHtml(detailsUrl);
      const apptHtml = typeof apptRes === "string" ? apptRes : apptRes?.__inline__?.html ? apptRes.html : "";
      if (!apptHtml) return;
      pc = extractPracticePostcode(apptHtml);
      detailsHtml = apptHtml;
    }
    if (!pc) return;

    const pcoords = await coordsForPostcode(pc);
    if (!pcoords) return;
    const miles = haversineMiles(centre.lat, centre.lon, pcoords.lat, pcoords.lon);
    if (miles > radiusMiles) return;

    // Ensure appointments HTML
    let apptHtml;
    if (/\/appointments(\/|$|\?|#)/i.test(detailsUrl) && detailsHtml) {
      apptHtml = detailsHtml;
    } else {
      const apptRes = await loadAppointmentsHtml(detailsUrl);
      apptHtml = typeof apptRes === "string" ? apptRes : apptRes?.__inline__?.html ? apptRes.html : "";
      if (!apptHtml) return;
    }

    // Classify acceptance
    const section = extractAppointmentsText(apptHtml);
    const verdict = classifyAcceptance(section);

    if (verdict.status === "ACCEPTING") {
      accepting.push({ url: detailsUrl, postcode: pc, distanceMiles: miles });
      await EmailLog.create({ practiceUrl: detailsUrl, dateKey, status: "ACCEPTING" });
    } else if (verdict.status === "CHILD_ONLY" && INCLUDE_CHILD) {
      childOnly.push({ url: detailsUrl, postcode: pc, distanceMiles: miles });
      await EmailLog.create({ practiceUrl: detailsUrl, dateKey, status: "CHILD_ONLY" });
    } else if (DEBUG) {
      console.log("[DEBUG NO-MATCH]", detailsUrl, "→", section.slice(0, 300));
    }
  })));

  // Email watchers for this postcode
  if (recipients?.length && (accepting.length || childOnly.length)) {
    const lines = [];
    const render = (arr, label) => {
      lines.push(`<b>${label}</b> — ${arr.length}<br>`);
      arr.sort((a,b)=> (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
         .forEach((p,i)=> lines.push(`${i+1}. ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? "?"} mi — <a href="${p.url}">${p.url}</a><br>`));
      lines.push("<br>");
    };
    if (accepting.length) render(accepting, "Accepting (adults/all)");
    if (childOnly.length) render(childOnly, "Children-only");

    const subject = `DentistRadar: ${postcode} (${radiusMiles} mi) — ${accepting.length} accepting${INCLUDE_CHILD ? `, ${childOnly.length} child-only` : ""}`;
    const body = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">
        <h3 style="margin:0 0 8px">DentistRadar – ${postcode} (${radiusMiles} mi)</h3>
        <div style="color:#666;margin:0 0 10px">${dayjs().format("YYYY-MM-DD HH:mm")}</div>
        ${lines.join("\n")}
        <hr style="border:0;border-top:1px solid #eee;margin:12px 0">
        <div style="font-size:12px;color:#777">We scan the <b>Appointments</b> page only (NHS site). Please call the practice to confirm before travelling.</div>
      </div>
    `;
    await sendEmail(recipients, subject, body);
  } else {
    if (!recipients?.length) console.log("No recipients for this postcode; skipping email.");
    else console.log("No accepting/children-only results; no email sent.");
  }

  return { accepting, childOnly };
}

/* ─────────────────────────
   Exported runner
   ───────────────────────── */
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
    await sleep(250);
  }

  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

// CLI support
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
