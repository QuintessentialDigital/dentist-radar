/**
 * DentistRadar — scanner.js (v3.0)
 * -------------------------------------------------------------------------
 * - Primary: scan Practices from Mongo (any of detailsUrl / nhsUrl / url).
 * - If none found for a job: **live discover** practices from NHS search
 *   for the job's postcode + radius, then crawl those URLs.
 * - Robust Appointments discovery + focused text extraction + broad matcher.
 * - Haversine radius (ENV map POSTCODE_COORDS or Postcodes collection).
 * - Recipients: Users first; if none, fall back to Watch emails for postcode.
 * - Postmark email only.
 *
 * ENV (required):
 *   MONGO_URI
 *   POSTMARK_SERVER_TOKEN
 *   EMAIL_FROM   e.g., "DentistRadar <alerts@yourdomain.com>"
 *
 * ENV (optional):
 *   POSTMARK_MESSAGE_STREAM="outbound"
 *   INCLUDE_CHILD_ONLY="false"
 *   MAX_CONCURRENCY="5"
 *   SCAN_SAMPLE_LIMIT="40"  // sample size when using generic fallbacks
 *   DEBUG_APPTS="1"         // logs first 400 chars for unmatched pages
 *   POSTCODE_COORDS="RG41 4UW:51.411,-0.864;RG40 1XX:51.403,-0.840"
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import axiosRetry from 'axios-retry';
import {
  connectMongo, disconnectMongo,
  Practice, EmailLog, User, Watch, Postcode
} from './models.js';

/* =========================
   Config
   ========================= */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = 'outbound',
  INCLUDE_CHILD_ONLY = 'false',
  MAX_CONCURRENCY = '5',
  SCAN_SAMPLE_LIMIT = '40',
  DEBUG_APPTS = '0',
  POSTCODE_COORDS = ''
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required');
if (!EMAIL_FROM) throw new Error('EMAIL_FROM is required');

const INCLUDE_CHILD =
  globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ ??
  (String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true');
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);
const SAMPLE_LIMIT = Math.max(1, Number(SCAN_SAMPLE_LIMIT) || 40);
const DEBUG = String(DEBUG_APPTS) === '1';

/* =========================
   Axios retry
   ========================= */
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retry) => 1000 * Math.pow(2, retry) + Math.floor(Math.random() * 500),
  retryCondition: (err) => {
    const status = err?.response?.status;
    return !status || [429, 403, 500, 502, 503, 504].includes(status);
  },
});

/* =========================
   Helpers
   ========================= */
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normalizeText = (s) =>
  String(s || '').replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

const normalizePostcode = (pc) =>
  String(pc || '').toUpperCase().replace(/\s+/g, ' ').trim();

const sanitizeEmail = (s) => {
  const x = String(s || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x : '';
};

// Parse env POSTCODE_COORDS = "PC1:lat,lon;PC2:lat,lon"
function parsePostcodeCoordsEnv(raw) {
  const map = new Map();
  String(raw || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const [pcRaw, coords] = pair.split(':').map(s => (s || '').trim());
      if (!pcRaw || !coords) return;
      const [latStr, lonStr] = coords.split(',').map(s => (s || '').trim());
      const lat = Number(latStr), lon = Number(lonStr);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        map.set(normalizePostcode(pcRaw), { lat, lon });
      }
    });
  return map;
}
const POSTCODE_COORDS_MAP = parsePostcodeCoordsEnv(POSTCODE_COORDS);

// Haversine distance (miles)
function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Get lat/lon for a normalized postcode from ENV map (first) then DB
async function getCoordsForPostcode(pcRaw) {
  const pc = normalizePostcode(pcRaw);
  if (!pc) return null;

  if (POSTCODE_COORDS_MAP.has(pc)) return POSTCODE_COORDS_MAP.get(pc);

  const doc = await Postcode.findOne({ postcode: pc }).select('lat lon').lean();
  if (!doc) return null;
  return { lat: doc.lat, lon: doc.lon };
}

/* =========================
   Acceptance parsing
   ========================= */
function classifyAcceptance(rawHtmlOrText) {
  const text = normalizeText(rawHtmlOrText);
  const t = text.replace(/’/g, "'").replace(/–|—/g, '-');

  const childOnly =
    (
      /(only\s+accepts?|currently\s+only\s+accepts?|accepting\s+only)\s+(new\s+)?nhs\s+patients/i.test(t) &&
      /children\s+(aged\s+17\s+or\s+under|only|under\s*18)/i.test(t)
    ) ||
    /children\s+(only|under\s*18)\s+accepted/i.test(t);

  const accepting =
    /(accepts|is accepting|are accepting|currently accepting)\s+(new\s+)?nhs\s+patients/i.test(t) &&
    !childOnly;

  const notConfirmed =
    /has\s+not\s+confirmed\s+if\s+.*accept/i.test(t) ||
    /not\s+confirmed\s+(whether|if)\s+.*accept/i.test(t);

  if (childOnly)    return { status: 'CHILD_ONLY', matched: 'child-only' };
  if (accepting)    return { status: 'ACCEPTING', matched: 'accepting' };
  if (notConfirmed) return { status: 'NOT_CONFIRMED', matched: 'not-confirmed' };
  return { status: 'NOT_CONFIRMED', matched: 'unknown' };
}

/* =========================
   HTTP + Appointments loader
   ========================= */
async function httpGet(url) {
  try {
    const ua = UAS[Math.floor(Math.random() * UAS.length)];
    const { data, status } = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    if (status >= 300) return null;
    return data;
  } catch (err) {
    console.error('[httpGet]', url, err?.response?.status || err?.message);
    return null;
  }
}

/**
 * Returns either:
 *  - string (appointments page HTML), or
 *  - { __inline__: true, html: detailsHtml } when no dedicated appointments link is found.
 */
async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  // If already an appointments URL
  if (/\/appointments(\/|$|\?|#)/i.test(detailsUrl)) {
    return httpGet(detailsUrl);
  }

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // Prefer candidates by visible text first
  const textCandidates = [
    'appointments',
    'appointments and opening times',
    'appointments & opening times',
    'opening times',
  ];

  let href;
  $('a').each((_, el) => {
    const t = normalizeText($(el).text()).toLowerCase();
    if (textCandidates.some(c => t.includes(c))) {
      href = $(el).attr('href');
      if (href) return false; // break
    }
  });

  // Fallback by URL patterns
  if (!href) href = $('a[href*="/appointments"]').first().attr('href');
  if (!href) href = $('a[href*="appointments-and-opening-times"]').first().attr('href');
  if (!href) href = $('a[href*="opening-times"]').first().attr('href');

  if (!href) {
    // No dedicated appointments link found; try to match on the details page itself
    return { __inline__: true, html: detailsHtml };
  }

  const appointmentsUrl = new URL(href, detailsUrl).toString();
  await sleep(200 + Math.floor(Math.random() * 200));
  return httpGet(appointmentsUrl);
}

/**
 * Extracts the likely Appointments/Opening Times text content from a page.
 */
function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  // Sections headed by h1/h2/h3 that mention appointments/opening times
  $('h1,h2,h3').each((_, h) => {
    const heading = normalizeText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next();
      let hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || '').toLowerCase();
        if (/^h[1-6]$/.test(tag)) break; // stop at next heading
        if (['p', 'div', 'li', 'ul', 'ol'].includes(tag)) {
          section.push(normalizeText(cur.text()));
        }
        cur = cur.next();
        hops++;
      }
      const joined = section.join(' ').trim();
      if (joined) candidates.push(joined);
    }
  });

  // Common NHS content wrappers
  const knownSelectors = [
    'main',
    '.nhsuk-main-wrapper',
    '#content',
    '#maincontent',
    '[data-testid="content"]',
    '.nhsuk-u-reading-width',
    '.nhsuk-width-container',
  ];
  for (const sel of knownSelectors) {
    const t = normalizeText($(sel).text());
    if (t && t.length > 80) candidates.push(t);
  }

  // Inset/notice content areas
  const noticeSelectors = [
    '.nhsuk-inset-text',
    '.nhsuk-warning-callout',
    '.nhsuk-notification-banner__content',
    '.nhsuk-panel',
  ];
  for (const sel of noticeSelectors) {
    $(sel).each((_, el) => {
      const t = normalizeText($(el).text());
      if (t) candidates.push(t);
    });
  }

  if (!candidates.length) candidates.push(normalizeText($.root().text()));
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || '';
}

/* =========================
   NHS discovery fallback
   ========================= */
/**
 * Discover practice details URLs from NHS search results for a postcode+radius.
 * We look for links like: https://www.nhs.uk/services/dentists/<slug>/<id>
 *
 * NOTE: This is a best-effort scraper. If NHS markup shifts, tweak selectors.
 */
async function discoverPracticesFromNHS(postcode, radiusMiles) {
  const pc = normalizePostcode(postcode);
  const q = encodeURIComponent(pc);
  // Known result pattern; distance is advisory (NHS site may paginate)
  const url = `https://www.nhs.uk/service-search/find-a-dentist/results/${q}?distance=${encodeURIComponent(radiusMiles)}&latitude=&longitude=`;

  const html = await httpGet(url);
  if (!html) return [];

  const $ = cheerio.load(html);
  const urls = new Set();

  // Result cards: find anchors to /services/dentists/...
  $('a[href*="/services/dentists/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    try {
      const abs = new URL(href, 'https://www.nhs.uk').toString();
      // Ignore appointment subpages here; we want the details page
      if (/https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs) && !/\/appointments/i.test(abs)) {
        urls.add(abs);
      }
    } catch (_) {}
  });

  // Fallback: any service links on the page
  if (urls.size === 0) {
    $('a').each((_, a) => {
      const href = $(a).attr('href') || '';
      try {
        const abs = new URL(href, 'https://www.nhs.uk').toString();
        if (/https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs)) {
          urls.add(abs);
        }
      } catch (_) {}
    });
  }

  return Array.from(urls).slice(0, SAMPLE_LIMIT);
}

/* =========================
   Audience targeting (Users → Watch fallback)
   ========================= */
async function getRecipientsForPostcode(jobPostcode, opts = {}) {
  if (Array.isArray(opts.overrideRecipients) && opts.overrideRecipients.length) {
    return [...new Set(opts.overrideRecipients.map(sanitizeEmail))].filter(Boolean);
  }

  const pc = normalizePostcode(jobPostcode);

  // Primary: Users
  const users = await User.find({
    active: true,
    receiveAlerts: true,
    $or: [
      { postcodes: pc },
      { 'areas.postcode': pc },
      // global subscribers (no targeting specified)
      { $and: [{ postcodes: { $exists: false } }, { areas: { $exists: false } }] },
      { $and: [{ postcodes: { $in: [null, [], undefined] } }, { areas: { $in: [null, [], undefined] } }] },
    ],
  }).select('email').lean();

  let emails = users.map(u => sanitizeEmail(u.email)).filter(Boolean);

  // Fallback: Watch emails for this postcode (unique)
  if (!emails.length) {
    const watchers = await Watch.find({ postcode: pc }).select('email').lean();
    const watchEmails = watchers.map(w => sanitizeEmail(w.email)).filter(Boolean);
    emails = [...new Set(watchEmails)];
  }

  return emails.slice(0, 5000);
}

/* =========================
   Jobs (from Watch)
   ========================= */
async function buildJobsFromWatch(filterPostcode) {
  const match = filterPostcode ? { postcode: normalizePostcode(filterPostcode) } : {};
  const watches = await Watch.aggregate([
    { $match: match },
    { $group: { _id: '$postcode', radiusMiles: { $first: '$radius' } } },
    { $project: { _id: 0, postcode: '$_id', radiusMiles: '$radiusMiles' } }
  ]);

  return watches.map(w => ({
    postcode: normalizePostcode(w.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(w.radiusMiles) || 10)),
  }));
}

/* =========================
   Scan one job (DB first; NHS fallback)
   ========================= */
async function scanPostcodeJob({ postcode, radiusMiles }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const jobCoords = await getCoordsForPostcode(postcode);

  // 1) Try DB practices with ANY url field
  let practicesBase = await Practice.find({
    $or: [
      { detailsUrl: { $exists: true, $ne: '' } },
      { nhsUrl:     { $exists: true, $ne: '' } },
      { url:        { $exists: true, $ne: '' } },
    ]
  }).select('_id name postcode detailsUrl nhsUrl url lat lon distanceMiles').lean();

  // Unify URL
  for (const p of practicesBase) p._url = p.detailsUrl || p.nhsUrl || p.url || '';

  // 2) Filter by radius if we have coords
  if (jobCoords && practicesBase.length) {
    for (const p of practicesBase) {
      let plat = p.lat, plon = p.lon;

      if ((plat == null || plon == null) && p.postcode) {
        const pc = await getCoordsForPostcode(p.postcode);
        if (pc) { plat = pc.lat; plon = pc.lon; }
      }

      if (plat != null && plon != null) {
        p._computedDistance = haversineMiles(jobCoords.lat, jobCoords.lon, plat, plon);
      } else if (typeof p.distanceMiles === 'number') {
        p._computedDistance = p.distanceMiles;
      } else {
        p._computedDistance = Infinity;
      }
    }

    practicesBase = practicesBase
      .filter(p => p._computedDistance <= radiusMiles)
      .sort((a, b) => (a._computedDistance ?? 999) - (b._computedDistance ?? 999));
  }

  // 3) If NOTHING usable from DB, **discover from NHS** for this job
  if (!practicesBase.length) {
    console.log('[INFO] No DB practices with URL in radius — discovering from NHS...');
    const liveUrls = await discoverPracticesFromNHS(postcode, radiusMiles);
    if (!liveUrls.length) {
      console.log('[WARN] NHS discovery returned 0 URLs.');
      return { accepting: [], childOnly: [] };
    }
    // Convert to minimal practice objects for scanning
    practicesBase = liveUrls.slice(0, SAMPLE_LIMIT).map((u, i) => ({
      _id: { toString: () => `live-${i}` }, // temp id for logging/dedupe scope
      name: '', // (we’ll parse name later if needed)
      postcode: '',
      _url: u,
      _computedDistance: undefined
    }));
  }

  if (!practicesBase.length) {
    console.log('No practices found (even after fallback).');
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(
    practicesBase.map((p, idx) =>
      limit(async () => {
        // For live IDs, dedupe by URL+date
        const dedupe = p._id?.toString?.().startsWith('live-')
          ? { practiceUrl: p._url, dateKey }
          : { practiceId: p._id, dateKey };

        const already = await EmailLog.findOne(dedupe).lean();
        if (already) return;

        const apptRes = await loadAppointmentsHtml(p._url);
        if (!apptRes) return;

        const pageHtml = (typeof apptRes === 'string')
          ? apptRes
          : (apptRes && apptRes.__inline__ && apptRes.html) ? apptRes.html : null;
        if (!pageHtml) return;

        // Try to capture a readable name if missing
        let name = p.name;
        if (!name) {
          try {
            const $d = cheerio.load(pageHtml);
            const h = normalizeText($d('h1').first().text());
            if (h) name = h;
          } catch (_) {}
        }

        const sectionText = extractAppointmentsText(pageHtml);
        const verdict = classifyAcceptance(sectionText);

        if (verdict.status === 'ACCEPTING') {
          accepting.push({
            id: p._id?.toString?.() || `live-${idx}`,
            name: name || 'Dental practice',
            postcode: p.postcode || '',
            url: p._url,
            distanceMiles: p._computedDistance,
          });
          await EmailLog.create({
            ...(dedupe.practiceUrl ? { practiceUrl: p._url } : { practiceId: p._id }),
            status: 'ACCEPTING',
            dateKey,
          });
        } else if (verdict.status === 'CHILD_ONLY' && INCLUDE_CHILD) {
          childOnly.push({
            id: p._id?.toString?.() || `live-${idx}`,
            name: name || 'Dental practice',
            postcode: p.postcode || '',
            url: p._url,
            distanceMiles: p._computedDistance,
          });
          await EmailLog.create({
            ...(dedupe.practiceUrl ? { practiceUrl: p._url } : { practiceId: p._id }),
            status: 'CHILD_ONLY',
            dateKey,
          });
        } else if (DEBUG) {
          console.log('[DEBUG NO-MATCH]', p._url, '→', sectionText.slice(0, 400));
        }
      })
    )
  );

  return { accepting, childOnly };
}

/* =========================
   Email via Postmark
   ========================= */
async function sendEmailForJob(job, found, opts = {}) {
  const recipients = await getRecipientsForPostcode(job.postcode, opts);
  if (!recipients.length) {
    console.log('No recipients (Users/Watch); skipping email.');
    return;
  }

  const hasAccepting = found.accepting.length > 0;
  const hasChildOnly = INCLUDE_CHILD && found.childOnly.length > 0;
  if (!hasAccepting && !hasChildOnly) {
    console.log('Nothing to email for this job.');
    return;
  }

  const lines = [];

  if (hasAccepting) {
    lines.push(`✅ <b>Accepting (adults/all)</b> — ${found.accepting.length}`);
    found.accepting
      .forEach((p, i) => {
        const miles = p.distanceMiles;
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode || ''} — ${miles != null && miles.toFixed ? miles.toFixed(1) : '?'} mi<br/>` +
          `<a href="${p.url}">${p.url}</a>`
        );
      });
    lines.push('<br/>');
  }

  if (hasChildOnly) {
    lines.push(`🟨 <b>Children-only</b> — ${found.childOnly.length}`);
    found.childOnly
      .forEach((p, i) => {
        const miles = p.distanceMiles;
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode || ''} — ${miles != null && miles.toFixed ? miles.toFixed(1) : '?'} mi<br/>` +
          `<a href="${p.url}">${p.url}</a>`
        );
      });
    lines.push('<br/>');
  }

  const subject =
    `DentistRadar: ${job.postcode} (${job.radiusMiles} mi) — ` +
    `${found.accepting.length} accepting${INCLUDE_CHILD ? `, ${found.childOnly.length} child-only` : ''}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;">
      <h2 style="margin:0 0 8px">DentistRadar – ${escapeHtml(job.postcode)} (${job.radiusMiles} mi)</h2>
      <div style="color:#444;margin:0 0 12px">Date: ${dayjs().format('YYYY-MM-DD HH:mm')}</div>
      ${lines.join('\n')}
      <hr style="margin:16px 0;border:0;border-top:1px solid #e5e5e5">
      <div style="font-size:12px;color:#777">This email only includes practices verified on the Appointments page.</div>
    </div>
  `;

  await axios.post(
    'https://api.postmarkapp.com/email',
    {
      From: EMAIL_FROM,
      To: recipients.join(','),
      Subject: subject,
      HtmlBody: html,
      MessageStream: POSTMARK_MESSAGE_STREAM,
      Tag: 'dentistradar-scan',
    },
    {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
      },
      timeout: 10000,
    }
  );

  console.log(`Email sent to ${recipients.length} recipient(s): ${subject}`);
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/* =========================
   Exported Runner (Watch-driven)
   ========================= */
export async function runScan(opts = {}) {
  const includeChildOnlyOverride =
    typeof opts.includeChildOnly === 'boolean' ? opts.includeChildOnly : null;
  if (includeChildOnlyOverride !== null) {
    globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ = includeChildOnlyOverride;
  }

  await connectMongo(MONGO_URI);
  console.log('Mongo connected.');

  const jobs = await buildJobsFromWatch(opts.postcode);
  if (!jobs.length) {
    console.log('[RESULT] No Watch entries → nothing to scan.');
    return { jobs: 0, summaries: [] };
  }

  const summaries = [];
  for (const job of jobs) {
    try {
      const found = await scanPostcodeJob(job);
      await sendEmailForJob(job, found, opts);
      summaries.push({
        postcode: job.postcode,
        radiusMiles: job.radiusMiles,
        accepting: found.accepting.length,
        childOnly: found.childOnly.length,
      });
    } catch (err) {
      console.error(`Job failed for ${job.postcode}`, err);
    }
    await sleep(800 + Math.floor(Math.random() * 700));
  }

  console.log('[DONE]', summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

// Self-run for CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(async () => { await disconnectMongo(); process.exit(0); })
    .catch(async (e) => { console.error(e); try { await disconnectMongo(); } catch {} process.exit(1); });
}
