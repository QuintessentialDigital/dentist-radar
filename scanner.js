/**
 * DentistRadar — scanner.js (Playwright + NHS live search) — v3.5
 * Works in Render live setup with Playwright (self-healing Chromium)
 * - Uses NHS Find-a-Dentist search form directly
 * - Extracts practice detail URLs dynamically
 * - Parses each appointments page for NHS acceptance text
 * - Sends Postmark email alerts
 */

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";
import { chromium } from "playwright";
import { execSync } from "node:child_process";

/* ─────────────────────────
   ENV CONFIG
   ───────────────────────── */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  HEADLESS = "true",
  PW_SLOWMO = "0"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";

/* ─────────────────────────
   MONGO MODELS
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
    dateKey: String,
    status: String,
    to: String,
    subject: String,
    sentAt: { type: Date, default: Date.now }
  },
  { collection: "EmailLog", versionKey: false }
);
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true });

const Watch = getModel("Watch", WatchSchema);
const EmailLog = getModel("EmailLog", EmailLogSchema);

async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { maxPoolSize: 10 });
  console.log("✅ MongoDB connected");
}

/* ─────────────────────────
   PLAYWRIGHT SELF-HEALING
   ───────────────────────── */
async function ensureChromiumInstalled() {
  try {
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  } catch (e) {
    const msg = String(e?.message || "");
    if (/Executable doesn't exist|Looks like Playwright/i.test(msg)) {
      console.log("[PW] Installing Chromium into node_modules …");
      execSync("npx playwright install chromium", { stdio: "inherit" });
      return;
    }
    throw e;
  }
}

/* ─────────────────────────
   BASIC HELPERS
   ───────────────────────── */
const normText = (s) => String(s || "").replace(/\s+/g, " ").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/* ─────────────────────────
   NHS SEARCH AUTOMATION
   ───────────────────────── */
async function acceptCookiesIfShown(page) {
  const buttons = [
    '#nhsuk-cookie-banner__link_accept',
    'button#accept-additional-cookies',
    'button:has-text("Accept additional cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("I agree")'
  ];
  for (const sel of buttons) {
    const b = await page.locator(sel);
    if ((await b.count()) > 0) {
      await b.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      break;
    }
  }
}

async function performSearch(page, postcode, radiusMiles) {
  await page.goto("https://www.nhs.uk/service-search/find-a-dentist", {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });

  await acceptCookiesIfShown(page);

  const input = page.locator('input[name="search"], input#location, input[type="search"]').first();
  await input.fill(postcode);
  await page.waitForTimeout(150);

  const radiusSelect = page.locator('select[name="distance"], select#distance').first();
  if ((await radiusSelect.count()) > 0) {
    await radiusSelect.selectOption({ value: String(radiusMiles) }).catch(() => {});
  }

  const button = page.locator('button[type="submit"], button:has-text("Search"), input[type="submit"]').first();
  if ((await button.count()) > 0) {
    await button.click();
  } else {
    await input.press("Enter");
  }

  await page.waitForSelector('a[href*="/services/dentists/"]', { timeout: 20000 }).catch(() => {});
}

async function collectDetailLinksOnPage(page) {
  return await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^\/services\/dentists\//i.test(href) || href.includes("www.nhs.uk/services/dentists/")) {
        const url = href.startsWith("http") ? href : new URL(href, location.origin).href;
        out.add(url.split("#")[0]);
      }
    });
    return Array.from(out);
  });
}

async function discoverDetailUrlsWithPlaywright(postcode, radiusMiles) {
  await ensureChromiumInstalled();

  const browser = await chromium.launch({
    headless: String(HEADLESS).toLowerCase() !== "false",
    slowMo: Number(PW_SLOWMO) || 0
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36",
    locale: "en-GB"
  });
  const page = await context.newPage();

  const urls = new Set();
  try {
    await performSearch(page, postcode, radiusMiles);
    let links = await collectDetailLinksOnPage(page);
    links.forEach((u) => urls.add(u));

    for (let i = 0; i < 5; i++) {
      const next = page.locator('a[rel="next"], a:has-text("Next")').first();
      if ((await next.count()) === 0) break;
      await next.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForTimeout(800);
      links = await collectDetailLinksOnPage(page);
      links.forEach((u) => urls.add(u));
    }
  } catch (e) {
    console.log("[DISCOVERY ERROR]", e.message);
  } finally {
    await context.close();
    await browser.close();
  }

  console.log(`[DISCOVERY] Playwright collected ${urls.size} detail URL(s).`);
  return Array.from(urls);
}

/* ─────────────────────────
   HTML FETCH + PARSE
   ───────────────────────── */
async function httpGet(url) {
  try {
    const res = await axios.get(url, { timeout: 15000 });
    return res.data;
  } catch {
    return null;
  }
}

async function loadAppointmentsHtml(detailUrl) {
  const html = await httpGet(detailUrl);
  if (!html) return null;
  const $ = cheerio.load(html);
  const link = $('a[href*="/appointments"]').attr("href");
  if (!link) return html;
  const full = new URL(link, detailUrl).href;
  return (await httpGet(full)) || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const txt = $("body").text();
  return normText(txt);
}

function classifyAcceptance(text) {
  const t = text.toLowerCase();
  const childOnly =
    t.includes("only accepts") && (t.includes("under 18") || t.includes("aged 17"));
  const accepting =
    t.includes("currently accepts new nhs patients") && !childOnly;
  return childOnly ? "CHILD_ONLY" : accepting ? "ACCEPTING" : "NONE";
}

/* ─────────────────────────
   EMAIL
   ───────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN } }
    );
    console.log("📧 Email sent:", subject);
  } catch (e) {
    console.log("Postmark error:", e.message);
  }
}

/* ─────────────────────────
   JOB SCAN
   ───────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const detailUrls = await discoverDetailUrlsWithPlaywright(postcode, radiusMiles);
  if (!detailUrls.length) return { accepting: [], childOnly: [] };

  const limit = pLimit(CONCURRENCY);
  const accepting = [];
  const childOnly = [];
  const dateKey = dayjs().format("YYYY-MM-DD");

  await Promise.all(detailUrls.map((url) =>
    limit(async () => {
      const logged = await EmailLog.findOne({ practiceUrl: url, dateKey }).lean();
      if (logged) return;
      const html = await loadAppointmentsHtml(url);
      if (!html) return;
      const verdict = classifyAcceptance(extractAppointmentsText(html));
      if (verdict === "ACCEPTING") {
        accepting.push(url);
        await EmailLog.create({ practiceUrl: url, dateKey, status: "ACCEPTING" });
      } else if (verdict === "CHILD_ONLY" && INCLUDE_CHILD) {
        childOnly.push(url);
        await EmailLog.create({ practiceUrl: url, dateKey, status: "CHILD_ONLY" });
      }
    })
  ));

  if ((accepting.length || childOnly.length) && recipients?.length) {
    const lines = [];
    if (accepting.length)
      lines.push(`<b>Accepting:</b><br>${accepting.map((u) => `<a href="${u}">${u}</a>`).join("<br>")}<br><br>`);
    if (childOnly.length)
      lines.push(`<b>Children only:</b><br>${childOnly.map((u) => `<a href="${u}">${u}</a>`).join("<br>")}`);
    const subject = `DentistRadar — ${postcode}: ${accepting.length} accepting`;
    const body = `<div style="font-family:system-ui">${lines.join("")}<hr>Checked ${dayjs().format("YYYY-MM-DD HH:mm")}</div>`;
    await sendEmail(recipients, subject, body);
  } else {
    console.log("No accepting practices found or no recipients.");
  }

  return { accepting, childOnly };
}

/* ─────────────────────────
   RUNNER
   ───────────────────────── */
async function buildJobs() {
  const rows = await Watch.aggregate([
    { $group: { _id: "$postcode", radius: { $first: "$radius" }, emails: { $addToSet: "$email" } } },
    { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } }
  ]);
  return rows.map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: r.radius || 10,
    recipients: (r.emails || []).filter(validEmail)
  }));
}

export async function runScan(opts = {}) {
  await connectMongo(MONGO_URI);
  const jobs = await buildJobs();
  if (!jobs.length) return { jobs: 0, summaries: [] };

  const summaries = [];
  for (const job of jobs) {
    const res = await scanJob(job);
    summaries.push({
      postcode: job.postcode,
      radiusMiles: job.radiusMiles,
      accepting: res.accepting.length,
      childOnly: res.childOnly.length
    });
  }
  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

if (import.meta.url === `file://${process.argv[1]}`) {
  runScan().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
