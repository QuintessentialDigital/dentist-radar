#!/usr/bin/env node
/**
 * scanner.cjs – v1.9.2+
 * Backward-compatible with your baseline, plus detail-page classification.
 *
 * New features:
 *  - Two-hop scan (listing -> detail page)
 *  - Ensemble classifier with strong/soft pos/neg signals
 *  - Optional temporal reconfirm to avoid flukes
 *  - Evidence capture per practice (score, matched phrases, snippets)
 *  - DOM drift safeguards + null guards everywhere
 *
 * CLI: node scanner.cjs "RG41 1YZ" 25
 */

const cheerio = require('cheerio');
const pRetry = require('p-retry');
const PQueue = require('p-queue').default;
const dayjs = require('dayjs');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ===== CONFIG (tweak without redeploy via env) =====
const ORIGIN = process.env.DR_ORIGIN || 'https://www.nhs.uk';
const SEARCH_PATH = process.env.DR_SEARCH_PATH || '/service-search/find-a-dentist/results';

const TIMEOUT_MS = Number(process.env.DR_TIMEOUT_MS || 12000);
const MAX_RETRIES = Number(process.env.DR_MAX_RETRIES || 3);
const CONCURRENCY = Number(process.env.DR_CONCURRENCY || 3);
const PAGE_SLEEP_MS = Number(process.env.DR_PAGE_SLEEP_MS || 250);
const DETAIL_SLEEP_MS = Number(process.env.DR_DETAIL_SLEEP_MS || 150);

const ENABLE_DETAIL_SCAN = String(process.env.DR_DETAIL_SCAN || 'true') === 'true';     // <- NEW
const ENABLE_RECONFIRM = String(process.env.DR_RECONFIRM || 'false') === 'true';        // <- NEW
const RECONFIRM_TRIES = Number(process.env.DR_RECONFIRM_TRIES || 2);
const RECONFIRM_GAP_MS = Number(process.env.DR_RECONFIRM_GAP_MS || 300000); // 5 min

const USER_AGENT =
  process.env.DR_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36';

// When primary area yields no accept hits, sweep dense anchors to raise odds
const ANCHOR_POSTCODES = (process.env.DR_ANCHOR_POSTCODES || 'B1 1TB,M1 1AE,L1 8JQ,BS1 4ST,NE1 4LP,CF10 1EP')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ===== PHRASE TABLES (extend online later if you want) =====
const HARD_POS = [
  'accepting new nhs patients',
  'taking new nhs patients',
  'currently accepting nhs patients',
  'now accepting nhs patients'
];
const SOFT_POS = [
  'accepting nhs patients',
  'accepting adults and children',
  'accepting children and adults',
  'limited nhs spaces',
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

// ===== UTILS =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => dayjs().toISOString();

function norm(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function includesAny(hay, arr) {
  const h = norm(hay);
  return arr.some((x) => h.includes(norm(x)));
}
function safeText($, el) {
  if (!el) return '';
  return norm($(el).text());
}
function pickAttr($el, attrs = []) {
  for (const a of attrs) {
    const v = $el.attr(a);
    if (v) return v;
  }
  return '';
}

// ===== FETCH with retry/backoff + timeout =====
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
    const error = new Error(`HTTP ${res.status} on ${url}`);
    error.body = text.slice(0, 5000);
    throw error;
  }
  return res.text();
}

async function getHtmlWithRetry(url) {
  return pRetry(() => fetchHtml(url), {
    retries: MAX_RETRIES,
    factor: 2,
    minTimeout: 500,
    maxTimeout: 2200,
    onFailedAttempt: (err) => {
      console.warn(`[retry] attempt ${err.attemptNumber} (${err.retriesLeft} left) – ${url}: ${err.message}`);
    }
  });
}

// ===== LISTING PARSE (unchanged + tolerant) =====
function extractPractice($, card, sourceUrl) {
  const $card = $(card);
  const name =
    safeText($, $card.find('h2, h3, .org-title, [itemprop="name"]').first());

  const address = norm(
    $card.find('.address, [itemprop="address"], address').first().text() || ''
  );

  const phone = norm(
    $card.find('a[href^="tel:"], .tel, .phone, [itemprop="telephone"]').first().text() || ''
  );

  const distance = norm($card.find('.distance, .nhsuk-u-margin-top-2').first().text() || '');

  // List status hint (often unreliable; we still record it as a clue)
  const statusText =
    safeText($, $card.find('.nhsuk-tag, .status, .acceptance, .nhsuk-hint, .nhsuk-warning-text').first()) ||
    safeText($, $card.find('.content, p, li').first());

  // Try to find a profile link
  const linkEl = $card.find('a').filter((_, a) => {
    const href = norm($(a).attr('href') || '');
    return href && (href.includes('/services/dentist/') || href.includes('/profiles/') || href.includes('/services/'));
  }).first();

  let profile_url = linkEl.attr('href') || '';
  if (profile_url && !profile_url.startsWith('http')) {
    profile_url = `${ORIGIN}${profile_url}`;
  }

  // Listing-only acceptance (weak)
  let accepting = null;
  if (includesAny(statusText, HARD_POS) || includesAny(statusText, SOFT_POS)) accepting = true;
  else if (includesAny(statusText, HARD_NEG) || includesAny(statusText, SOFT_NEG)) accepting = false;

  return {
    name,
    address,
    phone,
    distance,
    accepting, // preliminary from list
    status_text_snippet: statusText,
    source_url: sourceUrl,
    profile_url: profile_url || null,
    evidence: [],     // filled after detail scan
    score: 0,         // filled after detail scan
    classified_from: 'list' // updated later to 'detail' if detail page used
  };
}

function parseListing(html, url) {
  const $ = cheerio.load(html);
  const cards = $('.nhsuk-search-results__item, .nhsuk-card, .result, .service').toArray() || [];

  const practices = cards.map((c) => extractPractice($, c, url)).filter(Boolean);

  const nextHref =
    $('a[rel="next"], .nhsuk-pagination__link--next').attr('href') ||
    $('a:contains("Next")').attr('href') ||
    null;

  const nextUrl = nextHref ? (nextHref.startsWith('http') ? nextHref : `${ORIGIN}${nextHref}`) : null;

  // patternsHit: 1 if expected container present
  const patternsHit = cards.length > 0 ? 1 : 0;

  return { practices, nextUrl, rawCount: cards.length, patternsHit };
}

// ===== DETAIL PAGE CLASSIFICATION =====
function extractJsonLd($) {
  // Try to parse any JSON-LD blocks for structured hints
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).text();
    if (!txt) return;
    try {
      const obj = JSON.parse(txt);
      blocks.push(obj);
    } catch (_) {}
  });
  return blocks;
}

// Return { score, accepting, evidence[], status_text_snippet }
function classifyAcceptanceFromHtml(html, url) {
  const $ = cheerio.load(html);
  const bodyText = norm($('body').text() || '');
  let score = 0;
  const evidence = [];

  // Look for obvious badges/labels near "NHS"
  const badge =
    $('.nhsuk-tag, .nhsuk-warning-text, .nhsuk-hint, .status, .notice').first().text() || '';
  const badgeN = norm(badge);

  // JSON-LD inspection (org description sometimes hints at NHS status)
  const jsonLd = extractJsonLd($);
  const ldText = norm(JSON.stringify(jsonLd));

  // Hard positives
  if (includesAny(badgeN, HARD_POS)) { score += 3; evidence.push({ type: 'hard_pos_badge', text: badgeN }); }
  if (includesAny(bodyText, HARD_POS)) { score += 3; evidence.push({ type: 'hard_pos_text', text: '…' }); }
  if (includesAny(ldText, HARD_POS)) { score += 2; evidence.push({ type: 'hard_pos_jsonld', text: 'jsonld' }); }

  // Soft positives
  if (includesAny(badgeN, SOFT_POS)) { score += 1; evidence.push({ type: 'soft_pos_badge', text: badgeN }); }
  if (includesAny(bodyText, SOFT_POS)) { score += 1; evidence.push({ type: 'soft_pos_text', text: '…' }); }
  if (includesAny(ldText, SOFT_POS)) { score += 1; evidence.push({ type: 'soft_pos_jsonld', text: 'jsonld' }); }

  // Hard negatives
  if (includesAny(badgeN, HARD_NEG)) { score -= 3; evidence.push({ type: 'hard_neg_badge', text: badgeN }); }
  if (includesAny(bodyText, HARD_NEG)) { score -= 3; evidence.push({ type: 'hard_neg_text', text: '…' }); }
  if (includesAny(ldText, HARD_NEG)) { score -= 2; evidence.push({ type: 'hard_neg_jsonld', text: 'jsonld' }); }

  // Soft negatives
  if (includesAny(badgeN, SOFT_NEG)) { score -= 1; evidence.push({ type: 'soft_neg_badge', text: badgeN }); }
  if (includesAny(bodyText, SOFT_NEG)) { score -= 1; evidence.push({ type: 'soft_neg_text', text: '…' }); }
  if (includesAny(ldText, SOFT_NEG)) { score -= 1; evidence.push({ type: 'soft_neg_jsonld', text: 'jsonld' }); }

  // Status snippet for UI/debug (prefer badge text; fallback short slice of body)
  let status_text_snippet = badgeN;
  if (!status_text_snippet) {
    status_text_snippet = bodyText.slice(0, 220);
  }

  let accepting = null;
  if (score >= 3) accepting = true;
  else if (score <= -2) accepting = false;

  return { score, accepting, evidence, status_text_snippet, detail_url: url };
}

async function detailScanPractice(practice) {
  if (!practice.profile_url) return practice;

  try {
    const html = await getHtmlWithRetry(practice.profile_url);
    const cls = classifyAcceptanceFromHtml(html, practice.profile_url);

    // Update fields from detail page
    practice.accepting = (cls.accepting !== null ? cls.accepting : practice.accepting);
    practice.status_text_snippet = cls.status_text_snippet || practice.status_text_snippet;
    practice.evidence = cls.evidence;
    practice.score = cls.score;
    practice.classified_from = 'detail';

    // Reconfirm (optional)
    if (ENABLE_RECONFIRM && cls.accepting === true) {
      let confirmations = 1;
      for (let i = 0; i < RECONFIRM_TRIES; i++) {
        await sleep(RECONFIRM_GAP_MS);
        const html2 = await getHtmlWithRetry(practice.profile_url);
        const cls2 = classifyAcceptanceFromHtml(html2, practice.profile_url);
        if (cls2.accepting === true) confirmations++;
      }
      practice.evidence.push({ type: 'reconfirm_count', value: confirmations });
      if (confirmations < 2) {
        // Downgrade to "unclear" if reconfirmation failed
        practice.accepting = null;
      }
    }
  } catch (e) {
    practice.evidence = practice.evidence || [];
    practice.evidence.push({ type: 'detail_error', message: e.message || 'detail fetch failed' });
  }

  await sleep(DETAIL_SLEEP_MS);
  return practice;
}

// ===== SEARCH FLOW (list → optional detail) =====
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

  while (url && page <= 6) {
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

  // Detail pass (parallel limited by CONCURRENCY)
  if (ENABLE_DETAIL_SCAN) {
    const q = new PQueue({ concurrency: CONCURRENCY });
    const mapped = await Promise.all(all.map((p) => q.add(() => detailScanPractice(p))));
    mapped.forEach((m, i) => (all[i] = m));
  }

  const acceptHits = all.filter((p) => p.accepting === true).length;
  const detailHits = all.length;

  return {
    postcode,
    radius_miles: radiusMiles,
    started_at: startedAt,
    finished_at: nowIso(),
    checked_pages: visited,
    found: detailHits > 0 ? 1 : 0,
    patternsHit: patternsHitTotal,     // <- kept for your baseline metric
    detailHits,
    acceptHits,
    practices: all
  };
}

async function scanWithSweep(primaryPostcode, radiusMiles) {
  const first = await scanPostcode(primaryPostcode, radiusMiles);
  if (first.acceptHits > 0) return { ...first, sweep_used: false };

  for (const p of ANCHOR_POSTCODES) {
    const r = await scanPostcode(p, radiusMiles);
    if (r.acceptHits > 0) {
      return { ...r, sweep_used: true, sweep_origin: primaryPostcode };
    }
  }
  return { ...first, sweep_used: true, sweep_origin: primaryPostcode };
}

/**
 * Public entry – preserved signature
 * runScan(postcode, radiusMiles=25, { sweep: true|false })
 */
async function runScan(postcode, radiusMiles = 25, options = { sweep: true }) {
  const sweep = (options && typeof options.sweep === 'boolean') ? options.sweep : true;
  return sweep ? scanWithSweep(postcode, radiusMiles) : scanPostcode(postcode, radiusMiles);
}

// ===== CLI =====
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
        sweep_used: !!res.sweep_used,
        sweep_origin: res.sweep_origin || null,
        sample: res.practices.slice(0, 5).map(p => ({
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
      console.error('[scanner] FAILED:', err.message);
      if (err.body) console.error('[body-snippet]', err.body.slice(0, 500));
      process.exit(1);
    }
  })();
}

// ===== EXPORTS (CommonJS) – unchanged names =====
module.exports = {
  runScan,
  scanPostcode,
  scanWithSweep,
  parseListing,
  extractPractice,
  buildSearchUrl
};
