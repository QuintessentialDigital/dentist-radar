// scanner.js — discovery hardened (headers, cookies, debug dumps, rel=next follow)
// ENV needed:
//   MONGO_URI, EMAIL_FROM, POSTMARK_SERVER_TOKEN|POSTMARK_TOKEN
//   POSTMARK_MESSAGE_STREAM=outbound
//   INCLUDE_CHILD_ONLY=false
//   MAX_CONCURRENCY=6
//   APPT_TTL_HOURS=6
//   DEBUG_DISCOVERY=true   (optional, prints per-URL status and first 800 chars)

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";
import crypto from "node:crypto";

import { connectMongo, Watch, EmailLog } from "./models.js";
import { renderEmail } from "./emailTemplates.js";

const {
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  POSTMARK_MESSAGE_STREAM = "outbound",
  INCLUDE_CHILD_ONLY = "false",
  MAX_CONCURRENCY = "6",
  APPT_TTL_HOURS = "6",
  DEBUG_DISCOVERY = "false",
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const TTL_APPT_MS = Math.max(1, Number(APPT_TTL_HOURS) || 6) * 60 * 60 * 1000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => crypto.createHash("sha1").update(String(s || "")).digest("hex");
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();

const normText = (s) =>
  String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();

const DEBUG = String(DEBUG_DISCOVERY).toLowerCase() === "true";

/* ────────────────────────────────────────────────────────────────
   HTTP helper with hardened headers/cookies
──────────────────────────────────────────────────────────────── */
function defaultHeaders(ref = "https://www.nhs.uk/") {
  return {
    "User-Agent": UA,
    "Accept-Language": "en-GB,en;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: ref,
    Connection: "keep-alive",
    DNT: "1",
    "Upgrade-Insecure-Requests": "1",
    // modern browser-ish hints (helps some CDNs)
    "sec-ch-ua": '"Chromium";v="121", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    // consent cookies NHS often expects
    Cookie: [
      "nhsuk-cookie-consent=accepted",
      "nhsuk-patient-preferences=accepted",
      "OptanonConsent=isIABGlobal=false&datestamp=2024-12-01T12:00:00.000Z&version=6.33.0",
    ].join("; "),
    "Cache-Control": "no-cache",
  };
}

async function httpGet(url, referer = "https://www.nhs.uk/") {
  try {
    const res = await axios.get(url, {
      timeout: 25000,
      headers: defaultHeaders(referer),
      maxRedirects: 10,
      validateStatus: () => true, // we want to see body even on 404/410
    });
    const body = typeof res.data === "string" ? res.data : "";
    if (DEBUG) {
      console.log(`[GET] ${url} → ${res.status} (len=${body.length})`);
      console.log(body.slice(0, 800).replace(/\s+/g, " ").trim()); // peek first chars
    }
    if (res.status >= 200 && res.status < 400 && body) return body;
    // sometimes 404 with useful body; keep parsing anyway
    if (res.status === 404 && body) return body;
    return null;
  } catch (e) {
    if (DEBUG) console.log(`[GET ERR] ${url} → ${e?.message}`);
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────
   Results URL builders & progressive follow
──────────────────────────────────────────────────────────────── */
function buildResultUrls(postcode, radius) {
  const pcEnc = encodeURIComponent(postcode);
  const base = "https://www.nhs.uk";
  const urls = [];

  // 0) base landing (sometimes hydrates links we can scrape)
  urls.push(`${base}/service-search/find-a-dentist/`);

  // 1) /results/<PC>?distance=R (+pages, +sizes)
  const pages = 6;
  const sizes = [24, 48, 96];
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes) {
      urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}?distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
    }
  }

  // 2) observed variant: /results/<PC>&distance=R (no '?')
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results/${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
  }

  // 3) query variant (?postcode=)
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
    for (const sz of sizes) {
      urls.push(`${base}/service-search/find-a-dentist/results?postcode=${pcEnc}&distance=${radius}${p > 1 ? `&page=${p}` : ""}&results=${sz}`);
    }
  }

  // 4) legacy other-services (some mirrors return 410 with content)
  for (let p = 1; p <= pages; p++) {
    urls.push(`${base}/service-search/other-services/Dentists/Location/${pcEnc}?results=24&distance=${radius}${p > 1 ? `&page=${p}` : ""}`);
  }

  return Array.from(new Set(urls));
}

/* ────────────────────────────────────────────────────────────────
   Extract dentist detail links from assorted HTML/JSON
──────────────────────────────────────────────────────────────── */
function extractDetailUrlsFromResults(html) {
  const out = new Set();
  const $ = cheerio.load(html);

  const pushAbs = (href) => {
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.nhs.uk${href.startsWith("/") ? "" : "/"}${href}`;
    if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) out.add(abs.split("#")[0]);
  };

  // A) obvious anchors
  $('a[href^="/services/dentists/"], a[href*="/services/dentists/"]').each((_, a) => pushAbs($(a).attr("href")));

  // B) JSON-LD itemList / SearchResultPage
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).text() || "{}");
      const arr = Array.isArray(j) ? j : [j];
      for (const node of arr) {
        const items = node?.itemListElement || node?.about || [];
        (Array.isArray(items) ? items : [items]).forEach((it) => {
          const url = it?.url || it?.item?.url;
          if (url) pushAbs(url);
        });
      }
    } catch {}
  });

  // C) Next/React data blobs
  $('script[id*="__NEXT_DATA__"], script[type="application/json"]').each((_, s) => {
    const txt = $(s).text() || "";
    const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
    const matches = txt.match(rx);
    if (matches) matches.forEach((m) => out.add(m.split("#")[0]));
  });

  // D) raw fallback
  const rx2 = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;
  const hits = (typeof html === "string" ? html : $.root().html() || "").match(rx2);
  if (hits) hits.forEach((m) => out.add(m.split("#")[0]));

  return Array.from(out);
}

/* ────────────────────────────────────────────────────────────────
   Progressive crawl: start page → follow rel=next if present
──────────────────────────────────────────────────────────────── */
async function progressiveDiscover(startUrl) {
  const seen = new Set();
  const detailSet = new Set();

  let url = startUrl;
  let hops = 0;

  while (url && hops < 8) {
    if (seen.has(url)) break;
    seen.add(url);
    const html = await httpGet(url);
    if (!html) break;

    extractDetailUrlsFromResults(html).forEach((u) => detailSet.add(u));

    const $ = cheerio.load(html);
    const nextHref =
      $('a[rel="next"]').attr("href") ||
      $('a:contains("Next")').attr("href") ||
      $('a[aria-label="Next"]').attr("href");
    url = nextHref ? new URL(nextHref, url).toString() : "";
    hops++;
    await sleep(120);
  }

  return Array.from(detailSet);
}

/* ────────────────────────────────────────────────────────────────
   Appointments resolution + classifier (unchanged)
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
   Discovery orchestration
──────────────────────────────────────────────────────────────── */
async function discoverDetailUrls(postcode, radius) {
  const urls = buildResultUrls(postcode, radius);
  const detailSet = new Set();

  // First try the base results/<PC>?distance=R page progressively (rel=next)
  const first = urls.find((u) => /\/service-search\/find-a-dentist\/results\//.test(u) && u.includes("?distance=") && !u.includes("&page="));
  if (first) {
    const seeds = await progressiveDiscover(first);
    seeds.forEach((u) => detailSet.add(u));
    if (detailSet.size >= 10) return Array.from(detailSet);
  }

  // Fallback: try every variant and scrape
  for (const u of urls) {
    const html = await httpGet(u);
    if (!html) continue;
    extractDetailUrlsFromResults(html).forEach((x) => detailSet.add(x));
    if (detailSet.size >= 150) break;
    await sleep(120);
  }

  return Array.from(detailSet);
}

/* ────────────────────────────────────────────────────────────────
   Jobs + Runner
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
          const already = await EmailLog.findOne({ practiceUrl: detailUrl, dateKey }).lean();
          if (already) return;

          const { status, apptUrl } = await fetchAppointments(detailUrl, memo);

          const card = {
            name: undefined,
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
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "ACCEPTING", sentAt: new Date() });
          } else if (status === "CHILD_ONLY" && INCLUDE_CHILD) {
            childOnlyDetails.push(card);
            await EmailLog.create({ type: "availability", practiceUrl: detailUrl, dateKey, status: "CHILD_ONLY", sentAt: new Date() });
          }
        } catch {
          // continue
        }
      })
    )
  );

  const shouldSend = acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);
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
  await sendEmail(recipients, subject, html);

  return { accepting: acceptingDetails, childOnly: childOnlyDetails };
}

export async function runScan(opts = {}) {
  if (mongoose.connection.readyState !== 1) {
    await connectMongo(MONGO_URI);
  }
  console.log("🦷 DentistRadar: HTML scanner (hardened discovery)");

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

if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
