#!/usr/bin/env node
/**
 * DentistRadar scanner.cjs — v1.9.2-compatible (CommonJS)
 * Keeps the same public API and metrics as your v1.9.2 build:
 *   - exports: runScan, scanPostcode, scanWithSweep, parseListing, extractPractice, buildSearchUrl
 *   - returns: patternsHit, detailHits, acceptHits, practices[]
 *
 * Under the hood improvements:
 *   - Two-hop scan (listing -> profile detail) to find acceptance reliably
 *   - Ensemble classifier (hard/soft positive/negative phrases)
 *   - Retry/backoff, null-guards, polite pacing
 */

const cheerio = require('cheerio');
const pRetry = require('p-retry');
const PQueue = require('p-queue').default;
const dayjs = require('dayjs');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/* --------------------- Config (simple & stable) --------------------- */
const ORIGIN = 'https://www.nhs.uk';
const SEARCH_PATH = '/service-search/find-a-dentist/results';
const MAX_PAGES = 6;

const TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;
const CONCURRENCY = 3;
const PAGE_SLEEP_MS = 250;
const DETAIL_SLEEP_MS = 120;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36';

// If primary postcode has no accept hits, try a couple dense anchors to increase odds
const ANCHOR_POSTCODES = ['B1 1TB', 'M1 1AE', 'L1 8JQ', 'BS1 4ST', 'NE1 4LP', 'CF10 1EP'];

/* ------------------- Acceptance phrase sets (simple) ---------------- */
const HARD_POS = [
  'accepting new nhs patients',
  'taking new nhs patients',
  'currently accepting nhs patients',
  'now accepting nhs patients'
];
const SOFT_POS = [
  'accepting nhs patients',
  'limited nhs spaces',
  'accepting adults and children',
  'accepting children and adults',
  'nhs registrations open'
];
const HARD_NEG = [
  'not accepting nhs patients',
  'no longer accepting nhs patients',
  'not currently accepting nhs patients',
  'nhs closed',
  'nhs registrations closed',
  'waiting list only'
];
const SOFT_NEG = [
  'not accepting new patients',
  'temporarily not accepting',
  'private patients only',
  'accepting children nhs only'
];

/* --------------------------- Small helpers ------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => dayjs().toISOString();
const norm = (s) => String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
const includesAny = (hay, arr) => {
  const h = norm(hay);
  return arr.some((x) => h.includes(norm(x)));
};
const safeText = ($, el) => (el ? norm($(el).text()) : '');

/* --------------------- Network (retry + timeout) -------------------- */
async function fetchHtml(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: controller.signal
  }).catch((e) => {
    clearTimeout(id);
    throw e;
  });

  clearTimeout(id);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} on ${url}`);
    err.body = text.slice(0, 5000);
    throw err;
  }
  return res.text();
}

async function getHtmlWithRetry(url) {
  return pRetry(() => fetchHtml(url), {
    retries: MAX_RETRIES,
    factor: 2,
    minTimeout: 450,
    maxTimeout: 2000,
    onFailedAttempt: (e) => {
      console.warn(`[retry] ${e.attemptNumber}/${e.retriesLeft} left – ${url}: ${e.message}`);
    }
  });
}

/* ----------------------- Listing page parsing ----------------------- */
function extractPractice($, card, sourceUrl) {
  const $c = $(card);

  const name = safeText($, $c.find('h2, h3, .org-title, [itemprop="name"]').first());
  const address = norm($c.find('.address, [itemprop="address"], address').first().text() || '');
  const phone = norm($c.find('a[href^="tel:"], .tel, .phone, [itemprop="telephone"]').first().text() || '');
  const distance = norm($c.find('.distance, .nhsuk-u-margin-top-2').first().text() || '');

  // Some listings show a status hint; we treat it as a weak signal only
  const listStatus =
    safeText($, $c.find('.nhsuk-tag, .status, .acceptance, .nhsuk-hint, .nhsuk-warning-text').first()) ||
    safeText($, $c.find('p, li').first());

  // Try to identify a profile URL (detail page)
  const link = $c
    .find('a')
    .filter((_, a) => {
      const h = norm($(a).attr('href') || '');
      return h.includes('/services/') || h.includes('/profiles/');
    })
    .first();

  let profile_url = link.attr('href') || '';
  if (profile_url && !profile_url.startsWith('http')) profile_url = `${ORIGIN}${profile_url}`;

  // Weak list-only classification
  let accepting = null;
  if (includesAny(listStatus, [...HARD_POS, ...SOFT_POS])) accepting = true;
  else if (includesAny(listStatus, [...HARD_NEG, ...SOFT_NEG])) accepting = false;

  return {
    name,
    address,
    phone,
    distance,
    accepting, // may be overwritten by detail page
    status_text_snippet: listStatus,
    source_url: sourceUrl,
    profile_url: profile_url || null,
    score: 0,
    classified_from: 'list'
  };
}

function parseListing(html, url) {
  const $ = cheerio.load(html);

  const cards = $('.nhsuk-search-results__item, .nhsuk-card, .result, .service').toArray();
  const practices = cards.map((c) => extractPractice($, c, url));

  const nextHref =
    $('a[rel="next"], .nhsuk-pagination__link--next').attr('href') ||
    $('a:contains("Next")').attr('href') ||
    null;

  const nextUrl = nextHref ? (nextHref.startsWith('http') ? nextHref : `${ORIGIN}${nextHref}`) : null;

  // Maintain the v1.9.2 "patternsHit" metric: 1 if expected container present on this page
  const patternsHit = cards.length > 0 ? 1 : 0;

  return { practices, nextUrl, rawCount: cards.length, patternsHit };
}

/* ---------------------- Detail-page classification ------------------ */
function classifyAcceptanceFromHtml(html, url) {
  const $ = cheerio.load(html);

  const body = norm($('body').text() || '');
  const badge = norm($('.nhsuk-tag, .nhsuk-warning-text, .nhsuk-hint, .status, .notice').first().text() || '');

  // Simple ensemble scoring
  let score = 0;
  if (includesAny(badge, HARD_POS) || includesAny(body, HARD_POS)) score += 3;
  if (includesAny(badge, SOFT_POS) || includesAny(body, SOFT_POS)) score += 1;
  if (includesAny(badge, HARD_NEG) || includesAny(body, HARD_NEG)) score -= 3;
  if (includesAny(badge, SOFT_NEG) || includesAny(body, SOFT_NEG)) score -= 1;

  let accepting = null;
  if (score >= 3) accepting = true;
  else if (score <= -2) accepting = false;

  const status_text_snippet = badge || body.slice(0, 220);

  return { score, accepting, status_text_snippet, detail_url: url };
}

async function detailScan(practice) {
  if (!practice.profile_url) return practice;
  try {
    const html = await getHtmlWithRetry(practice.profile_url);
    const c = classifyAcceptanceFromHtml(html, practice.profile_url);

    practice.accepting = c.accepting !== null ? c.accepting : practice.accepting;
    practice.status_text_snippet = c.status_text_snippet || practice.status_text_snippet;
    practice.score = c.score;
    practice.classified_from = 'detail';
  } catch (e) {
    // Keep it quiet but robust; don’t break flow if detail fetch fails
  }
  await sleep(DETAIL_SLEEP_MS);
  return practice;
}

/* ----------------------------- Scan flow ---------------------------- */
function buildSearchUrl(postcode, radiusMiles, page = 1) {
  const params = new URLSearchParams();
  params.set('postcode', postcode);
  params.set('distance', String(radiusMiles));
  params.set('page', String(page));
  return `${ORIGIN}${SEARCH_PATH}?${params.toString()}`;
}

async function scanPostcode(postcode, radiusMiles) {
  const startedAt = nowIso();
  let url = buildSearchUrl(postcode, radiusMiles);
  const all = [];
  let page = 1;
  let visited = 0;
  let patternsHitTotal = 0;

  while (url && page <= MAX_PAGES) {
    const html = await getHtmlWithRetry(url);
    const { practices, nextUrl, rawCount, patternsHit } = parseListing(html, url);
    visited++;
    patternsHitTotal += patternsHit;
    all.push(...practices);

    if (!nextUrl || rawCount === 0) break;
    url = nextUrl;
    page++;
    await sleep(PAGE_SLEEP_MS);
  }

  // Detail page pass (parallel, polite)
  const q = new PQueue({ concurrency: CONCURRENCY });
  await Promise.all(all.map((p) => q.add(() => detailScan(p))));

  const acceptHits = all.filter((p) => p.accepting === true).length;
  const detailHits = all.length;

  return {
    postcode,
    radius_miles: radiusMiles,
    started_at: startedAt,
    finished_at: nowIso(),
    checked_pages: visited,
    patternsHit: patternsHitTotal,  // <- preserved
    detailHits,                     // <- preserved
    acceptHits,                     // <- preserved
    practices: all
  };
}

async function scanWithSweep(primaryPostcode, radiusMiles) {
  const r = await scanPostcode(primaryPostcode, radiusMiles);
  if (r.acceptHits > 0) return { ...r, sweep_used: false };

  for (const pc of ANCHOR_POSTCODES) {
    const rr = await scanPostcode(pc, radiusMiles);
    if (rr.acceptHits > 0) return { ...rr, sweep_used: true, sweep_origin: primaryPostcode };
  }
  return { ...r, sweep_used: true, sweep_origin: primaryPostcode };
}

async function runScan(postcode, radiusMiles = 25, options = { sweep: true }) {
  const sweep = options && typeof options.sweep === 'boolean' ? options.sweep : true;
  return sweep ? scanWithSweep(postcode, radiusMiles) : scanPostcode(postcode, radiusMiles);
}

/* ------------------------------- CLI -------------------------------- */
if (require.main === module) {
  const postcode = process.argv[2] || 'RG41 1YZ';
  const radius = Number(process.argv[3] || 25);

  (async () => {
    try {
      const res = await runScan(postcode, radius, { sweep: true });
      const summary = {
        postcode: res.postcode,
        radius_miles: res.radius_miles,
        checked_pages: res.checked_pages,
        patternsHit: res.patternsHit,
        detailHits: res.detailHits,
        acceptHits: res.acceptHits,
        sample: res.practices.slice(0, 5).map((p) => ({
          name: p.name,
          accepting: p.accepting,
          score: p.score,
          classified_from: p.classified_from,
          profile_url: p.profile_url,
          status_text_snippet: p.status_text_snippet
        }))
      };
      console.log(JSON.stringify(summary, null, 2));
    } catch (err) {
      console.error('[scanner] FAILED', err.message);
      if (err.body) console.error('[body-snippet]', err.body.slice(0, 500));
      process.exit(1);
    }
  })();
}

/* ------------------------------ Exports ----------------------------- */
module.exports = {
  runScan,
  scanPostcode,
  scanWithSweep,
  parseListing,
  extractPractice,
  buildSearchUrl
};
