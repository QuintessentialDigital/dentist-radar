/**
 * DentistRadar — scanner.js (v10.6)
 * - Discovery via NHS HTML results; resolves appointments page
 * - Strict negatives, tunable positives (ACCEPT_MODE=strict|lenient)
 * - Captures name/phone/address/distance; computes distanceMiles when possible
 * - Safe email rendering and summary header data
 */

import axios from "axios";
import axiosRetry from "axios-retry";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ENV */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  DEBUG_DISCOVERY = "false",
  DISCOVERY_REQUEST_TIMEOUT_MS = "60000",
  DISCOVERY_RETRY = "3",
  DEBUG_RUN_REPORT = "false",
  DEBUG_ADMIN_EMAIL = "",
  ACCEPT_MODE = "strict",          // strict | lenient
  EMAILLOG_BYPASS = "0"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const REQUEST_TIMEOUT = Math.max(10000, Number(DISCOVERY_REQUEST_TIMEOUT_MS) || 60000);
const RETRIES = Math.max(0, Number(DISCOVERY_RETRY) || 3);
const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";
const RUN_REPORT = String(DEBUG_RUN_REPORT).toLowerCase() === "true";
const ADMIN_EMAIL = (DEBUG_ADMIN_EMAIL || "").trim();
const BYPASS_LOG = String(EMAILLOG_BYPASS) === "1";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

/* HTTP client with retry */
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

/* Discovery */
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
function sanitizeAddress(raw) {
  if (!raw) return raw;
  const parts = raw.split(/[\n\r]+| {2,}/).map(s=>s.trim()).filter(Boolean);
  const filtered = parts.filter((line)=> !/mile/i.test(line) && !/^this organisation is/i.test(line));
  const addr = filtered.join(", ").replace(/,\s*,/g, ", ").replace(/\s+,/g, ",").trim();
  return addr || undefined;
}
function parseDistanceMiles(text = "") {
  const m = String(text).match(/([\d.]+)\s*miles?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
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
    const distanceMiles = distanceText ? parseDistanceMiles(distanceText) : null;

    push({ detailUrl, name: nameRaw, phone, address, distanceText, distanceMiles });
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

/* Appointments resolution + text extraction */
const APPT_SLUGS = [
  "/appointments",
  "/appointments-and-opening-times",
  "/opening-times",
  "/patients-and-appointments",
  "/patients",
  "/registration",
  "/registering",
  "/who-we-can-accept",
  "/information-for-patients",
  "/about-our-services"
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
      const t = (($(a).text()||"")+"").toLowerCase().trim();
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
  if (href) candidates.add(new URL(href, detailUrl).toString());
  APPT_SLUGS.forEach((slug) => {
    candidates.add(new URL(`.${slug}`, detailUrl).toString());
    candidates.add(new URL(slug, detailUrl).toString());
  });

  for (const u of candidates) {
    const html = await fetchPage(u);
    if (html && html.length > 200) return { apptUrl: u, fallbackHtml: "" };
  }
  return { apptUrl: "", fallbackHtml: detailHtml }; // no appt page → scan practice page
}

function extractFromPanels($) {
  const SELS = [
    ".nhsuk-notification-banner",
    ".nhsuk-warning-callout",
    ".nhsuk-inset-text",
    ".nhsuk-panel",
    ".nhsuk-card",
    "[role='alert']",
    "[role='status']",
    "[aria-live]",
    ".nhsuk-u-visually-hidden",
    ".acceptance-status",
    ".nhsuk-message"
  ];
  const chunks = [];
  for (const sel of SELS) {
    $(sel).each((_, el) => {
      const t = (($(el).text()||"")+"").replace(/\s+/g," ").trim();
      if (t && t.length > 20) chunks.push(t);
    });
  }
  return chunks;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const parts = [];

  parts.push(...extractFromPanels($));

  const rx = /(nhs|accept|appointment|opening\s+times|patients|registration|register|who\s+we\s+can\s+accept)/i;
  $("h1,h2,h3").each((_, h) => {
    const head = (($(h).text()||"")+"").toLowerCase();
    if (rx.test(head)) {
      const buf = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 60) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol","section"].includes(tag)) {
          const t = (cur.text()||"").replace(/\s+/g," ").trim();
          if (t) buf.push(t);
        }
        cur = cur.next(); hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined.length > 60) parts.push(joined);
    }
  });

  const og = $('meta[property="og:description"]').attr("content");
  if (og && og.length > 30) parts.push(og.replace(/\s+/g," ").trim());

  if (!parts.length) {
    const wrappers = ["main","#maincontent",".nhsuk-main-wrapper",".nhsuk-width-container",".nhsuk-u-reading-width"];
    for (const sel of wrappers) {
      const t = ($(sel).text()||"").replace(/\s+/g," ").trim();
      if (t.length > 160) parts.push(t);
    }
  }

  if (!parts.length) parts.push((($.root().text()||"")+"").replace(/\s+/g," ").trim().slice(0, 8000));
  parts.sort((a,b)=> b.length - a.length);
  return parts[0] || "";
}

/* Classifier */
const RX_NOT_CONFIRMED =
  /\b(not\s+confirmed|has\s+not\s+confirmed|have\s+not\s+confirmed|unable\s+to\s+confirm)\b.*\b(accept|register)/i;
const RX_NEGATIVE =
  /\b(private only|nhs not available|not (currently )?accepting|no longer accepting|cannot accept|not taking on|nhs list closed|nhs capacity full|emergency only|urgent care only)\b/i;
const RX_WAITLIST = /\b(waiting list|register your interest|expression of interest)\b/i;

const POS_STRICT = [
  "this dentist currently accepts new nhs patients for routine dental care",
  "this dentist currently accepts new nhs patients",
  "currently accepts new nhs patients",
  "accepts new nhs patients",
  "we are accepting new nhs patients",
  "we are currently accepting new nhs patients",
  "taking on new nhs patients",
  "now accepting nhs patients",
  "now registering nhs patients",
  "currently registering nhs patients",
  "we are able to register nhs patients",
  "we can accept new nhs patients",
  "limited nhs availability",
  "accepting new nhs adult patients",
  "accepting nhs patients now"
];

function classifyAcceptance(text) {
  const mode = (ACCEPT_MODE || "strict").toLowerCase();
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");

  if (RX_NOT_CONFIRMED.test(t)) return "NONE";
  if (RX_NEGATIVE.test(t)) return "NONE";
  if (RX_WAITLIST.test(t)) return "NONE";

  const child = /\b(children only|only accept(?:ing)? children|under\s*18|aged\s*(1[0-7]|[1-9])\s*or\s*under)\b/i.test(t) &&
                /\b(accept|accepting|taking on|register|registering)\b/i.test(t);
  if (child) return "CHILD_ONLY";

  if (POS_STRICT.some(p => t.includes(p))) return "ACCEPTING";

  if (mode === "lenient") {
    if (/\bnhs\b/.test(t) && /\b(accept|accepting|taking on|register|registering)\b/.test(t)) {
      return "ACCEPTING";
    }
  }
  return "UNKNOWN";
}

/* Evidence (optional) */
const PracticeEvidenceSchema =
  mongoose.models.PracticeEvidence?.schema ||
  new mongoose.Schema(
    {
      practiceUrl: { type: String, index: true },
      dateKey: { type: String, index: true },
      verdict: String,
      reason: String,
      source: String,
      snippet: String,
      scannedAt: { type: Date, default: Date.now },
    },
    { versionKey: false, collection: "PracticeEvidence" }
  );
const PracticeEvidence =
  mongoose.models.PracticeEvidence || mongoose.model("PracticeEvidence", PracticeEvidenceSchema);

/* Postmark send */
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

/* Safe template wrapper */
function safeRenderEmail(type, data) {
  try {
    const out = renderEmail(type, data) || {};
    if (out.subject && out.html) return out;
    throw new Error("renderEmail returned empty");
  } catch {
    if (type === "availability") {
      const subject = `NHS Dentist Availability – ${data?.postcode ?? ""} (${data?.radius ?? ""} miles)`;
      const list = (data?.practices || []).map(p => {
        const bits = [
          p.name || "Practice",
          p.phone ? `tel: ${p.phone}` : "",
          p.distanceText || "",
        ].filter(Boolean).join(" — ");
        const links = [p.appointmentUrl, p.mapUrl, p.detailUrl].filter(Boolean).map(u=>`<a href="${u}">${u}</a>`).join(" | ");
        return `<li>${bits}<br>${links}</li>`;
      }).join("");
      return {
        subject,
        html: `<div style="font-family:system-ui"><h2>NHS Availability</h2><ul>${list}</ul></div>`
      };
    }
    return {
      subject: "Welcome to DentistRadar",
      html: `<div style="font-family:system-ui"><h2>Welcome</h2><p>You’ll receive alerts when nearby practices accept new NHS patients.</p></div>`
    };
  }
}

/* Jobs (Watch + fallback to 'watches') */
async function buildJobs(filterPostcode) {
  const norm = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
  const match = filterPostcode ? { postcode: norm(filterPostcode) } : {};

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
    postcode: norm(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).map((e) => String(e).trim().toLowerCase()).filter(validEmail),
  }));
}

/* Optional run report */
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

/* Scan a postcode group */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const practices = await discoverPractices(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${practices.length}`);
  if (!practices.length) {
    console.log("[INFO] No practice detail URLs discovered for this query.");
    return { accepting: [], childOnly: [], emailAttempts: 0, scanned: 0 };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format("YYYY-MM-DD");

  const acceptingDetails = [];
  const childOnlyDetails = [];

  let cApptResolved = 0,
      cApptFallback = 0,
      cUnknown = 0;

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

          // Appointments first
          const { apptUrl, fallbackHtml } = await resolveAppointmentsUrl(detailUrl);
          let sourceHtml = "";
          let source = "appointments";

          if (apptUrl) {
            sourceHtml = await fetchPage(apptUrl);
            if (sourceHtml) cApptResolved++;
          }
          if (!sourceHtml) {
            sourceHtml = fallbackHtml || await fetchPage(detailUrl);
            source = "detail";
            cApptFallback++;
          }
          if (!sourceHtml) {
            await PracticeEvidence.create({
              practiceUrl: detailUrl, dateKey, verdict: "UNKNOWN",
              reason: "NO_APPT_PAGE", source, snippet: ""
            });
            return;
          }

          const text = extractAppointmentsText(sourceHtml);
          const verdict = classifyAcceptance(text);
          if (verdict === "UNKNOWN") cUnknown++;

          const reason = verdict === "ACCEPTING" ? "MATCH" :
                         (/\b(waiting list|expression of interest|register your interest)\b/i.test(text) ? "WAITLIST" :
                           /\b(private only|nhs not available)\b/i.test(text) ? "PRIVATE_ONLY" :
                           "UNKNOWN");
          const snippet = (() => {
            const rx = /(accept|accepting|taking on|register|nhs|waiting list|expression of interest)/i;
            const m = text.match(rx);
            if (!m) return text.slice(0, 420).trim();
            const i = Math.max(0, text.toLowerCase().indexOf(m[0].toLowerCase()));
            const start = Math.max(0, i - 210);
            return text.slice(start, start + 420).trim();
          })();

          await PracticeEvidence.create({
            practiceUrl: detailUrl,
            dateKey,
            verdict,
            reason,
            source,
            snippet,
          });

          if (DEBUG && (verdict === "ACCEPTING" || verdict === "UNKNOWN")) {
            console.log(`[DEBUG] ${verdict} @ ${detailUrl} src=${source} →`, snippet.slice(0, 180));
          }

          // Build card
          // Try to enrich with <h1> when name missing
          let name = p.name;
          if (!name) {
            const $ = cheerio.load(sourceHtml);
            const h = $("h1").first().text().trim();
            if (h) name = h;
          }
          const distanceMiles = p.distanceMiles ?? parseDistanceMiles(p.distanceText || "");

          const card = {
            name: name || nameFromUrl(detailUrl) || "NHS Dental Practice",
            address: p.address || undefined,
            phone: p.phone || undefined,
            distanceText: p.distanceText || undefined,
            distanceMiles: distanceMiles != null ? distanceMiles : undefined,
            mapUrl: (p.address || name)
              ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
                  postcode
                )}&destination=${encodeURIComponent(p.address || name)}`
              : undefined,
            appointmentUrl: apptUrl || undefined,
            detailUrl,
            checkedAt: new Date(),
          };

          if (verdict === "ACCEPTING") {
            acceptingDetails.push(card);
            await EmailLog.create({
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "ACCEPTING",
              sentAt: new Date(),
            });
          } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnlyDetails.push(card);
            await EmailLog.create({
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "CHILD_ONLY",
              sentAt: new Date(),
            });
          }
        } catch (e) {
          if (DEBUG) console.log("[SCAN ITEM ERR]", e?.message);
        }
      })
    )
  );

  console.log(
    `  • Resolved appt pages: ${cApptResolved}, Fallback-to-detail: ${cApptFallback}, Unknown verdicts: ${cUnknown}`
  );

  const hasAccepting = acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);
  let emailAttempts = 0;

  if (!hasAccepting) {
    console.log("No accepting/eligible results; skipping email.");
    await sendRunReport({
      postcode,
      radius: radiusMiles,
      discovered: practices.length,
      apptResolved: cApptResolved,
      apptFallback: cApptFallback,
      unknown: cUnknown,
      recipientsCount: recipients?.length || 0,
    });
    return { accepting: [], childOnly: [], emailAttempts, scanned: practices.length };
  }

  if (!recipients?.length) {
    console.log(`Found ${acceptingDetails.length + childOnlyDetails.length} results but no recipients; not emailing.`);
    return { accepting: acceptingDetails, childOnly: childOnlyDetails, emailAttempts, scanned: practices.length };
  }

  const all = [...acceptingDetails, ...(INCLUDE_CHILD ? childOnlyDetails : [])];

  // Use safe renderer (never let template kill a good run)
  const { subject, html } = safeRenderEmail("availability", {
    postcode,
    radius: radiusMiles,
    practices: all,
    includeChildOnly: INCLUDE_CHILD,
    scannedAt: new Date(),
  });

  const sendRes = await sendEmail(recipients, subject, html);
  if (sendRes.ok) emailAttempts += 1;

  return { accepting: acceptingDetails, childOnly: childOnlyDetails, emailAttempts, scanned: practices.length };
}

/* Runner */
export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) await connectMongo(MONGO_URI);

  console.log(`🦷 DentistRadar scanner — ${ACCEPT_MODE.toLowerCase()} mode, timeout=${REQUEST_TIMEOUT}ms retries=${RETRIES}`);

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
