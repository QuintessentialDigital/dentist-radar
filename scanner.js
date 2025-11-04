/**
 * DentistRadar — scanner.js (v2.4, Postmark-only, Watch-driven)
 * -------------------------------------------------------------
 * - Builds scan jobs from Watch collection (unique postcodes).
 * - For each job: finds Practices in radius, reads ONLY Appointments page,
 *   classifies ACCEPTING / CHILD_ONLY / NOT_CONFIRMED.
 * - Emails real users from Users (active+receiveAlerts; targeted or global).
 * - Postmark HTTP API only (no SMTP).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import axiosRetry from 'axios-retry';
import {
  connectMongo, disconnectMongo,
  Practice, EmailLog, User, Watch
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
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required');
if (!EMAIL_FROM) throw new Error('EMAIL_FROM is required');

const INCLUDE_CHILD =
  globalThis.__INCLUDE_CHILD_ONLY_OVERRIDE__ ??
  (String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true');
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);

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

/* =========================
   Acceptance parsing
   ========================= */
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
  if (acceptingAdults || genericAccepting) return { status: 'ACCEPTING', matched: 'accepting' };
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
        'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
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

async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;
  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // Prefer link by visible text
  let href = $('a').filter((_, el) =>
    normalizeText($(el).text()).toLowerCase().includes('appointment')
  ).first().attr('href');

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
      // global subscribers (no targeting fields present)
      { $and: [{ postcodes: { $exists: false } }, { areas: { $exists: false } }] },
      { $and: [{ postcodes: { $in: [null, [], undefined] } }, { areas: { $in: [null, [], undefined] } }] },
    ],
  }).select('email').lean();

  const emails = users.map(u => sanitizeEmail(u.email)).filter(Boolean);
  return [...new Set(emails)].slice(0, 5000);
}

/* =========================
   Job builder (Watch → jobs)
   ========================= */
async function buildJobsFromWatch(filterPostcode) {
  const match = filterPostcode ? { postcode: normalizePostcode(filterPostcode) } : {};

  // Group by postcode to get unique jobs; take first radius seen
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
   Core scan per job
   ========================= */
async function scanPostcodeJob({ postcode, radiusMiles }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  const practices = await Practice.find({
    distanceMiles: { $lte: radiusMiles },
    detailsUrl: { $exists: true, $ne: '' },
  }).select('_id name postcode detailsUrl distanceMiles').lean();

  if (!practices.length) {
    console.log('No practices found in radius.');
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(practices.map(p => limit(async () => {
    // De-dup per day per practice (no jobId since Watch-derived)
    const already = await EmailLog.findOne({ practiceId: p._id, dateKey }).lean();
    if (already) return;

    const apptHtml = await loadAppointmentsHtml(p.detailsUrl);
    if (!apptHtml) return;

    const verdict = classifyAcceptance(apptHtml);

    if (verdict.status === 'ACCEPTING') {
      accepting.push({
        id: p._id.toString(),
        name: p.name, postcode: p.postcode, url: p.detailsUrl, distanceMiles: p.distanceMiles,
      });
      await EmailLog.create({
        practiceId: p._id, practiceUrl: p.detailsUrl, status: 'ACCEPTING', dateKey,
      });
    } else if (verdict.status === 'CHILD_ONLY' && INCLUDE_CHILD) {
      childOnly.push({
        id: p._id.toString(),
        name: p.name, postcode: p.postcode, url: p.detailsUrl, distanceMiles: p.distanceMiles,
      });
      await EmailLog.create({
        practiceId: p._id, practiceUrl: p.detailsUrl, status: 'CHILD_ONLY', dateKey,
      });
    }
  })));

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
    found.accepting.sort((a,b)=>(a.distanceMiles||999)-(b.distanceMiles||999)).forEach((p,i)=>{
      lines.push(`${i+1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/><a href="${p.url}">${p.url}</a>`);
    });
    lines.push('<br/>');
  }
  if (hasChildOnly) {
    lines.push(`🟨 <b>Children-only</b> — ${found.childOnly.length}`);
    found.childOnly.sort((a,b)=>(a.distanceMiles||999)-(b.distanceMiles||999)).forEach((p,i)=>{
      lines.push(`${i+1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/><a href="${p.url}">${p.url}</a>`);
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
  return String(s || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
}

/* =========================
   Exported Runner (Watch-driven)
   ========================= */
/**
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

// Default export
export default { runScan };

// Self-run for CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(async () => { await disconnectMongo(); process.exit(0); })
    .catch(async (e) => { console.error(e); try { await disconnectMongo(); } catch {} process.exit(1); });
}
