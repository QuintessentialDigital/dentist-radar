/**
 * DentistRadar — scanner.js (v10.4)
 * - HTML results discovery (two URL shapes) + rel="next"
 * - Appointments-first parsing; detail-page fallback
 * - Updated classifier (covers banners + “list is open” + “able to register”)
 * - Diagnostics email (optional) if accepting=0
 * - Sends professional email via emailTemplates.js
 */

import axios from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import dayjs from "dayjs";
import mongoose from "mongoose";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ─────────────── ENV ─────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",

  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",

  DISCOVERY_REQUEST_TIMEOUT_MS = "60000",
  DISCOVERY_RETRY = "3",

  DEBUG_DISCOVERY = "false",
  DEBUG_RUN_REPORT = "false",
  DEBUG_ADMIN_EMAIL = "",

  ACCEPT_MODE = "strict",      // "strict" | "lenient"
  EMAILLOG_BYPASS = "0",       // "1" bypass per-day dedupe
  DIAG_DUMP_ON_ZERO = "1",     // needs DEBUG_ADMIN_EMAIL
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const CONCURRENCY   = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const REQUEST_TIMEOUT = Math.max(10000, Number(DISCOVERY_REQUEST_TIMEOUT_MS) || 60000);
const RETRIES         = Math.max(0, Number(DISCOVERY_RETRY) || 3);

const DEBUG      = String(DEBUG_DISCOVERY).toLowerCase() === "true";
const RUN_REPORT = String(DEBUG_RUN_REPORT).toLowerCase() === "true";
const BYPASS_LOG = String(EMAILLOG_BYPASS).toLowerCase() === "1";
const ADMIN_EMAIL = (DEBUG_ADMIN_EMAIL || "").trim();
const WANT_DIAG   = String(DIAG_DUMP_ON_ZERO).toLowerCase() === "1" && !!ADMIN_EMAIL;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

/* ───────────── HTTP w/ Retry ───────────── */
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

/* ───────────── Discovery ───────────── */
function resultsUrlVariants(postcode, radius) {
  const pc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  return [
    `${base}/service-search/find-a-dentist/results/${pc}&distance=${radius}`,
    `${base}/service-search/find-a-dentist/results?postcode=${pc}&distance=${radius}`,
  ];
}
function absolutize(baseUrl, href) { try { return new URL(href, baseUrl).toString(); } catch { return ""; } }
function relNext($) {
  const link =
    $('a[rel="next"]').attr("href") ||
    $('link[rel="next"]').attr("href") ||
    $('a:contains("Next")').attr("href") ||
    $('a.nhsuk-pagination__link[aria-label*="Next"]').attr("href");
  return link ? String(link) : "";
}
function sanitizeAddress(raw) {
  if (!raw) return raw;
  const parts = raw.split(/[\n\r]+| {2,}/).map(s=>s.trim()).filter(Boolean);
  const filtered = parts.filter((line)=> !/mile/i.test(line) && !/^this organisation is/i.test(line));
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
  } catch { return undefined; }
}

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

  const cards = $(".nhsuk-card, .nhsuk-grid-row, li, article, .nhsuk-results__item");
  cards.each((_, el) => {
    const scope = $(el);
    const href =
      scope.find('a[href^="/services/dentist"]').attr("href") ||
      scope.find('a[href*="/services/dentist"]').attr("href") ||
      scope.find("a.nhsuk-card__link").attr("href") || "";
    if (!href) return;
    const detailUrl = absolutize(baseUrl, href);

    const nameRaw = clean(scope.find("h2, h3, .nhsuk-card__heading, .nhsuk-heading-m").first().text()) || undefined;

    const telHref =
      scope.find('a[href^="tel:"]').first().attr("href") ||
      scope.find('a:contains("Tel"), a:contains("Phone"), a:contains("Call")').attr("href") || "";
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
      scope.find(':contains("mile")').filter((i,n)=>/mile/i.test($(n).text())).first().text()
    );
    if (!distanceText) distanceText = undefined;

    push({ detailUrl, name: nameRaw, phone, address, distanceText });
  });

  $("script").each((_, s) => {
    if (s.attribs?.src) return;
    const txt = $(s).text() || "";
    const m = txt.match(RX);
    if (m) m.forEach((u) => push({ detailUrl: u }));
  });

  const body = typeof html === "string" ? html : $.root().html() || "";
  const hits = body.match(RX);
  if (hits) hits.forEach((u) => push({ detailUrl: u }));

  return Array.from(mapByUrl.values());
}

async function discoverPractices(postcode, radius) {
  const start = resultsUrlVariants(postcode, radius);
  const queue = [...start];
  const seenUrl = new Set();
  const mapByDetail = new Map();

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

/* ───────────── Appointments resolution + text ───────────── */
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
      if (!href && (t.includes("appointment") || t.includes("opening") || t.includes("who we can accept"))) href = h;
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
  candidates.add(absolutize(detailUrl, "./who-we-can-accept"));

  for (const u of candidates) {
    if (!u) continue;
    const html = await fetchPage(u);
    if (html && html.length > 200) return u;
  }
  return "";
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);

  const priority = [
    ".nhsuk-notification-banner",
    ".nhsuk-inset-text",
    ".nhsuk-panel",
    ".nhsuk-warning-callout",
    ".nhsuk-u-reading-width",
  ];
  for (const sel of priority) {
    const t = clean($(sel).text());
    if (t && t.length > 80) return t;
  }

  const buckets = [];
  $("h1,h2,h3").each((_, h) => {
    const heading = String($(h).text() || "").toLowerCase();
    if (/appointment|opening\s+times|patients|registration|who we can accept|new patients/i.test(heading)) {
      const buf = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 60) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol","section"].includes(tag)) {
          buf.push(String(cur.text() || "").replace(/\s+/g, " ").trim());
        }
        cur = cur.next(); hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined.length > 60) buckets.push(joined);
    }
  });

  if (!buckets.length) {
    const wrappers = ["main","#maincontent",".nhsuk-main-wrapper",".nhsuk-width-container",".nhsuk-u-reading-width"];
    for (const sel of wrappers) {
      const t = String($(sel).text() || "").replace(/\s+/g," ").trim();
      if (t.length > 200) buckets.push(t);
    }
  }

  if (!buckets.length) {
    const whole = String($.root().text() || "").replace(/\s+/g, " ").trim();
    return whole.slice(0, 8000);
  }

  buckets.sort((a,b)=> b.length - a.length);
  return buckets[0];
}

/* ───────────── Classifier ───────────── */
const RX_NOT_CONFIRMED = /\b(has|have)\s+not\s+confirmed\b.*\b(accept|register)/i;
const RX_NEGATIVE =
  /\b(private only|nhs not available|not (currently )?accept(?:ing)?|no longer accepting|cannot accept|not taking on|nhs list closed|nhs capacity full|emergency only|urgent care only)\b/i;
const RX_WAITLIST = /\b(waiting list|register your interest|expression of interest)\b/i;

const POS_STRICT = [
  "this dentist currently accepts new nhs patients for routine dental care",
  "this dentist currently accepts new nhs patients",
  "this practice is currently accepting new nhs patients",
  "currently accepts new nhs patients",
  "accepts new nhs patients",
  "accepting new nhs patients",
  "is accepting new nhs patients",
  "we are accepting new nhs patients",
  "now accepting nhs patients",
  "taking on new nhs patients",
  "now registering nhs patients",
  "currently registering nhs patients",
  "we are able to register nhs patients",
  "we can accept new nhs patients",
  "our nhs list is open",
  "nhs list is open",
  "limited nhs availability",
  "accepting new nhs adult patients",
  "we have nhs spaces",
  "spaces available for nhs patients",
];

function classifyAcceptance(text) {
  const mode = (ACCEPT_MODE || "strict").toLowerCase();
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");

  if (RX_NOT_CONFIRMED.test(t)) return "NONE";
  if (RX_NEGATIVE.test(t)) return "NONE";
  if (RX_WAITLIST.test(t)) return "NONE";

  const child = /\b(children only|only accept(?:ing)? children|under\s*18|aged\s*(1[0-7]|[1-9])\s*or\s*under)\b/i.test(t)
             && /\b(accept|accepting|taking on|register|registering)\b/i.test(t);
  if (child) return "CHILD_ONLY";

  if (POS_STRICT.some(p => t.includes(p))) return "ACCEPTING";

  if (mode === "lenient") {
    if (/\bnhs\b/.test(t) && /\b(accept|accepting|taking on|register|registering)\b/.test(t)) {
      if (!RX_NOT_CONFIRMED.test(t) && !RX_NEGATIVE.test(t) && !RX_WAITLIST.test(t)) {
        return "ACCEPTING";
      }
    }
  }
  return "UNKNOWN";
}
function inferReason(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return "APPT_THIN";
  if (RX_WAITLIST.test(t)) return "WAITLIST";
  if (RX_NEGATIVE.test(t)) return "NEGATED";
  if (/\b(children only|only accept(?:ing)? children|under\s*18|aged\s*(1[0-7]|[1-9])\s*or\s*under)\b/i.test(t)) return "CHILD_ONLY";
  if (!/(nhs|accept|accepting|taking on|register|registering|patients)/i.test(t)) return "NO_KEYWORDS";
  if (RX_NOT_CONFIRMED.test(t)) return "NOT_CONFIRMED";
  return "UNKNOWN";
}
function extractSnippet(text, max = 420) {
  const t = String(text || "");
  const rx = /(accept|accepting|taking on|register|nhs|waiting list|expression of interest|not confirmed|list is open)/i;
  const m = t.match(rx);
  if (!m) return t.slice(0, max).trim();
  const i = Math.max(0, t.toLowerCase().indexOf(m[0].toLowerCase()));
  const start = Math.max(0, i - Math.floor(max / 2));
  return t.slice(start, start + max).trim();
}

/* ───────────── Email (Postmark) ───────────── */
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

/* ───────────── Build jobs ───────────── */
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
    } catch (e) {
      console.log("[WARN] Fallback aggregate on 'watches' failed:", e?.message);
    }
  }

  return (rows || []).map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).map((e) => String(e).trim().toLowerCase()).filter(validEmail),
  }));
}

/* ───────────── Optional admin run report ───────────── */
async function sendRunReport({ postcode, radius, discovered, apptResolved, apptFallback, unknown, recipientsCount }) {
  if (!RUN_REPORT || !ADMIN_EMAIL) return;
  const subject = `Scan report — ${postcode} (${radius} mi)`;
  const html = `
    <div style="font:14px system-ui;color:#111">
      <h3 style="margin:0 0 8px">DentistRadar — Run report</h3>
      <div>Postcode: <b>${postcode}</b> • Radius: <b>${radius} miles</b></div>
      <ul>
        <li>Discovered practices: <b>${discovered}</b></li>
        <li>Appointments resolved: <b>${apptResolved}</b></li>
        <li>Fallback to detail: <b>${apptFallback}</b></li>
        <li>Unknown verdicts: <b>${unknown}</b></li>
        <li>Recipients in group: <b>${recipientsCount}</b></li>
      </ul>
    </div>`;
  await sendEmail([ADMIN_EMAIL], subject, html);
}

/* ───────────── Scan group ───────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const practices = await discoverPractices(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${practices.length}`);
  if (!practices.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [], emailAttempts: 0, scanned: 0 };
  }

  const limit   = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");

  const acceptingDetails = [];
  const childOnlyDetails = [];
  const diagSnippets = [];

  let cApptResolved = 0, cApptFallback = 0, cUnknown = 0;

  await Promise.all(
    practices.map((p) =>
      limit(async () => {
        try {
          const detailUrl = p.detailUrl;
          if (!detailUrl) return;

          if (!BYPASS_LOG) {
            const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
            if (already) return;
          }

          // Appointments-first
          let sourceHtml = null;
          const apptUrl = await resolveAppointmentsUrl(detailUrl);
          if (apptUrl) {
            sourceHtml = await fetchPage(apptUrl);
            cApptResolved++;
          } else {
            cApptFallback++;
          }

          let usedSource = apptUrl ? "appointments" : "detail";
          if (!sourceHtml || sourceHtml.length < 450) {
            const detailHtml = await fetchPage(detailUrl);
            if (detailHtml && detailHtml.length > 450) {
              sourceHtml = detailHtml;
              usedSource = "detail";
            }
          }
          if (!sourceHtml) {
            await PracticeEvidence.create({
              practiceUrl: detailUrl, dateKey, verdict: "UNKNOWN", reason: "NO_APPT_PAGE",
              source: apptUrl ? "appointments" : "detail", snippet: ""
            });
            return;
          }

          const text    = extractAppointmentsText(sourceHtml);
          const verdict = classifyAcceptance(text);
          if (verdict === "UNKNOWN") cUnknown++;

          const reason  = verdict === "ACCEPTING" ? "MATCH" : inferReason(text);
          const snippet = extractSnippet(text);

          if (WANT_DIAG && diagSnippets.length < 10) {
            diagSnippets.push({ url: detailUrl, usedSource, verdict, reason, snippet: snippet.slice(0, 380) });
          }

          await PracticeEvidence.create({
            practiceUrl: detailUrl, dateKey, verdict, reason, source: usedSource, snippet
          });

          const card = {
            name:
              p.name ||
              (usedSource === "detail" ? (cheerio.load(sourceHtml)("h1").first().text().trim() || undefined) : undefined) ||
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
            acceptingDetails.push(card);
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "ACCEPTING", sentAt: new Date() });
          } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnlyDetails.push(card);
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "CHILD_ONLY", sentAt: new Date() });
          }
        } catch (e) {
          if (DEBUG) console.log("[SCAN ITEM ERR]", e?.message);
        }
      })
    )
  );

  console.log(`  • Resolved appt pages: ${cApptResolved}, Fallback-to-detail: ${cApptFallback}, Unknown verdicts: ${cUnknown}`);

  const hasAccepting = acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);
  let emailAttempts = 0;

  if (!hasAccepting) {
    console.log("No accepting/eligible results; skipping email.");
    await sendRunReport({
      postcode, radius: radiusMiles, discovered: practices.length,
      apptResolved: cApptResolved, apptFallback: cApptFallback, unknown: cUnknown,
      recipientsCount: recipients?.length || 0,
    });

    if (WANT_DIAG && diagSnippets.length) {
      const subject = `DIAG — ${postcode} (${radiusMiles} mi) — 0 accepting`;
      const list = diagSnippets.map(
        (d, i) => `<li><b>${i + 1}.</b> <a href="${d.url}">${d.url}</a> <em>src=${d.usedSource} verdict=${d.verdict} reason=${d.reason}</em><br><code style="white-space:pre-wrap">${d.snippet}</code></li>`
      ).join("");
      const html = `<div style="font-family:system-ui"><h3>Diagnostics — no accepting</h3><ul>${list}</ul></div>`;
      await sendEmail([ADMIN_EMAIL], subject, html);
    }

    return { accepting: [], childOnly: [], emailAttempts, scanned: practices.length };
  }

  if (!recipients?.length) {
    console.log(`Found ${acceptingDetails.length + childOnlyDetails.length} results but no recipients; not emailing.`);
    return { accepting: acceptingDetails, childOnly: childOnlyDetails, emailAttempts, scanned: practices.length };
  }

  const all = [...acceptingDetails, ...(INCLUDE_CHILD ? childOnlyDetails : [])];
  const { subject, html } = renderEmail("availability", {
    postcode, radius: radiusMiles, practices: all, includeChildOnly: INCLUDE_CHILD, scannedAt: new Date(),
  });

  const sendRes = await sendEmail(recipients, subject, html);
  if (sendRes.ok) emailAttempts += 1;

  return { accepting: acceptingDetails, childOnly: childOnlyDetails, emailAttempts, scanned: practices.length };
}

/* ───────────── Runner ───────────── */
export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);

  console.log(`🦷 DentistRadar scanner — ${ACCEPT_MODE} mode, timeout=${REQUEST_TIMEOUT}ms retries=${RETRIES}`);

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
      postcode: job.postcode, radiusMiles: job.radiusMiles,
      accepting: res.accepting.length, childOnly: res.childOnly.length,
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
  runScan().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
