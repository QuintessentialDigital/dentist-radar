/**
 * DentistRadar — scanner.js (LEGACY+, resilient discovery)
 * -------------------------------------------------------
 * Why previous runs returned 0:
 *  • NHS results can be JS-rendered / consent-gated / AB-tested for Render IPs
 *  • Plain axios GET sees only a shell → no /services/dentist... links
 *
 * Fixes in this file:
 *  • Sends cookie consent + realistic headers on "direct"
 *  • Optional rendered HTML via DISCOVERY_PROVIDER = scrapingbee | browserless
 *  • Follows rel="next" pagination instead of guessing page numbers
 *  • Longer timeouts + retry backoff on slow/429/5xx
 *  • Broader link extraction (anchors, JSON blobs, raw HTML; dentist or dentists)
 *  • Robust appointments resolution and acceptance classification
 *
 * Env (set on BOTH web & cron in Render):
 *  MONGO_URI
 *  EMAIL_FROM
 *  POSTMARK_SERVER_TOKEN (or POSTMARK_TOKEN)
 *  POSTMARK_MESSAGE_STREAM=outbound
 *  INCLUDE_CHILD_ONLY=false
 *  MAX_CONCURRENCY=6
 *  DISCOVERY_PROVIDER=direct | scrapingbee | browserless
 *  SCRAPINGBEE_KEY=...            (if provider=scrapingbee)
 *  BROWSERLESS_TOKEN=...          (if provider=browserless)
 *  DISCOVERY_REQUEST_TIMEOUT_MS=60000
 *  DISCOVERY_RETRY=3
 *  DEBUG_DISCOVERY=false
 */

import axios from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ────────────────────────────────────────────────────────────────
   ENV / knobs
──────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",
  INCLUDE_CHILD_ONLY = "false",
  MAX_CONCURRENCY = "6",

  DISCOVERY_PROVIDER = "direct",         // direct|scrapingbee|browserless
  SCRAPINGBEE_KEY = "",
  BROWSERLESS_TOKEN = "",
  DISCOVERY_REQUEST_TIMEOUT_MS = "60000", // 60s default
  DISCOVERY_RETRY = "3",
  DEBUG_DISCOVERY = "false",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const CONCURRENCY   = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const REQUEST_TIMEOUT = Math.max(10000, Number(DISCOVERY_REQUEST_TIMEOUT_MS) || 60000);
const RETRIES         = Math.max(0, Number(DISCOVERY_RETRY) || 3);
const DEBUG           = String(DEBUG_DISCOVERY).toLowerCase() === "true";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

/* ────────────────────────────────────────────────────────────────
   Axios client with retry/backoff
──────────────────────────────────────────────────────────────── */
const client = axios.create({
  timeout: REQUEST_TIMEOUT,
  maxRedirects: 7,
  decompress: true,
  validateStatus: () => true,
  headers: {
    "User-Agent": UA,
    "Accept-Language": "en-GB,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "no-cache",
    // Pre-accept cookies (bypass consent walls where possible)
    Cookie: "nhsuk-cookie-consent=accepted; nhsuk-patient-preferences=accepted",
    Connection: "keep-alive",
  },
});

axiosRetry(client, {
  retries: RETRIES,
  retryDelay: axiosRetry.exponentialDelay,
  shouldResetTimeout: true,
  retryCondition: (err) => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
    const s = err?.response?.status || 0;
    return s === 408 || s === 429 || (s >= 500 && s < 600);
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();

/* ────────────────────────────────────────────────────────────────
   Providers: direct | scrapingbee | browserless
──────────────────────────────────────────────────────────────── */
async function getDirect(url) {
  const res = await client.get(url);
  if (DEBUG) console.log(`[DIRECT] ${url} → ${res.status} len=${(res.data || "").length}`);
  // Even 404/410 can contain useful HTML; don’t drop it blindly.
  if (typeof res.data === "string") return res.data;
  return "";
}

async function getViaScrapingBee(url) {
  if (!SCRAPINGBEE_KEY) return "";
  const api = "https://app.scrapingbee.com/api/v1";
  const res = await client.get(api, {
    params: {
      api_key: SCRAPINGBEE_KEY,
      url,
      render_js: "true",
      country_code: "gb",
      premium_proxy: "true",
    },
  });
  if (DEBUG) console.log(`[SCRAPINGBEE] ${url} → ${res.status} len=${(res.data || "").length}`);
  if (typeof res.data === "string") return res.data;
  return "";
}

async function getViaBrowserless(url) {
  if (!BROWSERLESS_TOKEN) return "";
  const api = `https://chrome.browserless.io/content?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}&url=${encodeURIComponent(url)}`;
  const res = await client.get(api);
  if (DEBUG) console.log(`[BROWSERLESS] ${url} → ${res.status} len=${(res.data || "").length}`);
  if (typeof res.data === "string") return res.data;
  return "";
}

async function fetchPage(url) {
  const mode = (DISCOVERY_PROVIDER || "direct").toLowerCase();
  let html = "";
  try {
    if (mode === "scrapingbee") html = await getViaScrapingBee(url);
    else if (mode === "browserless") html = await getViaBrowserless(url);
    else html = await getDirect(url);

    if (!html && mode !== "direct") {
      // graceful fallback to direct
      html = await getDirect(url);
    }
  } catch (e) {
    if (DEBUG) console.log(`[FETCH ERR] ${url} → ${e?.message}`);
  }
  if (DEBUG && html) {
    const peek = html.replace(/\s+/g, " ").slice(0, 600);
    console.log(`[PEEK] ${url} >> ${peek}`);
  }
  return html || "";
}

/* ────────────────────────────────────────────────────────────────
   NHS results URLs (two legacy shapes)
──────────────────────────────────────────────────────────────── */
function resultsUrlVariants(postcode, radius) {
  const pc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  return [
    // Path variant you’ve confirmed before
    `${base}/service-search/find-a-dentist/results/${pc}&distance=${radius}`,
    // Query variant
    `${base}/service-search/find-a-dentist/results?postcode=${pc}&distance=${radius}`,
  ];
}

/* ────────────────────────────────────────────────────────────────
   Follow pagination via rel="next"
──────────────────────────────────────────────────────────────── */
function findNextLink($) {
  const link =
    $('a[rel="next"]').attr("href") ||
    $('link[rel="next"]').attr("href") ||
    $('a:contains("Next")').attr("href") ||
    $('a.nhsuk-pagination__link[aria-label*="Next"]').attr("href");
  return link ? String(link) : "";
}

function absolutize(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

/* ────────────────────────────────────────────────────────────────
   Extract detail links (anchors + JSON + raw)
──────────────────────────────────────────────────────────────── */
function extractDetailUrlsFromResults(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  const RX = /https:\/\/www\.nhs\.uk\/services\/dentist[s]?\/[A-Za-z0-9\-/%?_.#=]+/g;

  const pushAbs = (href) => {
    if (!href) return;
    const abs = href.startsWith("http")
      ? href
      : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/^https:\/\/www\.nhs\.uk\/services\/dentist[s]?\//i.test(abs)) {
      out.add(abs.split("#")[0]);
    }
  };

  // A) Anchor tags
  $('a[href^="/services/dentist"], a[href*="/services/dentist"]').each((_, a) =>
    pushAbs($(a).attr("href"))
  );

  // B) Hydration / inline JSON
  $("script").each((_, s) => {
    if (s.attribs?.src) return;
    const txt = $(s).text() || "";
    const m = txt.match(RX);
    if (m) m.forEach((u) => out.add(u.split("#")[0]));
  });

  // C) Raw HTML sweep
  const body = typeof html === "string" ? html : $.root().html() || "";
  const hits = body.match(RX);
  if (hits) hits.forEach((u) => out.add(u.split("#")[0]));

  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Discover detail URLs (multi-variant + rel=next)
──────────────────────────────────────────────────────────────── */
async function discoverDetailUrls(postcode, radius) {
  const seen = new Set();
  const queue = [];
  const start = resultsUrlVariants(postcode, radius);
  start.forEach((u) => queue.push(u));

  // Crawl up to 8 pages total across variants (polite)
  while (queue.length && seen.size < 240 && queue.length < 12) {
    const url = queue.shift();
    const html = await fetchPage(url);
    if (!html) continue;

    // Extract details
    const links = extractDetailUrlsFromResults(html);
    links.forEach((u) => seen.add(u));

    // Follow rel=next if present
    const $ = cheerio.load(html);
    const nextHref = findNextLink($);
    if (nextHref) {
      const abs = absolutize(url, nextHref);
      if (abs && !queue.includes(abs)) queue.push(abs);
    }

    await sleep(120); // polite pause
  }
  return Array.from(seen);
}

/* ────────────────────────────────────────────────────────────────
   Appointments resolution + acceptance
──────────────────────────────────────────────────────────────── */
function findAppointmentsHref($) {
  let href =
    $('a[href*="/appointments"]').attr("href") ||
    $('a[href*="appointments-and-opening-times"]').attr("href") ||
    $('a[href*="opening-times"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href") ||
    $('a:contains("Opening times")').attr("href") ||
    $('a:contains("opening times")').attr("href");

  if (!href) {
    $('nav a, [role="navigation"] a, .nhsuk-navigation a, .nhsuk-list a').each((_, a) => {
      const t = String($(a).text() || "").toLowerCase();
      const h = $(a).attr("href") || "";
      if (!href && (t.includes("appointment") || t.includes("opening"))) href = h;
    });
  }
  return href || "";
}

async function resolveAppointmentsUrl(detailUrl) {
  const detailHtml = await fetchPage(detailUrl);
  if (!detailHtml) return "";

  const $ = cheerio.load(detailHtml);
  let href = findAppointmentsHref($);

  const candidates = new Set();
  if (href) candidates.add(absolutize(detailUrl, href));
  candidates.add(absolutize(detailUrl, "./appointments"));
  candidates.add(absolutize(detailUrl, "./appointments-and-opening-times"));
  candidates.add(absolutize(detailUrl, "./opening-times"));

  for (const u of candidates) {
    if (!u) continue;
    const html = await fetchPage(u);
    if (html && html.length > 200) return u;
  }
  return "";
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  // Prefer sections near headings
  $("h1,h2,h3").each((_, h) => {
    const heading = String($(h).text() || "").toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const buf = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 30) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol","section"].includes(tag)) {
          buf.push(String(cur.text()||"").replace(/\s+/g," ").trim());
        }
        cur = cur.next(); hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  if (!buckets.length) {
    // wider containers
    const wrappers = ["main", "#maincontent", ".nhsuk-main-wrapper", ".nhsuk-width-container", ".nhsuk-u-reading-width"];
    for (const sel of wrappers) {
      const t = String($(sel).text() || "").replace(/\s+/g," ").trim();
      if (t.length > 120) buckets.push(t);
    }
  }
  if (!buckets.length) buckets.push(String($.root().text() || "").replace(/\s+/g," ").trim());

  buckets.sort((a,b)=> b.length - a.length);
  return buckets[0] || "";
}

function classifyAcceptance(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g," ").replace(/’/g,"'");

  const mentionsNhs = t.includes("nhs") || t.includes("nhs patient") || t.includes("nhs patients");
  const mentionsAccept =
    t.includes("accepts") || t.includes("accepting") || t.includes("registering") || t.includes("taking on");
  const notAccept =
    t.includes("not accepting") || t.includes("no longer accepting") || t.includes("not currently accepting");

  const childOnly =
    (t.includes("only accepts") || t.includes("only accepting") || t.includes("children only")) &&
    (t.includes("children") || /under\s*18/.test(t) || /aged\s*(1[0-7]|[1-9])\s*or\s*under/.test(t));

  if (notAccept) return "NONE";
  if (childOnly) return "CHILD_ONLY";
  if (mentionsNhs && mentionsAccept && !t.includes("only")) return "ACCEPTING";

  // Very explicit phrasing
  if (t.includes("this dentist currently accepts new nhs patients")) return "ACCEPTING";
  if (t.includes("currently accepting new nhs patients")) return "ACCEPTING";
  if (t.includes("accepting new nhs patients")) return "ACCEPTING";

  if (t.includes("waiting list") || t.includes("register your interest")) return "NONE";
  return "UNKNOWN";
}

/* ────────────────────────────────────────────────────────────────
   Email via Postmark (HTML templates)
──────────────────────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  const token = POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN || "";
  if (!toList?.length || !token) return { ok: false };

  const res = await client.post(
    "https://api.postmarkapp.com/email",
    { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
    { headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json", Accept: "application/json" } }
  );
  return (res.status >= 200 && res.status < 300)
    ? { ok: true, id: res.data?.MessageID }
    : { ok: false, status: res.status, body: res.data };
}

/* ────────────────────────────────────────────────────────────────
   Jobs
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
    recipients: (r.emails || []).map((e) => String(e).trim().toLowerCase()).filter(validEmail),
  }));
}

/* ────────────────────────────────────────────────────────────────
   Scan pipeline
──────────────────────────────────────────────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);
  const detailUrls = await discoverDetailUrls(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${detailUrls.length}`);

  if (!detailUrls.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");
  const acceptingDetails = [];
  const childOnlyDetails = [];

  await Promise.all(
    detailUrls.map((detailUrl) =>
      limit(async () => {
        try {
          // per-practice daily dedupe to avoid spamming
          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          const apptUrl = await resolveAppointmentsUrl(detailUrl);
          if (!apptUrl) return;

          const apptHtml = await fetchPage(apptUrl);
          if (!apptHtml) return;

          const verdict = classifyAcceptance(extractAppointmentsText(apptHtml));

          const card = {
            name: undefined,
            address: undefined,
            appointmentUrl: apptUrl,
            detailUrl,
            phone: undefined,
            distanceMiles: undefined,
            lat: undefined,
            lon: undefined,
            checkedAt: new Date(),
          };

          if (verdict === "ACCEPTING") {
            acceptingDetails.push(card);
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "ACCEPTING", sentAt: new Date() });
          } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnlyDetails.push(card);
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "CHILD_ONLY", sentAt: new Date() });
          }
        } catch {
          // ignore individual page failures
        }
      })
    )
  );

  const shouldSend = acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);
  if (!shouldSend) {
    console.log("No accepting/eligible results; skipping email.");
    return { accepting: [], childOnly: [] };
  }
  if (!recipients?.length) {
    console.log("Recipients empty; not emailing.");
    return { accepting: acceptingDetails, childOnly: childOnlyDetails };
  }

  // Improved availability email (uses your template file)
  const practices = [...acceptingDetails, ...childOnlyDetails];
  const { subject, html } = renderEmail("availability", {
    postcode,
    radius: radiusMiles,
    practices,
    includeChildOnly: INCLUDE_CHILD,
  });
  await sendEmail(recipients, subject, html);
  return { accepting: acceptingDetails, childOnly: childOnlyDetails };
}

/* ────────────────────────────────────────────────────────────────
   Runner
──────────────────────────────────────────────────────────────── */
export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);

  console.log(
    `🦷 DentistRadar scanner — provider=${(DISCOVERY_PROVIDER||'direct')} timeout=${REQUEST_TIMEOUT}ms retries=${RETRIES}`
  );

  const jobs = await buildJobs(opts.postcode);
  if (!jobs.length) {
    console.log("[RESULT] No Watch entries.");
    return { jobs: 0, summaries: [] };
  }

  const summaries = [];
  for (const job of jobs) {
    console.log(`🔎 Scan ${job.postcode} (${job.radiusMiles} miles) → recipients: ${job.recipients.length}`);
    const res = await scanJob(job);
    summaries.push({
      postcode: job.postcode,
      radiusMiles: job.radiusMiles,
      accepting: res.accepting.length,
      childOnly: res.childOnly.length,
    });
    await sleep(120);
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
