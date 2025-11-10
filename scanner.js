// scanner.js (v9.0 email-upgraded, models aligned)
// Behaviours preserved; uses shared models (watches), curated HTML emails.
// If you had your own discovery/classification, keep it below—this version
// includes a robust HTML-first discovery + appointments classifier.

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";
import crypto from "node:crypto";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

/* ────────────────────────────────────────────────────────────────
   ENV / constants
──────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",
  INCLUDE_CHILD_ONLY = "false",
  MAX_CONCURRENCY = "6",
  APPT_TTL_HOURS = "6",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const TTL_APPT_MS = Math.max(1, Number(APPT_TTL_HOURS) || 6) * 60 * 60 * 1000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex");
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();

const normText = (s) =>
  String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

/* ────────────────────────────────────────────────────────────────
   HTTP helper
──────────────────────────────────────────────────────────────── */
async function httpGet(url, referer = "") {
  try {
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-GB,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: referer || "https://www.nhs.uk/",
        Cookie: "nhsuk-cookie-consent=accepted",
        "Cache-Control": "no-cache",
      },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 500,
    });
    if (res.status >= 400) return null;
    return res.data;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────
   Discovery — robust HTML-first (no Playwright)
──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  const urls = [];

  const pages = 6;
  const sizes = [24, 48, 96];

  // /results/<PC>?distance=R
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes) {
      urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
    }
  }
  // observed variant: /results/<PC>&distance=R (no '?')
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
  }
  // query variant
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes) {
      urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
    }
  }
  // legacy other-services (sometimes 410)
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
  }

  return Array.from(new Set(urls));
}

function extractDetailUrlsFromResults(html) {
  const $ = cheerio.load(html);
  const out = new Set();

  const pushAbs = (href) => {
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) out.add(abs.split("#")[0]);
  };

  // direct anchors
  $('a[href^="/services/dentists/"], a[href*="/services/dentists/"]').each((_, a) => pushAbs($(a).attr("href")));

  // inline scripts (json/json-ld/next data)
  $("script").each((_, s) => {
    const type = (s.attribs?.type || "").toLowerCase();
    if (s.attribs?.src) return;
    if (!type || /json|ld\+json|module/.test(type)) {
      const txt = $(s).text() || "";
      const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
      const matches = txt.match(rx);
      if (matches) matches.forEach((m) => out.add(m.split("#")[0]));
    }
  });

  // raw fallback
  const body = typeof html === "string" ? html : $.root().html() || "";
  const rx2 = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
  const hits = body.match(rx2);
  if (hits) hits.forEach((m) => out.add(m.split("#")[0]));

  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Appointments resolution + classifier
──────────────────────────────────────────────────────────────── */
function findAppointmentsHref($) {
  let href =
    $('a[href*="/appointments"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href") ||
    $('a[href*="appointments-and-opening-times"]').attr("href") ||
    $('a[href*="opening-times"]').attr("href");

  if (!href) {
    $('nav a, .nhsuk-navigation a, [role="navigation"] a, .nhsuk-list a').each((_, a) => {
      const t = String($(a).text() || "").toLowerCase().trim();
      const h = $(a).attr("href") || "";
      if (!href && (t.includes("appointment") || t.includes("opening"))) href = h;
    });
  }
  return href || "";
}

async function resolveAppointmentsUrl(detailUrl) {
  const detailHtml = await httpGet(detailUrl);
  if (!detailHtml) return "";

  const $ = cheerio.load(detailHtml);
  let href = findAppointmentsHref($);
  const candidates = [];
  if (href) candidates.push(new URL(href, detailUrl).toString());
  candidates.push(new URL("./appointments", detailUrl).toString());
  candidates.push(new URL("./appointments-and-opening-times", detailUrl).toString());
  candidates.push(new URL("./opening-times", detailUrl).toString());

  for (const u of Array.from(new Set(candidates))) {
    const html = await httpGet(u, detailUrl);
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
      let cur = $(h).next(),
        hops = 0;
      while (cur.length && hops < 30) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p", "div", "li", "ul", "ol", "section"].includes(tag))
          buf.push(String(cur.text() || "").replace(/\s+/g, " ").trim());
        cur = cur.next();
        hops++;
      }
      const joined = buf.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  if (!buckets.length) {
    const wrappers = ["main", "#maincontent", ".nhsuk-main-wrapper", ".nhsuk-width-container"];
    for (const sel of wrappers) {
      const t = String($(sel).text() || "").replace(/\s+/g, " ").trim();
      if (t.length > 120) buckets.push(t);
    }
  }
  if (!buckets.length) buckets.push(String($.root().text() || "").replace(/\s+/g, " ").trim());

  buckets.sort((a, b) => b.length - a.length);
  return buckets[0] || "";
}

function classifyAcceptance(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/g, " ").replace(/’/g, "'");

  const hasChildren =
    t.includes("children") || /under\s*18/.test(t) || /aged\s*(1[0-7]|[1-9])\s*or\s*under/.test(t);
  const mentionsNhs = t.includes("nhs patient") || t.includes("nhs patients") || t.includes("nhs");

  const phrasesAccept = [
    "this dentist currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "we are accepting new nhs",
    "accepting new nhs patients",
    "we accept new nhs patients",
    "now accepting nhs patients",
  ];
  const phrasesChildOnly = [
    "only accepts new nhs patients who are children",
    "only accepting children",
    "accepting children only",
    "accepting nhs patients under 18",
    "currently only accepts children",
  ];
  const phrasesNotAccept = [
    "not accepting new nhs patients",
    "no longer accepting new nhs patients",
    "we are not currently accepting nhs patients",
    "not currently accepting",
  ];

  if (phrasesNotAccept.some((p) => t.includes(p))) return "NONE";
  if (phrasesChildOnly.some((p) => t.includes(p)) || (t.includes("only accepts") && hasChildren)) return "CHILD_ONLY";
  if (
    phrasesAccept.some((p) => t.includes(p)) ||
    (mentionsNhs && (t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting")) && !t.includes("only"))
  )
    return "ACCEPTING";

  if (t.includes("waiting list") || t.includes("register your interest")) return "NONE";
  return "UNKNOWN";
}

async function fetchAppointments(detailUrl, memo) {
  const now = Date.now();
  const prev = memo.get(detailUrl);
  const apptUrl = prev?.apptUrl || (await resolveAppointmentsUrl(detailUrl));
  if (!apptUrl) return { status: prev?.status || "UNKNOWN", changed: false, apptUrl: "" };

  if (prev?.lastFetchedAt && now - prev.lastFetchedAt < TTL_APPT_MS) {
    return { status: prev.status || "UNKNOWN", changed: false, apptUrl };
  }

  const html = await httpGet(apptUrl, detailUrl);
  if (!html) {
    memo.set(detailUrl, { ...(prev || {}), apptUrl, lastFetchedAt: now });
    return { status: prev?.status || "UNKNOWN", changed: false, apptUrl };
  }

  const text = extractAppointmentsText(html);
  const hash = sha1(text);
  const status = classifyAcceptance(text);
  const changed = hash !== prev?.hash || status !== prev?.status;

  memo.set(detailUrl, { apptUrl, status, hash, lastFetchedAt: now, lastChangedAt: changed ? now : prev?.lastChangedAt });
  return { status, changed, apptUrl };
}

/* ────────────────────────────────────────────────────────────────
   Email via Postmark (HTML templates)
──────────────────────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  const token = POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN || "";
  if (!toList?.length) {
    console.log("✋ Email skipped: recipients empty.");
    return { ok: false, reason: "no_recipients" };
    }
  if (!token) {
    console.log("✋ Email skipped: POSTMARK token missing.");
    return { ok: false, reason: "no_token" };
  }

  try {
    const res = await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": token, "Content-Type": "application/json", Accept: "application/json" }, timeout: 15000, validateStatus: () => true }
    );

    if (res.status >= 200 && res.status < 300) {
      console.log(`📧 Postmark OK: ${res.status} id=${res.data?.MessageID || "n/a"}`);
      return { ok: true, id: res.data?.MessageID };
    } else {
      console.log("❌ Postmark error:", res.status, res.data);
      return { ok: false, status: res.status, body: res.data };
    }
  } catch (err) {
    console.log("❌ Postmark exception:", err?.message, err?.response?.data);
    return { ok: false, error: err?.message, body: err?.response?.data };
  }
}

/* ────────────────────────────────────────────────────────────────
   Jobs + Runner
──────────────────────────────────────────────────────────────── */
async function discoverDetailUrls(postcode, radius) {
  const urlsToTry = buildResultUrls(postcode, radius);
  const detailSet = new Set();
  for (const url of urlsToTry) {
    const html = await httpGet(url);
    if (!html) continue;
    const detailUrls = extractDetailUrlsFromResults(html);
    detailUrls.forEach((u) => detailSet.add(u));
    if (detailSet.size >= 120) break;
    await sleep(100);
  }
  return Array.from(detailSet);
}

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
  const memo = new Map();

  const acceptingDetails = [];
  const childOnlyDetails = [];

  await Promise.all(
    detailUrls.map((detailUrl) =>
      limit(async () => {
        try {
          // per-practice, daily dedupe
          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          const { status, apptUrl } = await fetchAppointments(detailUrl, memo);

          const card = {
            name: undefined, // can be enriched later if you store it
            address: undefined,
            appointmentUrl: apptUrl || detailUrl,
            detailUrl,
            phone: undefined,
            distanceMiles: undefined,
            lat: undefined,
            lon: undefined,
            checkedAt: new Date(),
          };

          if (status === "ACCEPTING") {
            acceptingDetails.push(card);
            await EmailLog.create({
              to: "",
              subject: "",
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "ACCEPTING",
              sentAt: new Date(),
            });
          } else if (status === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnlyDetails.push(card);
            await EmailLog.create({
              to: "",
              subject: "",
              type: "availability",
              practiceUrl: detailUrl,
              dateKey,
              status: "CHILD_ONLY",
              sentAt: new Date(),
            });
          }
        } catch {
          // continue on errors
        }
      })
    )
  );

  // send curated HTML email
  const shouldSend =
    acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);

  if (!shouldSend) {
    console.log("No accepting/eligible results or INCLUDE_CHILD=false; skipping email.");
    return { accepting: [], childOnly: [] };
  }
  if (!recipients?.length) {
    console.log("Recipients empty for this postcode; skipping email.");
    return { accepting: acceptingDetails, childOnly: childOnlyDetails };
  }

  const practices = [...acceptingDetails, ...childOnlyDetails];

  const { subject, html } = renderEmail("availability", {
    postcode,
    radius: radiusMiles,
    practices,
    includeChildOnly: INCLUDE_CHILD,
  });

  const resp = await sendEmail(recipients, subject, html);
  console.log("sendEmail result:", resp);

  return { accepting: acceptingDetails, childOnly: childOnlyDetails };
}

export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) {
    await connectMongo(MONGO_URI);
  }
  console.log("🦷 DentistRadar: HTML scanner + curated emails");

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
    await sleep(120);
  }

  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
