/**
 * DentistRadar — scanner.js (v2.6)
 * - Watch-driven jobs (postcode+radius from Watch)
 * - Haversine distance; on-the-fly geocoding via Postcodes collection OR postcodes.io
 * - Flexible practice URL (detailsUrl | nhsUrl | url)
 * - Appointments-page parsing; Postmark-only email
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
  SCAN_SAMPLE_LIMIT = '60' // bump fallback sample
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required');
if (!EMAIL_FROM) throw new Error('EMAIL_FROM is required');

const INCLUDE_CHILD =
  globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ ??
  (String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true');
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);
const SAMPLE_LIMIT = Math.max(1, Number(SCAN_SAMPLE_LIMIT) || 60);

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

// Haversine (miles)
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

/* =========================
   Geocoding
   ========================= */
async function getCoordsFromDb(pcNorm) {
  const doc = await Postcode.findOne({ postcode: pcNorm }).select('lat lon').lean();
  if (!doc) return null;
  return { lat: doc.lat, lon: doc.lon };
}

async function geocodeViaPostcodesIo(pcNorm) {
  try {
    const url = `https://api.postcodes.io/postcodes/${encodeURIComponent(pcNorm)}`;
    const { data, status } = await axios.get(url, { timeout: 8000, validateStatus: s => s >= 200 && s < 500 });
    if (status !== 200 || !data?.result) return null;
    const { latitude, longitude } = data.result;
    if (typeof latitude === 'number' && typeof longitude === 'number') {
      // cache it for next time (best-effort)
      try {
        await Postcode.updateOne(
          { postcode: pcNorm },
          { $set: { lat: latitude, lon: longitude } },
          { upsert: true }
        );
      } catch {}
      return { lat: latitude, lon: longitude };
    }
  } catch (e) {
    console.log('[geocode] postcodes.io fail:', e?.message || e);
  }
  return null;
}

async function getCoordsForPostcode(pcRaw) {
  const pc = normalizePostcode(pcRaw);
  if (!pc) return null;
  return (await getCoordsFromDb(pc)) || (await geocodeViaPostcodesIo(pc));
}

/* =========================
   Acceptance parsing
   ========================= */
function classifyAcceptance(rawHtmlOrText) {
  const text = normalizeText(rawHtmlOrText);

  const accepting =
    /(accepts|is accepting|currently accepting|are accepting)\s+new\s+nhs\s+patients/i.test(text) &&
    !/only\s+accepts?\s+(new\s+nhs\s+patients\s+)?(if\s+they\s+are\s+)?children/i.test(text);

  const childOnly =
    /(only\s+accepts?|currently\s+only\s+accepts?)\s+.*\s+children\s+(aged\s+17\s+or\s+under)?/i.test(text) &&
    /nhs\s+patients/i.test(text);

  const notConfirmed = /has\s+not\s+confirmed\s+if\s+.*accept/i.test(text);

  if (childOnly) return { status: 'CHILD_ONLY', matched: 'child-only' };
  if (accepting) return { status: 'ACCEPTING', matched: 'accepting' };
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

function resolvePracticeUrl(p) {
  return p?.detailsUrl || p?.nhsUrl || p?.url || '';
}

async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // Prefer link by visible text
  let href = $('a')
    .filter((_, el) => normalizeText($(el).text()).toLowerCase().includes('appointment'))
    .first()
    .attr('href');

  // Fallback by URL hint
  if (!href) href = $('a[href*="/appointments"]').first().attr('href');
  if (!href) return null;

  const appointmentsUrl = new URL(href, detailsUrl).toString();
  await sleep(200 + Math.floor(Math.random() * 200));
  return httpGet(appointmentsUrl);
}

/* =========================
   Audience targeting (Users)
   ========================= */
async function getRecipientsForPostcode(jobPostcode, opts = {}) {
  if (Array.isArray(opts.overrideRecipients) && opts.overrideRecipients.length) {
    return [...new Set(opts.overrideRecipients.map(sanitizeEmail))].filter(Boolean);
  }

  const pc = normalizePostcode(jobPostcode);

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

  const emails = users.map(u => sanitizeEmail(u.email)).filter(Boolean);
  return [...new Set(emails)].slice(0, 5000);
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
   Scan one job (with Haversine + robust fallback)
   ========================= */
async function scanPostcodeJob({ postcode, radiusMiles }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  // Get center coords for job postcode (DB or postcodes.io)
  const jobCoords = await getCoordsForPostcode(postcode);

  // Base query: we’ll compute/filter distance ourselves; select multiple URL fields
  let practicesBase = await Practice.find({
    $or: [
      { detailsUrl: { $exists: true, $ne: '' } },
      { nhsUrl: { $exists: true, $ne: '' } },
      { url: { $exists: true, $ne: '' } }
    ]
  }).select('_id name postcode detailsUrl nhsUrl url lat lon distanceMiles').lean();

  if (!practicesBase.length) {
    console.log('[DEBUG] Practices with any URL field = 0. Check ingestion.');
    return { accepting: [], childOnly: [] };
  }

  // Compute distances if we have jobCoords
  if (jobCoords) {
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

    if (!practicesBase.length) {
      console.log('[DEBUG] No practices within radius after Haversine filter.');
    }
  } else {
    console.log('[WARN] No coords for job postcode', postcode, '— cannot distance-filter.');
  }

  // If empty after distance, fallback sample to prove parsing/email end-to-end
  if (!practicesBase.length) {
    const sample = await Practice.find({
      $or: [
        { detailsUrl: { $exists: true, $ne: '' } },
        { nhsUrl: { $exists: true, $ne: '' } },
        { url: { $exists: true, $ne: '' } }
      ]
    }).select('_id name postcode detailsUrl nhsUrl url').limit(SAMPLE_LIMIT).lean();

    if (!sample.length) {
      console.log('No practices found (even after fallback).');
      return { accepting: [], childOnly: [] };
    }

    console.log(`[DEBUG] Using sampling fallback (${sample.length} practices).`);
    practicesBase = sample;
  }

  // Small debug snapshot to verify fields
  console.log('[DEBUG] First 2 practices:', practicesBase.slice(0, 2).map(x => ({
    id: x._id, name: x.name, postcode: x.postcode,
    url: resolvePracticeUrl(x),
    dist: (x._computedDistance ?? x.distanceMiles)
  })));

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(
    practicesBase.map((p) =>
      limit(async () => {
        const url = resolvePracticeUrl(p);
        if (!url) return;

        // Per-day de-dup per practice
        const already = await EmailLog.findOne({ practiceId: p._id, dateKey }).lean();
        if (already) return;

        const apptHtml = await loadAppointmentsHtml(url);
        if (!apptHtml) return;

        const verdict = classifyAcceptance(apptHtml);

        if (verdict.status === 'ACCEPTING') {
          accepting.push({
            id: p._id.toString(),
            name: p.name,
            postcode: p.postcode,
            url,
            distanceMiles: p._computedDistance ?? p.distanceMiles,
          });
          await EmailLog.create({
            practiceId: p._id, practiceUrl: url, status: 'ACCEPTING', dateKey,
          });
        } else if (verdict.status === 'CHILD_ONLY' && INCLUDE_CHILD) {
          childOnly.push({
            id: p._id.toString(),
            name: p.name,
            postcode: p.postcode,
            url,
            distanceMiles: p._computedDistance ?? p.distanceMiles,
          });
          await EmailLog.create({
            practiceId: p._id, practiceUrl: url, status: 'CHILD_ONLY', dateKey,
          });
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
    console.log('No recipients; skipping email.');
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
      .sort((a, b) => ((a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)))
      .forEach((p, i) => {
        const miles = p.distanceMiles;
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${miles != null && miles.toFixed ? miles.toFixed(1) : '?'} mi<br/>` +
          `<a href="${p.url}">${p.url}</a>`
        );
      });
    lines.push('<br/>');
  }

  if (hasChildOnly) {
    lines.push(`🟨 <b>Children-only</b> — ${found.childOnly.length}`);
    found.childOnly
      .sort((a, b) => ((a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)))
      .forEach((p, i) => {
        const miles = p.distanceMiles;
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${miles != null && miles.toFixed ? miles.toFixed(1) : '?'} mi<br/>` +
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
  return String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/* =========================
   Runner
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(async () => { await disconnectMongo(); process.exit(0); })
    .catch(async (e) => { console.error(e); try { await disconnectMongo(); } catch {} process.exit(1); });
}
