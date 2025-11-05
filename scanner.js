/**
 * DentistRadar — scanner.js (v4.3)
 * - Stable Playwright discovery (no premature close; guarded loops)
 * - Geolocation granted + UA/headers
 * - Tries both results URL shapes, then interactive search
 * - Network-sniff + DOM scrape of dentist detail links
 * - Appointments parsing -> ACCEPTING / CHILD_ONLY
 * - Postmark email + per-day de-dupe
 */

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";
import { chromium } from "playwright";
import { execSync } from "node:child_process";

/* ────────────────────────────────────────────────────────────────────
   ENV
   ────────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  HEADLESS = "true",
  PW_SLOWMO = "0",
  DEFAULT_GEO_LAT = "51.5074",
  DEFAULT_GEO_LON = "-0.1278",
  POSTCODE_COORDS = ""
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

/* ────────────────────────────────────────────────────────────────────
   Mongo models (guarded)
   ────────────────────────────────────────────────────────────────── */
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

/* ────────────────────────────────────────────────────────────────────
   Utils
   ────────────────────────────────────────────────────────────────── */
const normText = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCoordMap(raw) {
  const m = new Map();
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
      if (Number.isFinite(lat) && Number.isFinite(lon)) m.set(normPc(pcRaw), { lat, lon });
    });
  return m;
}
const ENV_COORDS = parseCoordMap(POSTCODE_COORDS);

async function resolveCoordsForPostcode(postcode) {
  const pc = normPc(postcode);
  if (ENV_COORDS.has(pc)) return ENV_COORDS.get(pc);
  return { lat: Number(DEFAULT_GEO_LAT), lon: Number(DEFAULT_GEO_LON) };
}

async function httpGet(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9" }
    });
    return res.data;
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────
   Playwright bootstrap
   ────────────────────────────────────────────────────────────────── */
async function ensureChromiumInstalled() {
  try {
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  } catch (e) {
    if (/Executable doesn't exist|Looks like Playwright/i.test(String(e?.message || ""))) {
      console.log("[PW] Installing Chromium …");
      execSync("npx playwright install chromium", { stdio: "inherit" });
      return;
    }
    throw e;
  }
}

async function newGeoContext(geo) {
  const browser = await chromium.launch({
    headless: String(HEADLESS).toLowerCase() !== "false",
    slowMo: Number(PW_SLOWMO) || 0,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
  });

  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-GB",
    viewport: { width: 1366, height: 900 },
    timezoneId: "Europe/London",
    geolocation: { latitude: geo.lat, longitude: geo.lon },
    permissions: ["geolocation"],
    extraHTTPHeaders: {
      Referer: "https://www.nhs.uk/service-search/find-a-dentist",
      "Sec-CH-UA": '"Chromium";v="129", "Not?A_Brand";v="24"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Accept-Language": "en-GB,en;q=0.9"
    }
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    Object.defineProperty(navigator, "language", { get: () => "en-GB" });
    Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
  });

  return { browser, context, page };
}

/* ────────────────────────────────────────────────────────────────────
   Discovery helpers (safe listeners, guarded loops)
   ────────────────────────────────────────────────────────────────── */
async function acceptCookiesIfShown(page) {
  const sels = [
    "#nhsuk-cookie-banner__link_accept",
    'button#accept-additional-cookies',
    'button:has-text("Accept additional cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("I agree")'
  ];
  for (const sel of sels) {
    const el = page.locator(sel);
    if ((await el.count()) > 0) {
      await el.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(250);
      break;
    }
  }
}

function addFromText(set, text) {
  if (!text) return;
  const re = /https:\/\/www\.nhs\.uk\/services\/dentists\/[^\s"'<)]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].split("#")[0];
    if (!/\/appointments(\b|\/|\?|#)/i.test(url)) set.add(url);
  }
}

async function collectDetailLinksFromDom(page) {
  if (page.isClosed()) return [];
  return await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      try {
        const abs = new URL(href, location.href).toString();
        if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs) && !/\/appointments(\b|\/|\?|#)/i.test(abs)) {
          out.add(abs.split("#")[0]);
        }
      } catch {}
    });
    return Array.from(out);
  });
}

function addResponseSniffer(page, bucketSet) {
  const listener = async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!/json|html|text/.test(ct)) return;
      const body = await resp.text().catch(() => "");
      addFromText(bucketSet, body);
    } catch {}
  };
  page.on("response", listener);
  return listener;
}
function removeResponseSniffer(page, listener) {
  try { page.off("response", listener); } catch {}
}

async function gotoSafely(page, url) {
  if (page.isClosed()) return false;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await acceptCookiesIfShown(page);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(700);
    return true;
  } catch (e) {
    console.log("[DISCOVERY WARN]", url, "→", e.message.split("\n")[0]);
    return false;
  }
}

/* ────────────────────────────────────────────────────────────────────
   Discovery: results URLs (both shapes) → interactive fallback
   ────────────────────────────────────────────────────────────────── */
async function discoverDetailUrlsWithPlaywright(postcode, radiusMiles) {
  await ensureChromiumInstalled();
  const geo = await resolveCoordsForPostcode(postcode);
  const { browser, context, page } = await newGeoContext(geo);

  const all = new Set();
  try {
    const enc = encodeURIComponent(postcode);
    const r = Math.max(1, Math.min(30, Math.round(radiusMiles)));

    const urlShapes = [
      // shape A: explicit postcode param
      (pageNum) =>
        `https://www.nhs.uk/service-search/find-a-dentist/results?postcode=${enc}&distance=${r}${
          pageNum > 1 ? `&results=24&page=${pageNum}` : "&results=24"
        }`,
      // shape B: postcode in path
      (pageNum) =>
        `https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}${
          pageNum > 1 ? `&results=24&page=${pageNum}` : "&results=24"
        }`
    ];

    // 1) Try both shapes with pagination (sequential; guarded)
    for (const shape of urlShapes) {
      if (page.isClosed()) break;
      for (let p = 1; p <= 6; p++) {
        if (page.isClosed()) break;
        const url = shape(p);
        const listener = addResponseSniffer(page, all);
        const ok = await gotoSafely(page, url);
        if (!ok) {
          removeResponseSniffer(page, listener);
          if (page.isClosed()) break;
          continue;
        }
        const domLinks = await collectDetailLinksFromDom(page);
        domLinks.forEach((u) => all.add(u));
        removeResponseSniffer(page, listener);

        if (all.size && p >= 2) break; // we have links, stop early
      }
      if (all.size) break; // next shape not needed
    }

    // 2) Interactive fallback if still empty
    if (!all.size && !page.isClosed()) {
      // open search landing
      const listener = addResponseSniffer(page, all);
      const ok = await gotoSafely(page, "https://www.nhs.uk/service-search/find-a-dentist");
      if (ok && !page.isClosed()) {
        // find input (multiple strategies)
        const probes = [
          () => page.getByRole("textbox", { name: /postcode|location|town|city/i }),
          () => page.getByLabel(/postcode|location|town|city/i),
          () => page.getByPlaceholder(/postcode|location|town|city/i),
          () => page.locator('input[name="search"]'),
          () => page.locator('input#location'),
          () => page.locator('input#postcode'),
          () => page.locator('input[type="search"]'),
          () => page.locator('input[type="text"]')
        ];
        let input = null;
        for (const fn of probes) {
          if (page.isClosed()) break;
          const loc = fn();
          try {
            if ((await loc.count()) > 0) {
              input = loc.first();
              break;
            }
          } catch {}
        }

        if (input && !page.isClosed()) {
          await input.fill("");
          await input.type(postcode, { delay: 25 }).catch(() => {});
          await page.waitForTimeout(150);
          // try set radius
          const sels = [
            () => page.getByRole("combobox", { name: /distance/i }),
            () => page.locator('select[name="distance"]'),
            () => page.locator('select#distance')
          ];
          for (const fn of sels) {
            const sel = fn();
            if ((await sel.count()) > 0) {
              await sel.selectOption({ value: String(r) }).catch(async () => {
                await sel.selectOption({ label: new RegExp(`\\b${r}\\b`) }).catch(() => {});
              });
              await page.waitForTimeout(80);
              break;
            }
          }
          // submit
          const tries = [
            () => page.getByRole("button", { name: /search/i }),
            () => page.locator('button[type="submit"]'),
            () => page.locator('input[type="submit"]')
          ];
          let clicked = false;
          for (const fn of tries) {
            const b = fn();
            if ((await b.count()) > 0) {
              await b.first().click().catch(() => {});
              clicked = true;
              break;
            }
          }
          if (!clicked) await input.press("Enter").catch(() => {});

          // wait + harvest
          if (!page.isClosed()) {
            await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(800);
            const domLinks2 = await collectDetailLinksFromDom(page);
            domLinks2.forEach((u) => all.add(u));
          }
        }
      }
      removeResponseSniffer(page, listener);
    }

    // 3) “Next” pagination from interactive results (only if we got some)
    if (all.size && !page.isClosed()) {
      for (let i = 0; i < 6; i++) {
        if (page.isClosed()) break;
        const next = page.locator('a[rel="next"], a[aria-label="Next"], a:has-text("Next")').first();
        if ((await next.count()) === 0) break;

        const before = all.size;
        const listener = addResponseSniffer(page, all);
        await next.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(600);

        const dom = await collectDetailLinksFromDom(page);
        dom.forEach((u) => all.add(u));
        removeResponseSniffer(page, listener);

        if (all.size === before) break; // no new links
      }
    }
  } catch (e) {
    console.log("[DISCOVERY ERROR]", e?.message || e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`[DISCOVERY] Playwright collected ${all.size} detail URL(s).`);
  return Array.from(all);
}

/* ────────────────────────────────────────────────────────────────────
   Appointments → acceptance
   ────────────────────────────────────────────────────────────────── */
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

  if (!href) return html;
  const apptUrl = new URL(href, detailUrl).toString();
  return (await httpGet(apptUrl)) || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const buckets = [];

  $("h1,h2,h3").each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(),
        hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p", "div", "li", "ul", "ol"].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next();
        hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) buckets.push(joined);
    }
  });

  const wrappers = ["main", ".nhsuk-main-wrapper", "#content", "#maincontent", ".nhsuk-width-container", ".nhsuk-u-reading-width"];
  for (const sel of wrappers) {
    const t = normText($(sel).text());
    if (t && t.length > 120) buckets.push(t);
  }

  if (!buckets.length) buckets.push(normText($.root().text()));
  buckets.sort((a, b) => b.length - a.length);
  return buckets[0] || "";
}

function classifyAcceptance(text) {
  const t = normText(text).replace(/’/g, "'").toLowerCase();

  const childOnly =
    (t.includes("only accepts") || t.includes("currently only accepts") || t.includes("accepting only")) &&
    (t.includes("children aged 17 or under") || t.includes("children only") || /under\s*18/.test(t));

  const accepting =
    t.includes("this dentist currently accepts new nhs patients") ||
    ((t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting") || t.includes("currently accepting")) &&
      t.includes("nhs patients") &&
      !childOnly);

  if (childOnly) return "CHILD_ONLY";
  if (accepting) return "ACCEPTING";
  return "NONE";
}

/* ────────────────────────────────────────────────────────────────────
   Email via Postmark
   ────────────────────────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN, "Content-Type": "application/json" }, timeout: 12000 }
    );
    console.log(`📧 Email sent to ${toList.length} — ${subject}`);
  } catch (e) {
    console.log("Postmark error:", e?.response?.data || e.message);
  }
}

/* ────────────────────────────────────────────────────────────────────
   Scan one job
   ────────────────────────────────────────────────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) — NHS discovery ---`);

  const detailUrls = await discoverDetailUrlsWithPlaywright(postcode, radiusMiles);
  if (!detailUrls.length) {
    console.log("[INFO] No practice detail URLs discovered for this postcode this run.");
    return { accepting: [], childOnly: [] };
    }

  const limit = pLimit(CONCURRENCY);
  const accepting = [];
  const childOnly = [];
  const dateKey = dayjs().format("YYYY-MM-DD");

  await Promise.all(
    detailUrls.map((url) =>
      limit(async () => {
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

/* ────────────────────────────────────────────────────────────────────
   Runner (exported)
   ────────────────────────────────────────────────────────────────── */
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
    await sleep(150);
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
