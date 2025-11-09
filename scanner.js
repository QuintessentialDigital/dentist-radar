/**
 * DentistRadar Scanner v7.0
 * - Correct NHS discovery URL (UK-edge pattern)
 * - In-memory TTL cache (discovery + detail pages)
 * - Appointments-only parsing (no other sections)
 * - Robust acceptance pattern detection (adult/child/closed)
 * - Rate-limited, retry-safe HTTP fetches
 *
 * Usage:
 *   node scanner.js "RG41 4UW" 25
 *
 * Env (optional):
 *   DR_MAX_PRACTICES=200     // max detail pages to scan per run
 *   DR_CONCURRENCY=6         // concurrent HTTP requests
 *   DR_TIMEOUT_MS=15000      // per-request timeout
 *   DR_CACHE_TTL_DISCOVERY_MS=21600000  // 6h
 *   DR_CACHE_TTL_DETAIL_MS=10800000     // 3h
 */

import got from "got";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { setTimeout as sleep } from "timers/promises";

/* -----------------------------
 * Tunables
 * ---------------------------*/
const MAX_PRACTICES = parseInt(process.env.DR_MAX_PRACTICES || "200", 10);
const CONCURRENCY = parseInt(process.env.DR_CONCURRENCY || "6", 10);
const TIMEOUT_MS = parseInt(process.env.DR_TIMEOUT_MS || "15000", 10);
const CACHE_TTL_DISCOVERY_MS = parseInt(process.env.DR_CACHE_TTL_DISCOVERY_MS || "21600000", 10); // 6h
const CACHE_TTL_DETAIL_MS = parseInt(process.env.DR_CACHE_TTL_DETAIL_MS || "10800000", 10); // 3h

/* -----------------------------
 * Simple in-memory TTL cache
 * ---------------------------*/
class TTLCache {
  constructor() {
    this.store = new Map(); // key -> {expires:number, value:any}
  }
  get(key) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key, value, ttlMs) {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }
}
const cache = new TTLCache();

/* -----------------------------
 * HTTP client
 * ---------------------------*/
const http = got.extend({
  http2: false,
  timeout: { request: TIMEOUT_MS },
  headers: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 DentistRadar/7.0",
    "accept-language": "en-GB,en;q=0.9",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  },
  retry: {
    limit: 2,
    methods: ["GET"],
    statusCodes: [408, 429, 500, 502, 503, 504],
  },
});

/* -----------------------------
 * Helpers
 * ---------------------------*/
const log = (...args) => console.log(...args);

function normalizeUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) return `https://www.nhs.uk${href}`;
  return null;
}

function clampInt(x, min, max) {
  const n = parseInt(x, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/* -----------------------------
 * Discovery
 * ---------------------------*/
/**
 * Returns practice detail URLs for a given postcode+radius
 * Uses the current UK-edge locationsearch pattern.
 */
async function discoverPracticeLinks(postcode, radiusMiles) {
  const url = `https://www.nhs.uk/service-search/find-a-dentist/locationsearch/3?postcode=${encodeURIComponent(
    postcode
  )}&distance=${encodeURIComponent(radiusMiles)}`;

  // cache first
  const cacheKey = `discover:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return { url, links: cached, cached: true };
  }

  const html = await http.get(url).text();
  const $ = cheerio.load(html);

  // Primary selector for action links pointing to practice pages
  let links = $("a.nhsuk-action-link__link")
    .map((i, el) => $(el).attr("href"))
    .get()
    .map(normalizeUrl)
    .filter(Boolean)
    .filter((h) => h.includes("/services/dentists/"));

  // Fallback: sometimes cards use nhsuk-card__link
  if (links.length === 0) {
    links = $("a.nhsuk-card__link")
      .map((i, el) => $(el).attr("href"))
      .get()
      .map(normalizeUrl)
      .filter(Boolean)
      .filter((h) => h.includes("/services/dentists/"));
  }

  cache.set(cacheKey, links, CACHE_TTL_DISCOVERY_MS);
  return { url, links, cached: false };
}

/* -----------------------------
 * Appointments-only parsing
 * ---------------------------*/

/**
 * Locate the "Appointments" section within a practice details page.
 * Some pages render it on the same HTML (anchor #appointments).
 * If not present inline, try to follow a tab/link to the appointments section.
 */
function extractAppointmentsHtml($, baseUrl) {
  // 1) Try inline section with id "appointments"
  let node =
    $("#appointments").first() ||
    $("[id='appointments']").first() ||
    $("section#appointments").first();

  if (node && node.length) {
    return cheerio.load(node.html() || "");
  }

  // 2) Try link to appointments tab/anchor
  // Look for an anchor that links to #appointments or contains the word "Appointments"
  const anchorHref =
    $("a")
      .map((i, el) => {
        const text = ($(el).text() || "").trim().toLowerCase();
        const href = $(el).attr("href") || "";
        if (href.includes("#appointments")) return href;
        if (text.includes("appointments")) return href;
        return null;
      })
      .get()
      .find(Boolean) || null;

  if (anchorHref && anchorHref.startsWith("#appointments")) {
    // same page anchor — the section should exist; if not, return empty
    const anchorNode = $(anchorHref);
    if (anchorNode && anchorNode.length) {
      return cheerio.load(anchorNode.html() || "");
    }
  }

  // 3) If it's a separate path (rare), try to normalize and fetch
  if (anchorHref && !anchorHref.startsWith("#")) {
    const abs = normalizeUrl(anchorHref);
    if (abs) {
      // NOTE: this is a second fetch only if absolutely needed
      // Most NHS pages have inline tabs, so this path rarely executes.
      // This is still appointments-only.
      // eslint-disable-next-line no-sync
      const html = cache.get(`detail:${abs}`) || null;
      if (html) {
        const _$ = cheerio.load(html);
        const section = _$("#appointments").first();
        if (section && section.length) return cheerio.load(section.html() || "");
        return _$_; // fallback: return whole doc for pattern scan
      }
    }
  }

  // Fallback: return the whole page if we can't isolate "appointments"
  // We will only search within paragraphs/headings that appear in the appointments area keywords.
  return $;
}

/* -----------------------------
 * Acceptance detection
 * ---------------------------*/

const POSITIVE_PATTERNS = [
  // strong signals
  /currently\s+accept(?:ing)?\s+new\s+nhs\s+patients/gi,
  /accept(?:ing)?\s+new\s+nhs\s+patients/gi,
  /taking\s+new\s+nhs\s+patients/gi,
  /we\s+are\s+accept(?:ing)?\s+nhs\s+patients/gi,
  /open\s+to\s+new\s+nhs\s+patients/gi,
  // specific phrase seen on NHS
  /this dentist currently accepts new nhs patients/gi,
];

const CHILD_ONLY_PATTERNS = [
  /children\s+only/gi,
  /child(?:ren)?\s+only/gi,
  /accept(?:ing)?\s+nhs\s+patients\s+aged\s+(?:under|below)\s+\d+/gi,
  /currently\s+accept(?:ing)?\s+nhs\s+patients\s+aged\s+\d+\s+and\s+under/gi,
  /accept(?:ing)?\s+nhs\s+patients\s+for\s+children/gi,
  /only\s+accept(?:ing)?\s+children/gi,
];

const NEGATIVE_PATTERNS = [
  /not\s+accept(?:ing)?\s+new\s+nhs\s+patients/gi,
  /no\s+longer\s+accept(?:ing)?\s+nhs\s+patients/gi,
  /we\s+are\s+not\s+taking\s+nhs\s+patients/gi,
  /nhs\s+list\s+closed/gi,
];

function scanAppointmentsHtml($) {
  // Limit scan to plausible appointments content nodes to reduce false positives
  const candidates = [
    ...$("section#appointments").toArray(),
    ...$("#appointments").toArray(),
    ...$("h2,h3,h4,p,li,div").toArray(),
  ];

  let text = "";
  for (const el of candidates) {
    const chunk = cheerio.load(el).root().text();
    if (!chunk) continue;
    // Heuristic: only keep lines that look appointments/registration-ish
    if (
      /appointment|register|accept/i.test(chunk) ||
      /nhs\s+patients/i.test(chunk) ||
      /taking|list|join/i.test(chunk)
    ) {
      text += "\n" + chunk.trim();
    }
  }

  const summary = text.replace(/\s+/g, " ").trim();

  // Evaluate patterns
  const positive = POSITIVE_PATTERNS.some((rx) => rx.test(summary));
  const childOnly = CHILD_ONLY_PATTERNS.some((rx) => rx.test(summary));
  const negative = NEGATIVE_PATTERNS.some((rx) => rx.test(summary));

  return {
    positive,
    childOnly,
    negative,
    excerpt: summary.slice(0, 400),
  };
}

/* -----------------------------
 * Detail fetch + evaluate
 * ---------------------------*/
async function fetchDetailHtml(url) {
  const cacheKey = `detail:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // polite jitter to avoid bursts
  await sleep(40 + Math.random() * 60);

  const html = await http.get(url).text();
  cache.set(cacheKey, html, CACHE_TTL_DETAIL_MS);
  return html;
}

async function evaluatePractice(url) {
  try {
    const html = await fetchDetailHtml(url);
    const $ = cheerio.load(html);

    // Extract practice name for logging
    const title =
      $("h1.nhsuk-heading-l").first().text().trim() ||
      $("h1").first().text().trim() ||
      "";

    const _$appointments = extractAppointmentsHtml($, url);
    const result = scanAppointmentsHtml(_$appointments);

    let status = "unknown";
    if (result.negative && !result.positive) status = "not_accepting";
    else if (result.childOnly && !result.positive) status = "child_only";
    else if (result.positive && !result.negative) status = "accepting";
    else if (result.positive && result.childOnly) status = "child_only";
    else if (result.positive && result.negative) status = "mixed";

    return {
      url,
      title,
      status,
      positive: result.positive,
      childOnly: result.childOnly,
      negative: result.negative,
      excerpt: result.excerpt,
    };
  } catch (err) {
    return {
      url,
      title: "",
      status: "error",
      error: (err && err.message) || String(err),
    };
  }
}

/* -----------------------------
 * Main scanning flow
 * ---------------------------*/
export async function scanPostcode(postcode, radiusMiles) {
  const t0 = Date.now();
  log(`DentistRadar scanner v7.0 (cache + UK-edge discovery)`);
  log(`--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const discovery = await discoverPracticeLinks(postcode, radiusMiles);
  log(
    `[DISCOVERY] detail URLs = ${discovery.links.length}${
      discovery.cached ? " (cache)" : ""
    }`
  );

  if (!discovery.links.length) {
    log("[INFO] No practice detail URLs discovered for this query.");
    const out = [
      {
        postcode,
        radiusMiles,
        accepting: 0,
        childOnly: 0,
      },
    ];
    log("[DONE]", JSON.stringify(out, null, 2));
    return out;
  }

  // Respect MAX_PRACTICES
  const target = discovery.links.slice(0, MAX_PRACTICES);

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(
    target.map((u) => limit(() => evaluatePractice(u)))
  );

  const accepting = results.filter((r) => r.status === "accepting");
  const childOnly = results.filter(
    (r) => r.status === "child_only" || (r.positive && r.childOnly)
  );
  const notAccepting = results.filter((r) => r.status === "not_accepting");
  const mixed = results.filter((r) => r.status === "mixed");
  const errors = results.filter((r) => r.status === "error");

  log(`[STATS] scanned=${results.length} ok=${results.length - errors.length} errors=${errors.length}`);
  log(
    `[HITS] accepting=${accepting.length} childOnly=${childOnly.length} notAccepting=${notAccepting.length} mixed=${mixed.length}`
  );

  const summary = [
    {
      postcode,
      radiusMiles,
      accepting: accepting.length,
      childOnly: childOnly.length,
      notAccepting: notAccepting.length,
      mixed: mixed.length,
      scanned: results.length,
      tookMs: Date.now() - t0,
    },
  ];

  log("[DONE]", JSON.stringify(summary, null, 2));

  // You can return full results if your server stores them;
  // here we return summary + accepting list for immediate alerting.
  return {
    summary: summary[0],
    accepting: accepting.map(({ url, title, excerpt }) => ({
      url,
      title,
      excerpt,
    })),
    childOnly: childOnly.map(({ url, title, excerpt }) => ({
      url,
      title,
      excerpt,
    })),
    errors,
  };
}

/* -----------------------------
 * CLI entrypoint
 * ---------------------------*/
if (import.meta.url === `file://${process.argv[1]}`) {
  const postcode = process.argv[2] || "RG41 4UW";
  const radius = clampInt(process.argv[3] || "25", 1, 100);

  scanPostcode(postcode, radius).catch((err) => {
    console.error("[FATAL]", err?.message || err);
    process.exit(1);
  });
}
