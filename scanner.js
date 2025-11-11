/**
 * DentistRadar — scanner.js (LEGACY+ enriched & resilient)
 * --------------------------------------------------------
 * - Resilient discovery (direct or rendered via ScrapingBee/Browserless)
 * - Extracts practice metadata (name/phone/address/distance) from results HTML (best-effort)
 * - Resolves appointments page and classifies acceptance (with fallback to detail page)
 * - Sends polished email cards (via emailTemplates.js)
 *
 * ENV (set on BOTH web & cron):
 *  MONGO_URI
 *  EMAIL_FROM
 *  POSTMARK_SERVER_TOKEN (or POSTMARK_TOKEN)
 *  POSTMARK_MESSAGE_STREAM=outbound
 *  INCLUDE_CHILD_ONLY=false
 *  MAX_CONCURRENCY=6
 *  DISCOVERY_PROVIDER=direct | scrapingbee | browserless
 *  SCRAPINGBEE_KEY=...
 *  BROWSERLESS_TOKEN=...
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

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
    // Cookie consent to avoid blank shells where possible
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

/* ────────────────────────────────────────────────────────────────
   Providers: direct | scrapingbee | browserless
──────────────────────────────────────────────────────────────── */
async function getDirect(url) {
  const res = await client.get(url);
  if (DEBUG) console.log(`[DIRECT] ${url} → ${res.status} len=${(res.data || "").length}`);
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
      html = await getDirect(url); // graceful fallback
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

/* ────────────────────────────────────────────────────────────────
   Extract practice objects from results page
   (detailUrl + name/phone/address/distance when visible)
──────────────────────────────────────────────────────────────── */
function extractPracticesFromResults(html, baseUrl) {
  const $ = cheerio.load(html);
  const RX = /https:\/\/www\.nhs\.uk\/services\/dentist[s]?\/[A-Za-z0-9\-/%?_.#=]+/g;
  const mapByUrl = new Map();

  const push = (obj) => {
    const key = obj.detailUrl?.split("#")[0];
    if (!key) return;
    const merged = { ...(mapByUrl.get(key) || {}), ...obj, detailUrl: key };
    mapByUrl.set(key, merged);
  };

  // A) Card-like blocks
  const candidates = $(".nhsuk-card, .nhsuk-grid-row, li, article, .nhsuk-results__item");
  candidates.each((_, el) => {
    const scope = $(el);
    let href =
      scope.find('a[href^="/services/dentist"]').attr("href") ||
      scope.find('a[href*="/services/dentist"]').attr("href") ||
      scope.find('a.nhsuk-card__link').attr("href") ||
      "";

    if (!href) return;
    const detailUrl = absolutize(baseUrl, href);

    const name =
      clean(scope.find("h2, h3, .nhsuk-card__heading, .nhsuk-heading-m").first().text()) || undefined;

    const telHref =
      scope.find('a[href^="tel:"]').first().attr("href") ||
      scope.find('a:contains("Tel"), a:contains("Phone"), a:contains("Call")').attr("href") ||
      "";
    const phone = telHref ? clean(telHref.replace(/^tel:/i, "")) : undefined;

    let address =
      clean(
        scope
          .find(".nhsuk-u-font-size-16, .nhsuk-body-s, address, .nhsuk-list li")
          .map((i, n) => $(n).text())
          .get()
          .join(" ")
      ) || undefined;

    let distanceText =
      clean(
        scope
          .find(':contains("mile")')
          .filter((i, n) => /mile/i.test($(n).text()))
          .first()
          .text()
      ) || undefined;

    if (address && address.length > 200) address = undefined;

    push({ detailUrl, name, phone, address, distanceText });
  });

  // B) Hydration / inline JSON
  $("script").each((_, s) => {
    if (s.attribs?.src) return;
    const txt = $(s).text() || "";
    const m = txt.match(RX);
    if (m) m.forEach((u) => push({ detailUrl: u }));
  });

  // C) Raw HTML sweep
  const body = typeof html === "string" ? html : $.root().html() || "";
  const hits = body.match(RX);
  if (hits) hits.forEach((u) => push({ detailUrl: u }));

  return Array.from(mapByUrl.values());
}

/* ────────────────────────────────────────────────────────────────
   Discovery with pagination via rel="next"
──────────────────────────────────────────────────────────────── */
async function discoverPractices(postcode, radius) {
  const start = resultsUrlVariants(postcode, radius);
  const queue = [...start];
  const seenUrl = new Set();
  const mapByDetail = new Map();

  // Crawl up to 10 pages total across variants (polite)
  while (queue.length && seenUrl.size < 12) {
    const url = queue.shift();
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);

    const html = await fetchPage(url);
    if (!html) continue;

    const items = extractPracticesFromResults(html, url);
    for (const p of items) {
      const key = p.detailUrl;
      const merged = { ...(mapByDetail.get(key) || {}), ...p };
      mapByDetail.set(key, merged);
    }

    const $ = cheerio.load(html);
    const nextHref = relNext($);
    if (nextHref) {
      const abs = absolutize(url, nextHref);
      if (abs && !seenUrl.has(abs) && queue.length < 12) queue.push(abs);
    }

    await sleep(120);
  }

  return Array.from(mapByDetail.values());
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

/* ────────────────────────────────────────────────────────────────
   Classifier (expanded phrases; tolerant to wording changes)
──────────────────────────────────────────────────────────────── */
function classifyAcceptance(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g," ").replace(/’/g,"'");

  // Hard negatives
  const neg = [
    "not accepting", "no longer accepting", "not currently accepting",
    "unable to accept", "cannot accept", "we are not accepting",
    "no nhs spaces", "not taking new nhs", "not taking on nhs",
    "we do not accept nhs", "we don't accept nhs"
  ];
  if (neg.some(p => t.includes(p))) return "NONE";

  // Child-only
  const isChild =
    t.includes("children only") || t.includes("only accepts children") || t.includes("only accepting children") ||
    /under\s*18/.test(t) || /aged\s*(1[0-7]|[1-9])\s*or\s*under/.test(t);

  // Strong positives + generic accept pattern
  const pos = [
    "this dentist currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "accepting new nhs patients",
    "taking on new nhs patients",
    "now accepting nhs patients",
    "registering new nhs patients",
    "we are accepting nhs patients",
    "we're accepting nhs patients",
    "accepting nhs patients"
  ];
  const genericAccept = (t.includes("accept") || t.includes("taking on") || t.includes("registering")) && t.includes("nhs");

  if (pos.some(p => t.includes(p)) || (genericAccept && !t.includes("only"))) return "ACCEPTING";
  if (isChild) return "CHILD_ONLY";

  // Soft negatives
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

  const practices = await discoverPractices(postcode, radiusMiles);
  console.log(`[DISCOVERY] collected = ${practices.length} (with metadata where available)`);
  if (!practices.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");

  const acceptingDetails = [];
  const childOnlyDetails = [];

  // debug counters
  let cApptResolved = 0, cApptFallback = 0, cUnknown = 0;

  await Promise.all(
    practices.map((p) =>
      limit(async () => {
        try {
          const detailUrl = p.detailUrl;
          if (!detailUrl) return;

          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          // 1) Try appointments page
          let sourceHtml = null;
          const apptUrl = await resolveAppointmentsUrl(detailUrl);
          if (apptUrl) {
            sourceHtml = await fetchPage(apptUrl);
            cApptResolved++;
          } else {
            cApptFallback++;
          }

          // 2) Fallback: detail page if appointments thin/missing
          if (!sourceHtml || sourceHtml.length < 400) {
            const detailHtml = await fetchPage(detailUrl);
            if (detailHtml && detailHtml.length > 400) sourceHtml = detailHtml;
          }
          if (!sourceHtml) return;

          // 3) Classify
          const text = extractAppointmentsText(sourceHtml);
          const verdict = classifyAcceptance(text);
          if (verdict === "UNKNOWN") {
            cUnknown++;
            if (Math.random() < 0.05) console.log("[DEBUG:UNKNOWN]", detailUrl, (text || "").slice(0, 180));
          }

          // 4) Build card — enrichment is optional and safe
          const card = {
            name: p.name || undefined,
            address: p.address || undefined,
            phone: p.phone || undefined,
            distanceText: p.distanceText || undefined,
            mapUrl: p.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.address)}` : undefined,
            appointmentUrl: apptUrl || undefined,
            detailUrl,
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
          /* ignore single practice failures */
        }
      })
    )
  );

  console.log(`  • Resolved appt pages: ${cApptResolved}, Fallback-to-detail: ${cApptFallback}, Unknown verdicts: ${cUnknown}`);

  const shouldSend = acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);
  if (!shouldSend) {
    console.log("No accepting/eligible results; skipping email.");
    return { accepting: [], childOnly: [] };
  }
  if (!recipients?.length) {
    console.log("Recipients empty; not emailing.");
    return { accepting: acceptingDetails, childOnly: childOnlyDetails };
  }

  const all = [...acceptingDetails, ...(INCLUDE_CHILD ? childOnlyDetails : [])];
  const { subject, html } = renderEmail("availability", {
    postcode,
    radius: radiusMiles,
    practices: all,
    includeChildOnly: INCLUDE_CHILD,
    scannedAt: new Date(),
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
