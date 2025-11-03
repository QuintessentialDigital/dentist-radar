// scanner.js  (ESM)
// ---------------------------------------------
// Robust NHS dentist scanner with:
// - retry/backoff + timeout
// - tolerant HTML parsing (multiple selectors)
// - guarded string ops (no undefined.includes() errors)
// - acceptance inference via phrase patterns
// - optional postcode sweep to increase hit odds
// - CLI runner: node scanner.js "RG41 1YZ" 25
//
// Deps: npm i cheerio p-retry p-queue dayjs
// Node: v18+ (built-in fetch)

import { load as loadHtml } from 'cheerio';
import pRetry from 'p-retry';
import PQueue from 'p-queue';
import dayjs from 'dayjs';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

// ========== CONFIG ==========
export const ORIGIN = 'https://www.nhs.uk';
export const SEARCH_PATH = '/service-search/find-a-dentist/results'; // adjust if the target path differs
const TIMEOUT_MS = 12000;
const MAX_RETRIES = 3;
const CONCURRENCY = 3;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36';

// Acceptance wording (extend as you see new variants in the wild)
export const ACCEPTING_PATTERNS = [
  'accepting new nhs patients',
  'accepting nhs patients',
  'taking new nhs patients',
  'currently accepting',
  'now accepting',
  'accepting adults and children',
  'accepting children and adults',
];

export const NOT_ACCEPTING_PATTERNS = [
  'not accepting',
  'no longer accepting',
  'not currently accepting',
  'temporarily not accepting',
  'not taking new nhs patients',
];

// Dense anchors to widen odds when a single postcode returns no hits
export const ANCHOR_POSTCODES = [
  'B1 1TB',  // Birmingham
  'M1 1AE',  // Manchester
  'L1 8JQ',  // Liverpool
  'BS1 4ST', // Bristol
  'NE1 4LP', // Newcastle
  'CF10 1EP' // Cardiff
];

// ========== UTILS ==========
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(s) {
  return String(s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function includesAny(hay, needles) {
  const h = normalize(hay);
  return needles.some((n) => h.includes(normalize(n)));
}

function safeText($, el) {
  if (!el) return '';
  return normalize($(el).text());
}

function nowIso() {
  return dayjs().toISOString();
}

// ========== FETCH with retry/backoff ==========
async function fetchHtml(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-GB,en;q=0.9' },
    signal: controller.signal,
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
    maxTimeout: 2000,
    onFailedAttempt: (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[retry] attempt ${err.attemptNumber}, ${err.retriesLeft} left -> ${url}: ${err.message}`);
    },
  });
}

// ========== PARSING ==========
export function extractPractice($, card, sourceUrl) {
  // Try multiple selectors to survive small DOM changes
  const name =
    safeText($, $(card).find('h2, h3, .org-title').first()) ||
    safeText($, $(card).find('[itemprop="name"]').first());

  const address =
    normalize(
      $(card)
        .find('.address, [itemprop="address"], address')
        .first()
        .text() || ''
    );

  const phone =
    normalize(
      $(card)
        .find('a[href^="tel:"], .tel, .phone, [itemprop="telephone"]')
        .first()
        .text() || ''
    );

  const distance =
    normalize($(card).find('.distance, .nhsuk-u-margin-top-2').first().text() || '');

  // Status text may be in badges, hints, or body copy
  const statusText =
    safeText($, $(card).find('.nhsuk-tag, .status, .acceptance, .nhsuk-hint, .nhsuk-warning-text').first()) ||
    safeText($, $(card).find('.content, p, li').first());

  // Acceptance inference (three-state)
  let accepting = null;
  if (includesAny(statusText, ACCEPTING_PATTERNS)) accepting = true;
  else if (includesAny(statusText, NOT_ACCEPTING_PATTERNS)) accepting = false;

  return {
    name,
    address,
    phone,
    distance,
    accepting,                // true | false | null
    status_text_snippet: statusText,
    source_url: sourceUrl,
  };
}

export function parseListing(html, url) {
  const $ = loadHtml(html);
  // Practice cards (try a few common containers)
  const cards =
    $('.nhsuk-search-results__item, .nhsuk-card, .result, .service').toArray() || [];

  const practices = cards.map((c) => extractPractice($, c, url)).filter(Boolean);

  // Pagination (best-effort)
  const nextHref =
    $('a[rel="next"], .nhsuk-pagination__link--next').attr('href') ||
    $('a:contains("Next")').attr('href') ||
    null;

  const nextUrl = nextHref
    ? (nextHref.startsWith('http') ? nextHref : `${ORIGIN}${nextHref}`)
    : null;

  return { practices, nextUrl, rawCount: cards.length };
}

// ========== SEARCH FLOW ==========
export function buildSearchUrl(postcode, radiusMiles, page = 1) {
  // Adjust param keys if the target search uses different ones
  const params = new URLSearchParams();
  params.set('postcode', postcode);
  params.set('distance', String(radiusMiles));
  params.set('page', String(page));
  return `${ORIGIN}${SEARCH_PATH}?${params.toString()}`;
}

export async function scanPostcode(postcode, radiusMiles) {
  const startedAt = nowIso();
  let url = buildSearchUrl(postcode, radiusMiles);
  const all = [];
  let page = 1;
  let visited = 0;

  while (url && page <= 6) {
    const html = await getHtmlWithRetry(url);
    const { practices, nextUrl, rawCount } = parseListing(html, url);
    visited++;
    all.push(...practices);

    if (!nextUrl || rawCount === 0) break;
    url = nextUrl;
    page++;
    await sleep(250);
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
    detailHits,
    acceptHits,
    practices: all,
  };
}

export async function scanWithSweep(primaryPostcode, radiusMiles) {
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

// ========== PUBLIC ENTRY ==========
/**
 * runScan(postcode, radiusMiles, options)
 * options:
 *   - sweep: boolean (default: true) – try anchor postcodes if no accept hits
 */
export async function runScan(postcode, radiusMiles = 25, options = { sweep: true }) {
  const { sweep = true } = options || {};
  return sweep ? scanWithSweep(postcode, radiusMiles) : scanPostcode(postcode, radiusMiles);
}

// Default export (handy for consumers that do `import runScan from './scanner.js'`)
export default runScan;

// ========== CLI ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Executed directly: node scanner.js "RG41 1YZ" 25
  const postcode = process.argv[2] || 'RG41 1YZ';
  const radius = Number(process.argv[3] || 25);

  (async () => {
    try {
      // Small queue, ready for future parallel scans if needed
      const queue = new PQueue({ concurrency: CONCURRENCY });
      const res = await queue.add(() => runScan(postcode, radius, { sweep: true }));

      // Human-friendly summary
      const summary = {
        postcode: res.postcode,
        radius_miles: res.radius_miles,
        checked_pages: res.checked_pages,
        detailHits: res.detailHits,
        acceptHits: res.acceptHits,
        sweep_used: !!res.sweep_used,
        sweep_origin: res.sweep_origin || null,
        sample: res.practices.slice(0, 5), // first few to eyeball
      };

      console.log(JSON.stringify(summary, null, 2));
      // If you need the full payload for your API, uncomment:
      // console.log(JSON.stringify(res, null, 2));
    } catch (err) {
      console.error('[scanner] FAILED:', err.message);
      if (err.body) console.error('[body-snippet]', err.body.slice(0, 500));
      process.exit(1);
    }
  })();
}
