/**
 * DentistRadar — scanner.js (v2.2, Postmark-only, User-targeted)
 * ----------------------------------------------------------------
 * - Scans NHS practices within radius from MongoDB SearchAreas.
 * - Visits ONLY the "Appointments" page to read acceptance status.
 * - Classifies: ACCEPTING / CHILD_ONLY / NOT_CONFIRMED.
 * - Sends ONE summary email PER SearchArea to *actual users* fetched
 *   from MongoDB (not from env). Supports simple audience targeting:
 *     - Users.active === true AND Users.receiveAlerts === true
 *     - Optional targeting by postcode via Users.postcodes or Users.areas[].postcode
 * - Exports runScan(opts) for programmatic use; also self-runs via CLI.
 *
 * ENV (required):
 *   MONGO_URI="mongodb+srv://..."
 *   POSTMARK_SERVER_TOKEN="your-postmark-server-token"
 *   EMAIL_FROM="DentistRadar <alerts@yourverifieddomain.com>"
 *
 * ENV (optional):
 *   POSTMARK_MESSAGE_STREAM="outbound"   // default 'outbound'
 *   INCLUDE_CHILD_ONLY="false"           // "true" to include child-only hits
 *   MAX_CONCURRENCY="5"
 *
 * Users collection assumptions (flexible; adapt selectors below if needed):
 *   Users: {
 *     email: String,                 // required
 *     active: Boolean,               // true to receive anything
 *     receiveAlerts: Boolean,        // true to receive scan emails
 *     postcodes?: [String],          // optional explicit list (e.g., ["RG6 1AB","RG1"])
 *     areas?: [{ postcode: String, radiusMiles?: Number }], // optional objects
 *     // ...other fields ok
 *   }
 *
 * NOTE: This file uses only Axios to call Postmark HTTP API — no SMTP.
 */

import mongoose from 'mongoose';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import axiosRetry from 'axios-retry';

// ----------------------- Config -----------------------
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_MESSAGE_STREAM = 'outbound',
  EMAIL_FROM,
  INCLUDE_CHILD_ONLY = 'false',
  MAX_CONCURRENCY = '5',
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required');
if (!EMAIL_FROM) throw new Error('EMAIL_FROM is required');

const INCLUDE_CHILD =
  globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ ??
  (String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true');
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);

// ----------------------- Retry Config -----------------
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retry) =>
    1000 * Math.pow(2, retry) + Math.floor(Math.random() * 500),
  retryCondition: (err) => {
    const status = err?.response?.status;
    return !status || [429, 403, 500, 502, 503, 504].includes(status);
  },
});

// ----------------------- Helpers ----------------------
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------- DB Models --------------------
const SearchAreaSchema = new mongoose.Schema(
  {
    postcode: { type: String, required: true },
    radiusMiles: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { collection: 'SearchAreas' }
);

const PracticeSchema = new mongoose.Schema(
  {
    name: String,
    postcode: String,
    detailsUrl: String,
    distanceMiles: Number, // precomputed for the current search index
  },
  { collection: 'Practices' }
);

const EmailLogSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, index: true },
    practiceId: { type: mongoose.Schema.Types.ObjectId, index: true },
    practiceUrl: String,
    status: { type: String, enum: ['ACCEPTING', 'CHILD_ONLY'] },
    dateKey: { type: String, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'EmailLog' }
);

// Minimal Users model to enable Mongoose helpers; structure is flexible
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    active: { type: Boolean, default: true },
    receiveAlerts: { type: Boolean, default: true },
    postcodes: [String],
    areas: [{ postcode: String, radiusMiles: Number }],
  },
  { collection: 'Users' }
);

const SearchArea = mongoose.model('SearchArea', SearchAreaSchema);
const Practice = mongoose.model('Practice', PracticeSchema);
const EmailLog = mongoose.model('EmailLog', EmailLogSchema);
const User = mongoose.model('User', UserSchema);

// ---------------- Acceptance Parsing ------------------
function classifyAcceptance(rawHtmlOrText) {
  const text = normalizeText(rawHtmlOrText);

  const acceptingAdults =
    /currently accepts new nhs patients for routine dental care/i.test(text) &&
    /(adults|adults aged 18|adults entitled|children aged 17 or under)/i.test(text) &&
    !/only accepts.*children/i.test(text);

  const childOnlyExact =
    /currently only accepts new nhs patients for routine dental care.*children aged 17 or under/i.test(text);

  const genericAccepting =
    /(currently )?accepts new nhs patients( for routine dental care)?/i.test(text) &&
    !/only accepts.*children/i.test(text);

  const notConfirmed =
    /has not confirmed if .* accept(s)? new nhs patients/i.test(text);

  if (childOnlyExact || (/only accepts.*children/i.test(text) && /new nhs patients/i.test(text))) {
    return { status: 'CHILD_ONLY', matched: 'child-only' };
  }

  if (acceptingAdults || genericAccepting) {
    return { status: 'ACCEPTING', matched: 'accepting' };
  }

  if (notConfirmed) return { status: 'NOT_CONFIRMED', matched: 'not-confirmed' };

  return { status: 'NOT_CONFIRMED', matched: 'unknown' };
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

// ----------------- HTML: Appointments tab --------------
async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // Prefer link by text content
  let href = $('a')
    .filter((_, el) => {
      const t = normalizeText($(el).text()).toLowerCase();
      return t.includes('appointment');
    })
    .first()
    .attr('href');

  // Fallback by URL hint
  if (!href) href = $('a[href*="/appointments"]').first().attr('href');
  if (!href) return null;

  const appointmentsUrl = new URL(href, detailsUrl).toString();
  await sleep(200 + Math.floor(Math.random() * 200));
  return httpGet(appointmentsUrl);
}

// ------------------ HTTP util --------------------------
async function httpGet(url) {
  try {
    const ua = UAS[Math.floor(Math.random() * UAS.length)];
    const { data, status } = await axios.get(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
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

// ---------------- Audience (Users) targeting ------------
/**
 * Returns distinct recipient emails for this SearchArea job.
 * Targeting rules:
 *  - active === true AND receiveAlerts === true
 *  - If users specify postcodes array or areas[].postcode, match job.postcode
 *  - Otherwise, include as global recipients (they get all alerts)
 */
async function getRecipientsForJob(job, opts = {}) {
  if (Array.isArray(opts.overrideRecipients) && opts.overrideRecipients.length) {
    // developer override
    return [...new Set(opts.overrideRecipients.map(sanitizeEmail))].filter(Boolean);
  }

  const jobPC = normalizePostcode(job.postcode);

  // Build targeting filter with OR on preference fields; fallback captures global subscribers
  const filter = {
    active: true,
    receiveAlerts: true,
    $or: [
      { postcodes: jobPC }, // exact postcode match in simple array
      { 'areas.postcode': jobPC }, // match in areas array
      // fallback: users with no specific targeting fields get everything
      { $and: [{ postcodes: { $in: [null, [], undefined] } }, { areas: { $in: [null, [], undefined] } }] },
      { $and: [{ postcodes: { $exists: false } }, { areas: { $exists: false } }] },
    ],
  };

  const users = await User.find(filter).select('email').lean();
  const emails = users.map(u => sanitizeEmail(u.email)).filter(Boolean);
  // Deduplicate and keep a reasonable cap to avoid accidental blasts
  const unique = [...new Set(emails)].slice(0, 5000);
  return unique;
}

function normalizePostcode(pc) {
  return String(pc || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function sanitizeEmail(s) {
  const x = String(s || '').trim();
  // crude sanity check
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x : '';
}

// ------------------- Core Scan Logic -------------------
async function scanJob(job) {
  const { _id: jobId, postcode, radiusMiles } = job;
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  // Assumes Practices are pre-indexed with distanceMiles
  const practices = await Practice.find({
    distanceMiles: { $lte: radiusMiles },
    detailsUrl: { $exists: true, $ne: '' },
  })
    .select('_id name postcode detailsUrl distanceMiles')
    .lean();

  if (!practices.length) {
    console.log('No practices found in radius.');
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(
    practices.map((p) =>
      limit(async () => {
        // Skip if already emailed today for this job/practice
        const already = await EmailLog.findOne({ jobId, practiceId: p._id, dateKey }).lean();
        if (already) return;

        const apptHtml = await loadAppointmentsHtml(p.detailsUrl);
        if (!apptHtml) return;

        const verdict = classifyAcceptance(apptHtml);

        if (verdict.status === 'ACCEPTING') {
          accepting.push({
            id: p._id.toString(),
            name: p.name,
            postcode: p.postcode,
            url: p.detailsUrl,
            distanceMiles: p.distanceMiles,
          });

          await EmailLog.create({
            jobId, practiceId: p._id, practiceUrl: p.detailsUrl,
            status: 'ACCEPTING', dateKey,
          });
        } else if (verdict.status === 'CHILD_ONLY' && INCLUDE_CHILD) {
          childOnly.push({
            id: p._id.toString(),
            name: p.name,
            postcode: p.postcode,
            url: p.detailsUrl,
            distanceMiles: p.distanceMiles,
          });

          await EmailLog.create({
            jobId, practiceId: p._id, practiceUrl: p.detailsUrl,
            status: 'CHILD_ONLY', dateKey,
          });
        }
      })
    )
  );

  return { accepting, childOnly };
}

// ------------------- Email via Postmark -----------------
async function sendJobEmail(job, found, opts = {}) {
  const recipients = await getRecipientsForJob(job, opts);
  if (!recipients.length) {
    console.log('No recipients resolved for this job; skipping email.');
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
      .sort((a, b) => (a.distanceMiles || 999) - (b.distanceMiles || 999))
      .forEach((p, i) => {
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/>` +
          `<a href="${p.url}">${p.url}</a>`
        );
      });
    lines.push('<br/>');
  }

  if (hasChildOnly) {
    lines.push(`🟨 <b>Children-only</b> — ${found.childOnly.length}`);
    found.childOnly
      .sort((a, b) => (a.distanceMiles || 999) - (b.distanceMiles || 999))
      .forEach((p, i) => {
        lines.push(
          `${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/>` +
          `<a href="${p.url}">${p.url}</a>`
        );
      });
    lines.push('<br/>');
  }

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;">
      <h2 style="margin:0 0 8px">DentistRadar – ${escapeHtml(job.postcode)} (${job.radiusMiles} mi)</h2>
      <div style="color:#444;margin:0 0 12px">Date: ${dayjs().format('YYYY-MM-DD HH:mm')}</div>
      ${lines.join('\n')}
      <hr style="margin:16px 0;border:0;border-top:1px solid #e5e5e5">
      <div style="font-size:12px;color:#777">
        This email only includes practices verified on the Appointments page.
      </div>
    </div>
  `;

  const subject =
    `DentistRadar: ${job.postcode} (${job.radiusMiles} mi) — ` +
    `${found.accepting.length} accepting${INCLUDE_CHILD ? `, ${found.childOnly.length} child-only` : ''}`;

  // Send via Postmark HTTP API (single request with comma-separated To)
  await axios.post(
    'https://api.postmarkapp.com/email',
    {
      From: EMAIL_FROM,
      To: recipients.join(','), // Postmark accepts comma-separated list
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

// ------------------- Exported Runner -------------------
/**
 * Run the scanner.
 * @param {Object} [opts]
 * @param {string} [opts.postcode]              - Only scan this postcode.
 * @param {boolean} [opts.includeChildOnly]     - Override INCLUDE_CHILD_ONLY.
 * @param {string[]} [opts.overrideRecipients]  - Override recipients for testing.
 */
export async function runScan(opts = {}) {
  const includeChildOnlyOverride =
    typeof opts.includeChildOnly === 'boolean' ? opts.includeChildOnly : null;
  if (includeChildOnlyOverride !== null) {
    globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ = includeChildOnlyOverride;
  }

  console.log('Connecting to Mongo…');
  await mongoose.connect(MONGO_URI, { maxPoolSize: 10 });
  console.log('Mongo connected.');

  const query = { active: true };
  if (opts.postcode)
    query.postcode = normalizePostcode(opts.postcode);

  const jobs = await SearchArea.find(query).lean();
  if (!jobs.length) {
    console.log('No active SearchAreas.');
    await mongoose.disconnect();
    return { jobs: 0, summaries: [] };
  }

  const summaries = [];
  for (const job of jobs) {
    try {
      const found = await scanJob(job);
      await sendJobEmail(job, found, opts);
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

  await mongoose.disconnect();
  console.log('Done.');
  return { jobs: jobs.length, summaries };
}

// Default export for convenience
export default { runScan };

// Self-run when called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan().catch(async (e) => {
    console.error(e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
  });
}
