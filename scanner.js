/**
 * DentistRadar — scanner.js (v11.0)
 * What changed in this version:
 *  • Discovery: resilient results URL variants + pagination
 *  • Parsing: appointments page first, fallback to detail page
 *  • Classifier: excludes “has not confirmed”, waitlists, private-only; detects clear positives
 *  • Email: consolidates accepting matches (cards with name, address, phone, distance, map + appointments link)
 *  • Logging: clear counters; per-day EmailLog to avoid duplicates
 *
 * Everything else (server endpoints, cron, models) remains unchanged.
 */

import axios from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import dayjs from "dayjs";
import mongoose from "mongoose";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ────────────────────────────────────────────────────────────────
   ENV
   ──────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",

  MAX_CONCURRENCY = "6",
  DISCOVERY_PAGES = "10",
  DISCOVERY_REQUEST_TIMEOUT_MS = "60000",
  DISCOVERY_RETRY = "3",
  INCLUDE_CHILD_ONLY = "false",

  // Optional debug toggles
  DEBUG_DISCOVERY = "false",
  DEBUG_CLASSIFIER = "false",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const PAGE_LIMIT = Math.max(1, Number(DISCOVERY_PAGES) || 10);
const REQUEST_TIMEOUT = Math.max(15000, Number(DISCOVERY_REQUEST_TIMEOUT_MS) || 60000);
const RETRIES = Math.max(0, Number(DISCOVERY_RETRY) || 3);

const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";
const DEBUGC = String(DEBUG_CLASSIFIER).toLowerCase() === "true";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

/* ────────────────────────────────────────────────────────────────
   HTTP client with retries
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
async function fetchPage(url) {
  try {
    const res = await client.get(url);
    if (DEBUG) console.log(`[GET] ${url} → ${res.status} len=${(res.data || "").length}`);
    if (res.status >= 200 && res.status < 400 && typeof res.data === "string") return res.data;
    return "";
  } catch (e) {
    if (DEBUG) console.log(`[GET ERR] ${url} → ${e?.message}`);
    return "";
  }
}

function absolutize(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

/* ────────────────────────────────────────────────────────────────
   Discovery: results URL variants + pagination
   ──────────────────────────────────────────────────────────────── */
function resultsUrlVariants(postcode, radius) {
  const pc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  // The NHS site uses multiple shapes; try both common variants
  return [
    `${base}/service-search/find-a-dentist/results/${pc}&distance=${radius}`,
    `${base}/service-search/find-a-dentist/results?postcode=${pc}&distance=${radius}`,
  ];
}
function nextLink($) {
  const link =
    $('a[rel="next"]').attr("href") ||
    $('link[rel="next"]').attr("href") ||
    $('a:contains("Next")').attr("href") ||
    $('a.nhsuk-pagination__link[aria-label*="Next"]').attr("href");
  return link ? String(link) : "";
}
function sanitizeAddress(raw) {
  if (!raw) return raw;
  const parts = raw.split(/[\n\r]+| {2,}/).map((s) => s.trim()).filter(Boolean);
  const filtered = parts.filter(
    (line) => !/mile/i.test(line) && !/^this organisation is/i.test(line)
  );
  const addr = filtered.join(", ").replace(/,\s*,/g, ", ").replace(/\s+,/g, ",").trim();
  return addr || undefined;
}
function nameFromUrl(detailUrl) {
  try {
    const u = new URL(detailUrl);
    const segs = u.pathname.split("/").filter(Boolean);
    const slug = segs[segs.length - 1] || "";
    const cleaned = slug.replace(/\d+/g, "").replace(/[-_]+/g, " ").trim();
    if (!cleaned) return undefined;
    return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return undefined;
  }
}
function extractPracticesFromResults(html, baseUrl) {
  const $ = cheerio.load(html);
  const RX = /https:\/\/www\.nhs\.uk\/services\/dentist[s]?\/[A-Za-z0-9\-/%?_.#=]+/g;
  const byUrl = new Map();

  const push = (obj) => {
    const key = obj.detailUrl?.split("#")[0];
    if (!key) return;
    const merged = { ...(byUrl.get(key) || {}), ...obj, detailUrl: key };
    byUrl.set(key, merged);
  };

  // Cards and list items
  const cards = $(".nhsuk-card, .nhsuk-grid-row, li, article, .nhsuk-results__item, .nhsuk-panel");
  cards.each((_, el) => {
    const scope = $(el);
    const href =
      scope.find('a[href^="/services/dentist"]').attr("href") ||
      scope.find('a[href*="/services/dentist"]').attr("href") ||
      scope.find("a.nhsuk-card__link").attr("href") ||
      "";
    if (!href) return;
    const detailUrl = absolutize(baseUrl, href);

    const nameRaw =
      clean(scope.find("h2, h3, .nhsuk-card__heading, .nhsuk-heading-m").first().text()) ||
      undefined;

    const telHref =
      scope.find('a[href^="tel:"]').first().attr("href") ||
      scope.find('a:contains("Tel"), a:contains("Phone"), a:contains("Call")').attr("href") ||
      "";
    const phone = telHref ? clean(telHref.replace(/^tel:/i, "")) : undefined;

    let addressRaw = clean(
      scope
        .find(".nhsuk-u-font-size-16, .nhsuk-body-s, address, .nhsuk-list li")
        .map((i, n) => $(n).text())
        .get()
        .join(" ")
    );
    if (!addressRaw) addressRaw = undefined;
    const address = sanitizeAddress(addressRaw);

    let distanceText = clean(
      scope.find(':contains("mile")').filter((i, n) => /mile/i.test($(n).text())).first().text()
    );
    if (!distanceText) distanceText = undefined;

    push({ detailUrl, name: nameRaw, phone, address, distanceText });
  });

  // Hydration JSON
  $("script").each((_, s) => {
    if (s.attribs?.src) return;
    const txt = $(s).text() || "";
    const m = txt.match(RX);
    if (m) m.forEach((u) => push({ detailUrl: u }));
  });

  // Raw fallback
  const whole = typeof html === "string" ? html : $.root().html() || "";
  const hits = whole.match(RX);
  if (hits) hits.forEach((u) => push({ detailUrl: u }));

  return Array.from(byUrl.values());
}

async function discoverPractices(postcode, radius) {
  const seeds = resultsUrlVariants(postcode, radius);
  const queue = [...seeds];
  const seen = new Set();
  const byDetail = new Map();

  while (queue.length && seen.size < PAGE_LIMIT) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const html = await fetchPage(url);
    if (!html) continue;

    const items = extractPracticesFromResults(html, url);
    for (const p of items) {
      const key = p.detailUrl;
      const merged = { ...(byDetail.get(key) || {}), ...p };
      byDetail.set(key, merged);
    }

    const $ = cheerio.load(html);
    const next = nextLink($);
    if (next) {
      const abs = absolutize(url, next);
      if (abs && !seen.has(abs) && queue.length < PAGE_LIMIT) queue.push(abs);
    }
    await sleep(120);
  }

  return Array.from(byDetail.values());
}

/* ────────────────────────────────────────────────────────────────
   Appointments resolution + text extraction
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
    if (html && html.length > 300) return u;
  }
  return "";
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  $("h1,h2,h3").each((_, h) => {
    const heading = String($(h).text() || "").toLowerCase();
    if (/appointment|opening\s+times|patients|registration/.test(heading)) {
      const buf = [];
      let cur = $(h).next(),
        hops = 0;
      while (cur.length && hops < 40) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p", "div", "li", "ul", "ol", "section"].includes(tag)) {
          buf.push(String(cur.text() || "").replace(/\s+/g, " ").trim());
        }
        cur = cur.next();
        hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined.length > 60) buckets.push(joined);
    }
  });

  if (!buckets.length) {
    const wrappers = ["main", "#maincontent", ".nhsuk-main-wrapper", ".nhsuk-width-container", ".nhsuk-u-reading-width"];
    for (const sel of wrappers) {
      const t = String($(sel).text() || "").replace(/\s+/g, " ").trim();
      if (t.length > 200) buckets.push(t);
    }
  }

  if (!buckets.length) {
    const whole = String($.root().text() || "").replace(/\s+/g, " ").trim();
    return whole.slice(0, 8000);
  }

  buckets.sort((a, b) => b.length - a.length);
  return buckets[0];
}

/* ────────────────────────────────────────────────────────────────
   Classifier (strict + precise)
   ──────────────────────────────────────────────────────────────── */
function classifyAcceptance(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");

  // Block false-positives
  if (
    /\b(has|have)\s+not\s+confirmed\b.*\b(accept|register)\b|\bunable\s+to\s+confirm\b.*\b(accept|register)\b|\bnot\s+confirmed\s+if\b.*\b(accept|register)\b|\bno\s+information\b.*\b(accept|register)\b|\bunknown\b.*\b(accept|register)\b/.test(
      t
    )
  ) {
    if (DEBUGC) console.log("CLASSIFY → NONE (not confirmed)");
    return "NONE";
  }

  // Negatives
  if (
    /(not (currently )?accept(?:ing)?|no longer accepting|cannot accept|we are not accepting|nhs not available|nhs list closed|private only|emergency only|urgent care only|walk-?in only|not taking (on )?nhs|no nhs spaces|nhs capacity full|nhs closed)/i.test(
      t
    )
  ) {
    if (DEBUGC) console.log("CLASSIFY → NONE (negative phrase)");
    return "NONE";
  }

  // Children only
  const child = /(children only|only accept(?:ing)? children|under\s*18|aged\s*(1[0-7]|[1-9])\s*or\s*under)/i;
  const hasChild = child.test(t) && /\b(accept|accepting|taking on|register|registering)\b/.test(t);

  // Strong positives
  const strong =
    /(this dentist currently accepts new nhs patients|we (are|’re|are now)\s+accept(?:ing)?\s+new\s+nhs\s+patients|currently accept\w*\s+new\s+nhs\s+patients|taking\s+on\s+new\s+nhs\s+patients|now\s+accept\w*\s+nhs\s+patients|able\s+to\s+register\s+nhs\s+patients|we\s+can\s+accept\s+new\s+nhs\s+patients)/i;

  // General positive “NH S + accept*” in same block
  const generic = /(?=.*\bnhs\b)(?=.*\b(accept|accepting|taking on|registering|register)\b)/i;

  let score = 0;
  if (strong.test(t)) score += 3;
  if (generic.test(t)) score += 2;

  // Waitlist/EOI is not acceptance
  if (/\b(waiting list|join (the )?waiting list|register your interest|expression of interest|eoi)\b/i.test(t)) {
    score -= 3;
  }

  if (hasChild) return "CHILD_ONLY";
  if (score >= 3) return "ACCEPTING";
  if (score <= -2) return "NONE";
  return "UNKNOWN";
}

function extractSnippet(text, max = 420) {
  const t = String(text || "");
  const rx = /(accept|accepting|taking on|register|nhs|waiting list|expression of interest)/i;
  const m = t.match(rx);
  if (!m) return t.slice(0, max).trim();
  const i = Math.max(0, t.toLowerCase().indexOf(m[0].toLowerCase()));
  const start = Math.max(0, i - Math.floor(max / 2));
  return t.slice(start, start + max).trim();
}

/* ────────────────────────────────────────────────────────────────
   Email (Postmark)
   ──────────────────────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  const token = POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN || "";
  if (!toList?.length || !token) return { ok: false };

  const res = await client.post(
    "https://api.postmarkapp.com/email",
    { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
    { headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json", Accept: "application/json" } }
  );
  return res.status >= 200 && res.status < 300
    ? { ok: true, id: res.data?.MessageID }
    : { ok: false, status: res.status, body: res.data };
}

/* ────────────────────────────────────────────────────────────────
   Jobs
   ──────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────
   Scan job
   ──────────────────────────────────────────────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const practices = await discoverPractices(postcode, radiusMiles);
  console.log(`[DISCOVERY] collected = ${practices.length} (with metadata where available)`);
  if (!practices.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [], emailAttempts: 0, scanned: 0 };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");

  const accepting = [];
  const childOnly = [];

  let resolvedAppt = 0,
    fallbackDetail = 0,
    unknownCount = 0;

  await Promise.all(
    practices.map((p) =>
      limit(async () => {
        try {
          const detailUrl = p.detailUrl;
          if (!detailUrl) return;

          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          const apptUrl = await resolveAppointmentsUrl(detailUrl);
          let sourceHtml = "";
          if (apptUrl) {
            sourceHtml = await fetchPage(apptUrl);
            resolvedAppt++;
          }
          if (!sourceHtml || sourceHtml.length < 400) {
            const d = await fetchPage(detailUrl);
            if (d && d.length > 400) {
              sourceHtml = d;
              fallbackDetail++;
            }
          }
          if (!sourceHtml) return;

          const text = extractAppointmentsText(sourceHtml);
          const verdict = classifyAcceptance(text);
          if (verdict === "UNKNOWN") unknownCount++;

          // Build card
          const card = {
            name:
              p.name ||
              (fallbackDetail ? (cheerio.load(sourceHtml)("h1").first().text().trim() || undefined) : undefined) ||
              nameFromUrl(detailUrl),
            address: p.address || undefined,
            phone: p.phone || undefined,
            distanceText: p.distanceText || undefined,
            mapUrl: p.address
              ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
                  postcode
                )}&destination=${encodeURIComponent(p.address)}`
              : undefined,
            appointmentUrl: apptUrl || undefined,
            detailUrl,
            checkedAt: new Date(),
          };

          if (verdict === "ACCEPTING") {
            accepting.push(card);
            await EmailLog.create({
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "ACCEPTING",
              sentAt: new Date(),
            });
          } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnly.push(card);
            await EmailLog.create({
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "CHILD_ONLY",
              sentAt: new Date(),
            });
          }
        } catch (e) {
          if (DEBUG) console.log("[ITEM ERR]", e?.message);
        }
      })
    )
  );

  console.log(
    `  • Resolved appt pages: ${resolvedAppt}, Fallback-to-detail: ${fallbackDetail}, Unknown verdicts: ${unknownCount}`
  );

  const anySend = accepting.length > 0 || (INCLUDE_CHILD && childOnly.length > 0);
  let emailAttempts = 0;

  if (!anySend) {
    console.log("No accepting/eligible results; skipping email.");
    return { accepting: [], childOnly: [], emailAttempts, scanned: practices.length };
  }

  if (!recipients?.length) {
    console.log(`Found ${accepting.length + childOnly.length} results but no recipients; not emailing.`);
    return { accepting, childOnly, emailAttempts, scanned: practices.length };
  }

  // Render professional acceptance email
  const all = [...accepting, ...(INCLUDE_CHILD ? childOnly : [])];
  const { subject, html } = renderEmail("availability", {
    postcode,
    radius: radiusMiles,
    practices: all,
    scannedAt: new Date(),
  });

  const sendRes = await sendEmail(recipients, subject, html);
  if (sendRes.ok) emailAttempts += 1;

  return { accepting, childOnly, emailAttempts, scanned: practices.length };
}

/* ────────────────────────────────────────────────────────────────
   Runner
   ──────────────────────────────────────────────────────────────── */
export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);

  console.log(`🦷 DentistRadar scanner — direct HTML, timeout=${REQUEST_TIMEOUT}ms retries=${RETRIES}`);

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
