/**
 * DentistRadar Scanner v7.7
 * NHS discovery URL EXACTLY AS USER CONFIRMED:
 *
 *   /results/postcode=RG41%204UW&distance=25
 *
 * Also supports fallback to '?postcode=' if NHS switches back.
 * Compatible with server.js v1.8.7.
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ------------------------------------------------------------------ */
/* CONFIG */
/* ------------------------------------------------------------------ */

const MAX_PRACTICES = int("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = int("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = int("DR_TIMEOUT_MS", 15000);

const CACHE_DISC_MS = int("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_DET_MS  = int("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);

const MAX_PAGES     = int("DR_MAX_DISCOVERY_PAGES", 3);

function int(k, d) {
  const n = parseInt(process.env[k] || d, 10);
  return Number.isNaN(n) ? d : n;
}

/* ------------------------------------------------------------------ */
/* NORMALISATION */
/* ------------------------------------------------------------------ */

function coercePostcode(x) {
  let raw = x;
  if (typeof raw === "object" && raw !== null)
    raw = raw.value ?? raw.postcode ?? JSON.stringify(raw);

  raw = String(raw ?? "").trim();
  if (!raw) return "";

  const up = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const compact = up.replace(/\s+/g, "");

  if (!up.includes(" ") && compact.length >= 5)
    return compact.slice(0, -3) + " " + compact.slice(-3);

  return up;
}

function coerceRadius(x, def = 25) {
  let r = x;
  if (typeof r === "object" && r !== null) r = r.value ?? r.radius;
  r = parseInt(r ?? def, 10);
  if (Number.isNaN(r)) return def;
  return Math.max(1, Math.min(100, r));
}

/* ------------------------------------------------------------------ */
/* TTL CACHE */
/* ------------------------------------------------------------------ */

class TTLCache {
  constructor(){ this.map = new Map(); }
  get(k){
    const h = this.map.get(k);
    if (!h) return;
    if (Date.now() > h.expires) { this.map.delete(k); return; }
    return h.value;
  }
  set(k, v, ttl){ this.map.set(k, { value:v, expires:Date.now()+ttl }); }
}

const cache = new TTLCache();

/* ------------------------------------------------------------------ */
/* FETCH */
/* ------------------------------------------------------------------ */

async function fetchText(url, tries = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 DentistRadar/7.7",
        "accept-language": "en-GB,en;q=0.9",
        "accept": "text/html",
      }
    });

    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    if (tries < 2) {
      await sleep(200);
      return fetchText(url, tries + 1);
    }
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(h) {
  if (!h) return null;
  if (h.startsWith("http")) return h;
  if (h.startsWith("//")) return `https:${h}`;
  if (h.startsWith("/")) return `https://www.nhs.uk${h}`;
  return null;
}

/* ------------------------------------------------------------------ */
/* DISCOVERY URL LOGIC */
/* ------------------------------------------------------------------ */

/**
 * NHS has two possible URL styles:
 *
 * 1) The one YOU CONFIRMED is working live:
 *
 *    /results/postcode=RG41%204UW&distance=25
 *
 * 2) The older / standard:
 *
 *    /results?postcode=RG41%204UW&distance=25
 *
 * We build BOTH and try both.
 */

function buildDiscoveryUrls(pc, radius){
  const base = "https://www.nhs.uk/service-search/find-a-dentist";

  const styleA = `${base}/results/postcode=${encodeURIComponent(pc)}&distance=${encodeURIComponent(radius)}`;
  const styleB = `${base}/results?postcode=${encodeURIComponent(pc)}&distance=${encodeURIComponent(radius)}`;
  const search = `${base}/locationsearch/3?postcode=${encodeURIComponent(pc)}&distance=${encodeURIComponent(radius)}`;

  return [styleA, styleB, search];
}

function injectPage(url, page){
  if (page <= 1) return [url];
  const hasQ = url.includes("?");
  const sep = hasQ ? "&" : "?";
  return [
    `${url}${sep}page=${page}`,
    `${url}${sep}p=${page}`,
  ];
}

function extractPracticeLinks(html){
  if (!html) return [];
  const $ = cheerio.load(html);

  const raw = $('a[href*="/services/dentists/"]')
    .map((_, el) => $(el).attr("href"))
    .get()
    .map(normalizeUrl)
    .filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const u of raw) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

async function discoverPracticeLinks(pc, radius){
  const candidates = buildDiscoveryUrls(pc, radius);
  let all = [];

  for (const base of candidates) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const urls = injectPage(base, page);

      for (const u of urls) {
        console.log(`[DISCOVERY_URL] ${u}`);

        const key = `DISC:${u}`;
        const cached = cache.get(key);
        if (cached) { all = all.concat(cached); continue; }

        const html = await fetchText(u);
        const links = extractPracticeLinks(html);

        cache.set(key, links, CACHE_DISC_MS);

        if (links.length)
          all = all.concat(links);
        else if (page > 1)
          break;
      }
    }
    if (all.length) break;
  }

  return Array.from(new Set(all));
}

/* ------------------------------------------------------------------ */
/* APPOINTMENTS PARSING */
/* ------------------------------------------------------------------ */

function extractAppointmentsHtml($){
  const sec = $("#appointments").first();
  if (sec && sec.length) return cheerio.load(sec.html() || "");

  const anchor = $("a")
    .map((_, el) => $(el).attr("href"))
    .get()
    .find((h) => h && h.includes("#appointments"));

  if (anchor) {
    const node = $(anchor);
    if (node && node.length) return cheerio.load(node.html() || "");
  }

  return $;
}

const POS = [
  /accepting new nhs patients/gi,
  /currently accepts new nhs patients/gi,
  /taking new nhs patients/gi
];

const CHILD = [
  /children only/gi,
  /child only/gi
];

const NEG = [
  /not accepting new nhs patients/gi,
  /list closed/gi,
];

function scanAppointmentsHtml($){
  const nodes = $("p,li,div,h2,h3").toArray();
  let t = "";
  for (const el of nodes) {
    const s = cheerio.load(el).root().text();
    if (!s) continue;
    if (/nhs|accept|register|appointment/i.test(s)) t += " " + s.trim();
  }

  const txt = t.replace(/\s+/g, " ").trim();
  return {
    positive: POS.some((r) => r.test(txt)),
    childOnly: CHILD.some((r) => r.test(txt)),
    negative: NEG.some((r) => r.test(txt)),
    excerpt: txt.slice(0, 400),
  };
}

/* ------------------------------------------------------------------ */
/* DETAIL */
/* ------------------------------------------------------------------ */

async function fetchDetailHtml(url){
  const key = `DET:${url}`;
  const c = cache.get(key);
  if (c) return c;

  await sleep(40 + Math.random() * 60);

  const html = await fetchText(url);
  cache.set(key, html, CACHE_DET_MS);
  return html;
}

async function evaluatePractice(url){
  try {
    const html = await fetchDetailHtml(url);
    if (!html) return { url, status:"error", error:"empty_html" };

    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim();

    const app = extractAppointmentsHtml($);
    const r = scanAppointmentsHtml(app);

    let status = "unknown";
    if (r.negative && !r.positive) status = "not_accepting";
    else if (r.childOnly)         status = "child_only";
    else if (r.positive)          status = "accepting";

    return { url, title, status, excerpt: r.excerpt };
  } catch (e) {
    return { url, status:"error", error: e?.message || String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* CONCURRENCY */
/* ------------------------------------------------------------------ */

async function mapLimit(arr, n, fn){
  const out = new Array(arr.length);
  let i = 0;

  const workers = Array(Math.min(n, arr.length))
    .fill(0)
    .map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= arr.length) return;
        try {
          out[idx] = await fn(arr[idx], idx);
        } catch (e) {
          out[idx] = { status:"error", error:e.message };
        }
      }
    });

  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* MAIN API */
/* ------------------------------------------------------------------ */

export async function scanPostcode(pc, radiusMiles = 25) {
  pc = coercePostcode(pc);
  radiusMiles = coerceRadius(radiusMiles);

  console.log(`DentistRadar v7.7`);
  console.log(`--- Scan: ${pc} (${radiusMiles} miles) ---`);

  if (!pc) {
    return {
      ok: true,
      summary: {
        postcode: "",
        radiusMiles,
        accepting: 0,
        childOnly: 0,
        notAccepting: 0,
        mixed: 0,
        scanned: 0,
        tookMs: 0
      },
      accepting: [],
      childOnly: [],
      errors: []
    };
  }

  const t0 = Date.now();

  const links = await discoverPracticeLinks(pc, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${links.length}`);

  if (!links.length) {
    return {
      ok: true,
      summary: {
        postcode: pc,
        radiusMiles,
        accepting: 0,
        childOnly: 0,
        notAccepting: 0,
        mixed: 0,
        scanned: 0,
        tookMs: Date.now() - t0
      },
      accepting: [],
      childOnly: [],
      errors: []
    };
  }

  const target = links.slice(0, MAX_PRACTICES);
  const results = await mapLimit(target, CONCURRENCY, evaluatePractice);

  const accepting    = results.filter((x) => x.status === "accepting");
  const childOnly    = results.filter((x) => x.status === "child_only");
  const notAccepting = results.filter((x) => x.status === "not_accepting");
  const mixed        = results.filter((x) => x.status === "mixed");
  const errors       = results.filter((x) => x.status === "error");

  const summary = {
    postcode: pc,
    radiusMiles,
    accepting: accepting.length,
    childOnly: childOnly.length,
    notAccepting: notAccepting.length,
    mixed: mixed.length,
    scanned: results.length,
    tookMs: Date.now() - t0
  };

  return {
    ok: true,
    summary,
    accepting: accepting.map(x => ({ url:x.url, title:x.title, excerpt:x.excerpt })),
    childOnly: childOnly.map(x => ({ url:x.url, title:x.title, excerpt:x.excerpt })),
    errors
  };
}

export async function runScan(args) {
  if (typeof args === "string") args = { postcode: args };

  const pc     = coercePostcode(args.postcode);
  const includeChildOnly = !!args.includeChildOnly;
  const radius = coerceRadius(args.radius ?? 25);

  const base = await scanPostcode(pc, radius);

  return {
    ok: true,
    checked: base.summary.scanned,
    found: base.accepting.length + (includeChildOnly ? base.childOnly.length : 0),
    alertsSent: 0,
    summary: base.summary,
    accepting: base.accepting,
    childOnly: includeChildOnly ? base.childOnly : [],
    errors: base.errors
  };
}

export default scanPostcode;

/* ------------------------------------------------------------------ */
/* CLI TEST */
/* ------------------------------------------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`) {
  const pc = coercePostcode(process.argv[2] || "RG41 4UW");
  const radius = coerceRadius(process.argv[3] || 25);

  runScan({ postcode: pc, radius, includeChildOnly:true })
    .then(r => console.log(JSON.stringify(r.summary, null, 2)))
    .catch(err => console.error(err));
}
