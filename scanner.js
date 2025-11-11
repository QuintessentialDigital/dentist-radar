/**
 * DentistRadar — scanner.js (Simple mode vS1)
 * Strategy (requested):
 *  1) Discover practice detail URLs from NHS results pages.
 *  2) For each detail:
 *     - Try to resolve an Appointments link.
 *     - If found, parse appointments page; else parse detail page.
 *  3) Classify using exact / near-exact phrases (with basic negatives + child-only).
 *  4) Email via existing renderEmail template if any positives found.
 *
 * No new dependencies. Uses: axios, axios-retry, cheerio, mongoose, p-limit, dayjs
 */

import axios from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ================================
   ENV
================================== */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  DISCOVERY_REQUEST_TIMEOUT_MS = "60000",
  DISCOVERY_RETRY = "2",
  DEBUG_DISCOVERY = "false",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const TIMEOUT = Math.max(12000, Number(DISCOVERY_REQUEST_TIMEOUT_MS) || 60000);
const RETRIES = Math.max(0, Number(DISCOVERY_RETRY) || 2);
const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================
   HTTP client (retry)
================================== */
const http = axios.create({
  timeout: TIMEOUT,
  maxRedirects: 7,
  validateStatus: () => true,
  headers: {
    "User-Agent": UA,
    "Accept-Language": "en-GB,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Cache-Control": "no-cache",
    Cookie: "nhsuk-cookie-consent=accepted; nhsuk-patient-preferences=accepted",
    Connection: "keep-alive",
  },
});
axiosRetry(http, {
  retries: RETRIES,
  retryDelay: axiosRetry.exponentialDelay,
  shouldResetTimeout: true,
  retryCondition: (err) => {
    if (axiosRetry.isNetworkOrIdempotentRequestError(err)) return true;
    const s = err?.response?.status || 0;
    return s === 408 || s === 429 || (s >= 500 && s < 600);
  },
});

async function fetchPage(url) {
  try {
    const res = await http.get(url);
    if (DEBUG) console.log(`[GET] ${url} → ${res.status} (len=${(res.data || "").length})`);
    if (res.status >= 200 && res.status < 400 && typeof res.data === "string") return res.data;
    return "";
  } catch (e) {
    if (DEBUG) console.log(`[GET ERR] ${url} → ${e?.message}`);
    return "";
  }
}

/* ================================
   Discovery (results → detail URLs)
================================== */
function resultsUrlVariants(postcode, radius) {
  const pc = encodeURIComponent(String(postcode || "").toUpperCase().replace(/\s+/g, " ").trim());
  const base = "https://www.nhs.uk";
  // Two stable variants we’ve seen in your working runs
  return [
    `${base}/service-search/find-a-dentist/results/${pc}&distance=${radius}`,
    `${base}/service-search/find-a-dentist/results?postcode=${pc}&distance=${radius}`,
  ];
}
function absolutize(baseUrl, href) {
  try { return new URL(href, baseUrl).toString(); } catch { return ""; }
}
function relNext($) {
  const link =
    $('a[rel="next"]').attr("href") ||
    $('link[rel="next"]').attr("href") ||
    $('a:contains("Next")').attr("href") ||
    $('a.nhsuk-pagination__link[aria-label*="Next"]').attr("href");
  return link ? String(link) : "";
}
function textClean(s) {
  return String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function extractDetailUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();

  const push = (href) => {
    if (!href) return;
    const abs = absolutize(baseUrl, href);
    if (/^https:\/\/www\.nhs\.uk\/services\/dentist/.test(abs)) {
      urls.add(abs.split("#")[0]);
    }
  };

  // Obvious card links
  $('a[href^="/services/dentist"], a[href*="/services/dentist"], a.nhsuk-card__link').each((_, a) => {
    push($(a).attr("href"));
  });

  // Fallback: any script/hydration blobs
  $("script:not([src])").each((_, s) => {
    const txt = $(s).text() || "";
    const rx = /https:\/\/www\.nhs\.uk\/services\/dentist[^\s"'<>]*/g;
    const m = txt.match(rx);
    if (m) m.forEach((u) => urls.add(u.split("#")[0]));
  });

  // Last resort: raw HTML scan
  const body = $.root().html() || "";
  const rx2 = /https:\/\/www\.nhs\.uk\/services\/dentist[^\s"'<>]*/g;
  const hits = body.match(rx2);
  if (hits) hits.forEach((u) => urls.add(u.split("#")[0]));

  return Array.from(urls);
}

async function discoverPractices(postcode, radius) {
  const start = resultsUrlVariants(postcode, radius);
  const queue = [...start];
  const seen = new Set();
  const detail = new Set();

  while (queue.length && seen.size < 12) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const html = await fetchPage(url);
    if (!html) continue;

    extractDetailUrls(html, url).forEach((u) => detail.add(u));

    const $ = cheerio.load(html);
    const next = relNext($);
    if (next) {
      const abs = absolutize(url, next);
      if (abs && !seen.has(abs)) queue.push(abs);
    }
    await sleep(120);
  }

  return Array.from(detail);
}

/* ================================
   Appointments resolution
================================== */
const APPT_SLUGS = [
  "/appointments",
  "/appointments-and-opening-times",
  "/opening-times",
  "/patients-and-appointments",
  "/patients",
  "/registration",
  "/registering",
  "/who-we-can-accept",
];

function findAppointmentsHref($) {
  let href =
    $('a[href*="/appointments"]').attr("href") ||
    $('a[href*="appointments-and-opening-times"]').attr("href") ||
    $('a[href*="opening-times"]').attr("href") ||
    $('a[href*="patients-and-appointments"]').attr("href") ||
    $('a[href*="patients"]').attr("href") ||
    $('a[href*="registration"]').attr("href") ||
    $('a[href*="registering"]').attr("href") ||
    $('a[href*="who-we-can-accept"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href") ||
    $('a:contains("Opening times")').attr("href") ||
    $('a:contains("opening times")').attr("href") ||
    $('a:contains("Patients")').attr("href") ||
    $('a:contains("Register")').attr("href") ||
    $('a:contains("Who we can accept")').attr("href");

  if (!href) {
    $('nav a, [role="navigation"] a, .nhsuk-navigation a, .nhsuk-list a').each((_, a) => {
      const t = textClean($(a).text()).toLowerCase();
      const h = $(a).attr("href") || "";
      if (!href && (t.includes("appointment") || t.includes("open") || t.includes("register") || t.includes("patients"))) {
        href = h;
      }
    });
  }
  return href || "";
}

async function resolveAppointmentsUrl(detailUrl) {
  const detailHtml = await fetchPage(detailUrl);
  if (!detailHtml) return { apptUrl: "", fallbackHtml: "" };

  const $ = cheerio.load(detailHtml);
  const href = findAppointmentsHref($);

  const candidates = new Set();
  if (href) candidates.add(absolutize(detailUrl, href));
  APPT_SLUGS.forEach((slug) => candidates.add(absolutize(detailUrl, `.${slug}`)));

  for (const u of candidates) {
    if (!u) continue;
    const html = await fetchPage(u);
    if (html && html.length > 200) return { apptUrl: u, fallbackHtml: "" };
  }
  // No appointments page resolved → return detailHtml for scanning
  return { apptUrl: "", fallbackHtml: detailHtml };
}

/* ================================
   Text extraction (keep it simple)
================================== */
function extractScanText(html) {
  const $ = cheerio.load(html);
  const parts = [];

  // Prefer sections under relevant headings for better signal
  const rx = /(appointment|opening\s+times|patients|registration|register|who\s+we\s+can\s+accept|nhs)/i;
  $("h1,h2,h3").each((_, h) => {
    const head = textClean($(h).text()).toLowerCase();
    if (rx.test(head)) {
      const buf = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 60) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol","section"].includes(tag)) {
          const t = textClean(cur.text());
          if (t) buf.push(t);
        }
        cur = cur.next(); hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined.length > 60) parts.push(joined);
    }
  });

  // If nothing, just take the main content
  if (!parts.length) {
    const wrappers = ["main","#maincontent",".nhsuk-main-wrapper",".nhsuk-width-container",".nhsuk-u-reading-width"];
    for (const sel of wrappers) {
      const t = textClean($(sel).text());
      if (t.length > 160) parts.push(t);
    }
  }

  // Absolute fallback
  if (!parts.length) parts.push(textClean($.root().text()).slice(0, 8000));

  // Longest wins
  parts.sort((a,b) => b.length - a.length);
  return parts[0] || "";
}

/* ================================
   Classifier (exact / near-exact)
   - Keep it minimal and explicit
================================== */
const RX_NOT_CONFIRMED =
  /\b(has|have)\s+not\s+confirmed\b.*\b(accept|register)\b|\bnot\s+confirmed\s+if\b.*\b(accept|register)\b|\bunable\s+to\s+confirm\b.*\b(accept|register)\b/i;

function classify(text) {
  const t = textClean(text).toLowerCase();

  // hard negatives first
  if (RX_NOT_CONFIRMED.test(t)) return "NONE";
  if (/\b(private only|nhs not available|not (currently )?accepting|no longer accepting|cannot accept|not taking on)\b/i.test(t)) {
    return "NONE";
  }
  if (/\b(waiting list|register your interest|expression of interest)\b/i.test(t)) return "NONE";

  // child-only
  if (/\b(children only|only accept(?:ing)? children|under\s*18|aged\s*(1[0-7]|[1-9])\s*or\s*under)\b/i.test(t) &&
      /\b(accept|accepting|taking on|register|registering)\b/i.test(t)) {
    return "CHILD_ONLY";
  }

  // exact / near-exact accepting phrases
  const POS = [
    "this dentist currently accepts new nhs patients",
    "currently accepts new nhs patients",
    "accepts new nhs patients",
    "taking on new nhs patients",
    "now accepting nhs patients",
    "now registering nhs patients",
    "currently registering nhs patients",
    "we are able to register nhs patients",
    "we can accept new nhs patients",
    "limited nhs availability"
  ];

  for (const p of POS) {
    if (t.includes(p)) return "ACCEPTING";
  }

  // minimal generic positive (nhs + accept/register together)
  if (/\bnhs\b/.test(t) && /\b(accept|accepting|taking on|register|registering)\b/.test(t)) {
    return "ACCEPTING";
  }

  return "UNKNOWN";
}

/* ================================
   Email sender (Postmark)
================================== */
async function sendEmail(toList, subject, html) {
  const token = POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN || "";
  if (!toList?.length || !token) return { ok: false };

  const res = await http.post(
    "https://api.postmarkapp.com/email",
    { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
    { headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json", Accept: "application/json" } }
  );
  return res.status >= 200 && res.status < 300
    ? { ok: true, id: res.data?.MessageID }
    : { ok: false, status: res.status, body: res.data };
}

/* ================================
   Build jobs (from Watch/watches)
================================== */
function normPc(pc) {
  return String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
}
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());

async function buildJobs(filterPostcode) {
  const match = filterPostcode ? { postcode: normPc(filterPostcode) } : {};

  let rows = await Watch.aggregate([
    { $match: match },
    { $group: { _id: "$postcode", radius: { $first: "$radius" }, emails: { $addToSet: "$email" } } },
    { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } },
  ]);

  if (!rows || rows.length === 0) {
    try {
      const coll = mongoose.connection.db.collection("watches");
      rows = await coll
        .aggregate([
          { $match: match },
          { $group: { _id: "$postcode", radius: { $first: "$radius" }, emails: { $addToSet: "$email" } } },
          { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } },
        ])
        .toArray();
    } catch {
      // ignore
    }
  }

  return (rows || []).map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).map((e) => String(e).trim().toLowerCase()).filter(validEmail),
  }));
}

/* ================================
   Scan job (simple)
================================== */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const detailUrls = await discoverPractices(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${detailUrls.length}`);
  if (!detailUrls.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [], scanned: 0, emailAttempts: 0 };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");

  const acceptingCards = [];
  const childOnlyCards = [];

  await Promise.all(
    detailUrls.map((detailUrl) =>
      limit(async () => {
        try {
          // per-day dedupe
          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          // Resolve appointments page; else use detail html
          const { apptUrl, fallbackHtml } = await resolveAppointmentsUrl(detailUrl);

          let sourceHtml = "";
          let sourceType = "detail";
          if (apptUrl) {
            const h = await fetchPage(apptUrl);
            if (h && h.length > 200) {
              sourceHtml = h;
              sourceType = "appointments";
            }
          }
          if (!sourceHtml && fallbackHtml) {
            sourceHtml = fallbackHtml;
            sourceType = "detail";
          }
          if (!sourceHtml) return;

          const text = extractScanText(sourceHtml);
          const verdict = classify(text);

          if (verdict === "ACCEPTING" || (verdict === "CHILD_ONLY" && INCLUDE_CHILD)) {
            // Attempt to extract some niceties (phone & heading) from the page we actually scanned
            const $ = cheerio.load(sourceHtml);
            const name =
              $("h1").first().text().trim() ||
              detailUrl.split("/").pop()?.replace(/[-_]+/g, " ").replace(/\d+/g, "").trim() ||
              undefined;
            const telHref = $('a[href^="tel:"]').first().attr("href") || "";
            const phone = telHref ? telHref.replace(/^tel:/i, "") : undefined;

            const card = {
              name,
              phone,
              distanceText: undefined, // results distance is often noisy; we can add later if needed
              mapUrl: undefined, // requires address; keep simple (you asked for minimal logic)
              appointmentUrl: apptUrl || undefined,
              detailUrl,
              checkedAt: new Date(),
            };

            if (verdict === "ACCEPTING") {
              acceptingCards.push(card);
              await EmailLog.create({
                type: "availability",
                practiceUrl: detailUrl,
                dateKey,
                status: "ACCEPTING",
                sentAt: new Date(),
              });
            } else if (verdict === "CHILD_ONLY") {
              childOnlyCards.push(card);
              await EmailLog.create({
                type: "availability",
                practiceUrl: detailUrl,
                dateKey,
                status: "CHILD_ONLY",
                sentAt: new Date(),
              });
            }
          }
        } catch {
          /* ignore single item errors */
        }
      })
    )
  );

  // Email if we have any positives
  let attempts = 0;
  const any =
    acceptingCards.length > 0 || (INCLUDE_CHILD && childOnlyCards.length > 0);

  if (any && recipients?.length) {
    const payload = {
      postcode,
      radius: radiusMiles,
      practices: [...acceptingCards, ...(INCLUDE_CHILD ? childOnlyCards : [])],
      includeChildOnly: INCLUDE_CHILD,
      scannedAt: new Date(),
    };
    const { subject, html } = renderEmail("availability", payload);
    const sendRes = await sendEmail(recipients, subject, html);
    if (sendRes.ok) attempts += 1;
  } else {
    console.log("No accepting/eligible results; skipping email.");
  }

  return {
    accepting: acceptingCards,
    childOnly: childOnlyCards,
    scanned: detailUrls.length,
    emailAttempts: attempts,
  };
}

/* ================================
   Runner
================================== */
export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);

  console.log(`🦷 DentistRadar scanner — simple mode, timeout=${TIMEOUT}ms retries=${RETRIES}`);

  const jobs = await buildJobs(opts.postcode);
  if (!jobs.length) {
    console.log("[RESULT] No Watch entries.");
    return { jobs: 0, summaries: [], emailAttemptsTotal: 0, scannedTotal: 0 };
    }

  const summaries = [];
  let emailAttemptsTotal = 0;
  let scannedTotal = 0;

  for (const job of jobs) {
    console.log(`🔎 Scan ${job.postcode} (${job.radiusMiles} miles) → recipients: ${job.recipients.length}`);
    const res = await scanJob(job);
    summaries.push({
      postcode: job.postcode,
      radiusMiles: job.radiusMiles,
      accepting: res.accepting.length,
      childOnly: res.childOnly.length,
    });
    emailAttemptsTotal += res.emailAttempts || 0;
    scannedTotal += res.scanned || 0;
    await sleep(120);
  }

  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries, emailAttemptsTotal, scannedTotal };
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
