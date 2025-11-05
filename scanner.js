/**
 * DentistRadar — scanner.js (Playwright network-sniff discovery) — v3.9
 * - Uses path-style and interactive search.
 * - Grabs dentist detail URLs from both DOM and XHR/JSON responses.
 * - Loads Appointments page and classifies acceptance.
 * - Sends Postmark emails; per-day dedupe via EmailLog.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import mongoose from "mongoose";
import pLimit from "p-limit";
import dayjs from "dayjs";
import { chromium } from "playwright";
import { execSync } from "node:child_process";

/* ── ENV ─────────────────────────────────────────────────────────────── */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = "outbound",
  MAX_CONCURRENCY = "6",
  INCLUDE_CHILD_ONLY = "false",
  HEADLESS = "true",
  PW_SLOWMO = "0",
  DISCOVERY_DEBUG = "0"
} = process.env;

if (!MONGO_URI) throw new Error("MONGO_URI is required");
if (!POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN is required");
if (!EMAIL_FROM) throw new Error("EMAIL_FROM is required");

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 6);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === "true";
const DEBUG_DISC = String(DISCOVERY_DEBUG) === "1";

/* ── Mongo models ────────────────────────────────────────────────────── */
function getModel(name, schema) {
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

const Watch = getModel("Watch", WatchSchema);
const EmailLog = getModel("EmailLog", EmailLogSchema);

async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { maxPoolSize: 10 });
  console.log("✅ MongoDB connected");
}

/* ── Playwright self-heal ────────────────────────────────────────────── */
async function ensureChromiumInstalled() {
  try {
    const probe = await chromium.launch({ headless: true });
    await probe.close();
  } catch (e) {
    const msg = String(e?.message || "");
    if (/Executable doesn't exist|Looks like Playwright/i.test(msg)) {
      console.log("[PW] Installing Chromium …");
      execSync("npx playwright install chromium", { stdio: "inherit" });
      return;
    }
    throw e;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
const normText = (s) => String(s || "").replace(/\s+/g, " ").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
const normPc = (pc) => String(pc || "").toUpperCase().replace(/\s+/g, " ").trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

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

/* ── NHS discovery (network-sniff + DOM) ─────────────────────────────── */
async function acceptCookiesIfShown(page) {
  const sels = [
    '#nhsuk-cookie-banner__link_accept',
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

async function collectDetailLinksFromDom(page) {
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

function addFromText(all, text) {
  if (!text) return;
  const re = /https:\/\/www\.nhs\.uk\/services\/dentists\/[^\s"'<)]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const url = m[0].split("#")[0];
    if (!/\/appointments(\b|\/|\?|#)/i.test(url)) all.add(url);
  }
}

async function tryPathResults(page, postcode, radius) {
  const enc = encodeURIComponent(postcode);
  const r = Math.max(1, Math.min(30, Math.round(radius)));
  const bases = [
    `https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}`,
    `https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}&results=24`
  ];
  const urls = new Set();

  for (const base of bases) {
    for (let p = 1; p <= 4; p++) {
      const url = p === 1 ? base : `${base}&page=${p}`;

      // network sniffer for this navigation
      const handler = page.on("response", async (resp) => {
        try {
          const ctype = (resp.headers()["content-type"] || "").toLowerCase();
          if (!/json|html|text/.test(ctype)) return;
          const body = await resp.text().catch(() => "");
          addFromText(urls, body);
        } catch {}
      });

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await acceptCookiesIfShown(page);
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(900);
        // DOM fallback
        const domLinks = await collectDetailLinksFromDom(page);
        domLinks.forEach((u) => urls.add(u));
        if (urls.size) {
          page.off("response", handler);
          return Array.from(urls);
        }
      } catch {
        // ignore and continue
      }
      page.off("response", handler);
    }
  }
  return Array.from(urls);
}

async function findSearchInput(page) {
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
  for (const fn of probes) {
    const loc = fn();
    try {
      if ((await loc.count()) > 0) return loc.first();
    } catch {}
  }
  return null;
}

async function setRadiusIfPossible(page, radius) {
  const r = Math.max(1, Math.min(30, Math.round(radius)));
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
      await page.waitForTimeout(100);
      return true;
    }
  }
  return false;
}

async function clickSubmit(page, input) {
  const sels = [
    () => page.getByRole("button", { name: /search/i }),
    () => page.locator('button[type="submit"]'),
    () => page.locator('input[type="submit"]')
  ];
  for (const fn of sels) {
    const b = fn();
    if ((await b.count()) > 0) { await b.first().click().catch(() => {}); return; }
  }
  await input.press("Enter").catch(() => {});
}

async function performInteractiveSearch(page, postcode, radius) {
  const urls = new Set();

  // Attach network sniffer before navigating
  const handler = page.on("response", async (resp) => {
    try {
      const ctype = (resp.headers()["content-type"] || "").toLowerCase();
      if (!/json|html|text/.test(ctype)) return;
      const body = await resp.text().catch(() => "");
      addFromText(urls, body);
    } catch {}
  });

  await page.goto("https://www.nhs.uk/service-search/find-a-dentist", {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });

  await acceptCookiesIfShown(page);

  const input = await findSearchInput(page);
  if (input) {
    await input.fill("");
    await input.type(postcode, { delay: 25 }).catch(() => {});
  }

  await setRadiusIfPossible(page, radius);
  await clickSubmit(page, input || page.locator("body"));

  await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // DOM fallback
  const domLinks = await collectDetailLinksFromDom(page);
  domLinks.forEach((u) => urls.add(u));

  // Try to enforce distance via path-style results if we still have none
  if (urls.size === 0) {
    const enc = encodeURIComponent(postcode);
    const r = Math.max(1, Math.min(30, Math.round(radius)));
    const enforce = `https://www.nhs.uk/service-search/find-a-dentist/results/${enc}?distance=${r}`;
    try {
      await page.goto(enforce, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(900);
      const moreDom = await collectDetailLinksFromDom(page);
      moreDom.forEach((u) => urls.add(u));
    } catch {}
  }

  page.off("response", handler);
  return Array.from(urls);
}

async function discoverDetailUrlsWithPlaywright(postcode, radiusMiles) {
  await ensureChromiumInstalled();

  const browser = await chromium.launch({
    headless: String(HEADLESS).toLowerCase() !== "false",
    slowMo: Number(PW_SLOWMO) || 0,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-GB",
    viewport: { width: 1366, height: 900 },
    timezoneId: "Europe/London"
  });
  const page = await context.newPage();

  const urls = new Set();
  try {
    // 1) Fast path
    const quick = await tryPathResults(page, postcode, radiusMiles);
    quick.forEach((u) => urls.add(u));

    // 2) Interactive fallback
    if (urls.size === 0) {
      const interactive = await performInteractiveSearch(page, postcode, radiusMiles);
      interactive.forEach((u) => urls.add(u));

      // "Next" pagination if present
      for (let i = 0; i < 8; i++) {
        const next = page.locator('a[rel="next"], a[aria-label="Next"], a:has-text("Next")').first();
        if ((await next.count()) === 0) break;
        const prev = urls.size;

        // sniff during next page too
        const handler = page.on("response", async (resp) => {
          try {
            const ctype = (resp.headers()["content-type"] || "").toLowerCase();
            if (!/json|html|text/.test(ctype)) return;
            const body = await resp.text().catch(() => "");
            addFromText(urls, body);
          } catch {}
        });

        await next.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(800);
        const dom = await collectDetailLinksFromDom(page);
        dom.forEach((u) => urls.add(u));

        page.off("response", handler);
        if (urls.size === prev) break;
      }
    }
  } catch (e) {
    console.log("[DISCOVERY ERROR]", e?.message || e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`[DISCOVERY] Playwright collected ${urls.size} detail URL(s).`);
  if (DEBUG_DISC) console.log("[DISCOVERY] Sample URLs:", Array.from(urls).slice(0, 5));
  return Array.from(urls);
}

/* ── Appointments fetch + parse ──────────────────────────────────────── */
async function loadAppointmentsHtml(detailUrl) {
  const html = await httpGet(detailUrl);
  if (!html) return null;
  const $ = cheerio.load(html);
  const link =
    $('a[href*="/appointments"]').attr("href") ||
    $('a:contains("Appointments")').attr("href") ||
    $('a:contains("appointments")').attr("href");
  if (!link) return html;
  const full = new URL(link, detailUrl).href;
  return (await httpGet(full)) || html;
}

function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const candidates = [];
  $("h1,h2,h3").each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(), hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (["p","div","li","ul","ol"].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next(); hops++;
      }
      const joined = section.join(" ").trim();
      if (joined) candidates.push(joined);
    }
  });
  if (!candidates.length) candidates.push(normText($.root().text()));
  candidates.sort((a,b)=> b.length - a.length);
  return candidates[0] || "";
}

function classifyAcceptance(text) {
  const t = normText(text).toLowerCase();
  const childOnly = (t.includes("only accepts") || t.includes("currently only accepts") || t.includes("accepting only"))
    && (t.includes("children aged 17 or under") || t.includes("children only") || /under\s*18/.test(t));
  const accepting = t.includes("this dentist currently accepts new nhs patients") ||
    ((t.includes("accepts") || t.includes("are accepting") || t.includes("is accepting") || t.includes("currently accepting"))
      && t.includes("nhs patients") && !childOnly);
  if (childOnly) return "CHILD_ONLY";
  if (accepting) return "ACCEPTING";
  return "NONE";
}

/* ── Email (Postmark) ───────────────────────────────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post(
      "https://api.postmarkapp.com/email",
      { From: EMAIL_FROM, To: toList.join(","), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN, "Content-Type": "application/json" }, timeout: 10000 }
    );
    console.log("📧 Email sent:", subject);
  } catch (e) {
    console.log("Postmark error:", e?.response?.data || e.message);
  }
}

/* ── Scan one job ───────────────────────────────────────────────────── */
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

  await Promise.all(detailUrls.map((url) => limit(async () => {
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
  })));

  if ((accepting.length || childOnly.length) && recipients?.length) {
    const lines = [];
    if (accepting.length) lines.push(`<b>Accepting:</b><br>${accepting.map(u=>`<a href="${u}">${u}</a>`).join("<br>")}<br><br>`);
    if (childOnly.length) lines.push(`<b>Children-only:</b><br>${childOnly.map(u=>`<a href="${u}">${u}</a>`).join("<br>")}`);
    const subject = `DentistRadar — ${postcode} (${radiusMiles} mi): ${accepting.length} accepting${INCLUDE_CHILD ? `, ${childOnly.length} child-only` : ""}`;
    const body = `<div style="font-family:system-ui">${lines.join("")}<hr>Checked ${dayjs().format("YYYY-MM-DD HH:mm")}</div>`;
    await sendEmail(recipients, subject, body);
  } else {
    console.log("No accepting practices found or no recipients.");
  }

  return { accepting, childOnly };
}

/* ── Runner ─────────────────────────────────────────────────────────── */
async function buildJobs() {
  const rows = await Watch.aggregate([
    { $group: { _id: "$postcode", radius: { $first: "$radius" }, emails: { $addToSet: "$email" } } },
    { $project: { _id: 0, postcode: "$_id", radius: 1, emails: 1 } }
  ]);
  return rows.map((r) => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, r.radius || 10)),
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
    await sleep(150);
  }
  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}
export default { runScan };

if (import.meta.url === `file://${process.argv[1]}`) {
  runScan().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
