/**
 * DentistRadar — scanner.js (clean & robust)
 * ---------------------------------------------------------
 * What it does
 * 1) Loads active postcode+radius jobs from MongoDB (SearchAreas)
 * 2) For each job, loads Practices pre-indexed for that postcode/radius
 *    (or with a geodoc that includes distanceMiles <= radiusMiles)
 * 3) For each practice, opens the DETAILS page, finds the Appointments link ONLY,
 *    then fetches the Appointments page and classifies acceptance status.
 * 4) Aggregates ACCEPTING hits (and, optionally, CHILD_ONLY) per job,
 *    de-dupes via EmailLog, and sends a single email per postcode job.
 *
 * Assumptions (adjust collection/field names to your DB if different):
 * - SearchAreas: { _id, postcode, radiusMiles, active: true }
 * - Practices:   {
 *      _id, name, postcode, detailsUrl, distanceMiles,
 *      // OPTIONAL geospatial fields if you prefer querying by location
 *   }
 * - EmailLog:    { _id, jobId, practiceId, practiceUrl, status, dateKey (YYYY-MM-DD), createdAt }
 *
 * ENV required:
 * - MONGO_URI="mongodb+srv://..."
 * - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * - EMAIL_FROM, EMAIL_TO  (comma-separated supported)
 * - INCLUDE_CHILD_ONLY="true"  (optional, default false)
 * - MAX_CONCURRENCY=5          (optional)
 *
 * Run:
 *  node scanner.js
 */

import mongoose from 'mongoose';
import axios from 'axios';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import axiosRetry from 'axios-retry';

// ----------------------- Config -----------------------
const {
  MONGO_URI,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  EMAIL_FROM,
  EMAIL_TO,
  INCLUDE_CHILD_ONLY = 'false',
  MAX_CONCURRENCY = '5',
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) throw new Error('SMTP config is required');
if (!EMAIL_FROM || !EMAIL_TO) throw new Error('EMAIL_FROM and EMAIL_TO are required');

const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true';
const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);

// Retry/backoff for NHS pages
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retry) => 1000 * Math.pow(2, retry) + Math.floor(Math.random() * 500),
  retryCondition: (err) => {
    const status = err?.response?.status;
    return !status || [429, 403, 500, 502, 503, 504].includes(status);
  },
});

// Rotate a few realistic desktop user-agents
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------- DB Models -----------------------
const SearchAreaSchema = new mongoose.Schema({
  postcode: { type: String, required: true },
  radiusMiles: { type: Number, required: true },
  active: { type: Boolean, default: true },
}, { collection: 'SearchAreas' });

const PracticeSchema = new mongoose.Schema({
  name: String,
  postcode: String,
  detailsUrl: String,        // e.g., https://www.nhs.uk/services/dentist/<slug>/<id>
  distanceMiles: Number,     // ensure this is filled when indexed for a postcode
}, { collection: 'Practices' });

const EmailLogSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, index: true },
  practiceId: { type: mongoose.Schema.Types.ObjectId, index: true },
  practiceUrl: String,
  status: { type: String, enum: ['ACCEPTING', 'CHILD_ONLY'] },
  dateKey: { type: String, index: true },  // YYYY-MM-DD
  createdAt: { type: Date, default: Date.now },
}, { collection: 'EmailLog' });

const SearchArea = mongoose.model('SearchArea', SearchAreaSchema);
const Practice = mongoose.model('Practice', PracticeSchema);
const EmailLog = mongoose.model('EmailLog', EmailLogSchema);

// ------------------- Email Transport --------------------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: Number(SMTP_PORT) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// ---------------- Acceptance Parsing --------------------
/**
 * Normalises text and classifies acceptance state.
 * Handles exact patterns the user provided + common wording drift.
 */
function classifyAcceptance(rawHtmlOrText) {
  const text = normalizeText(rawHtmlOrText);

  // Known/explicit patterns (exact or near-exact)
  const acceptingAdults =
    /currently accepts new nhs patients for routine dental care/i.test(text) &&
    /(adults|adults aged 18|adults entitled|children aged 17 or under)/i.test(text) &&
    !/only accepts.*children/i.test(text);

  const childOnlyExact =
    /currently only accepts new nhs patients for routine dental care.*children aged 17 or under/i.test(text);

  // Defensive fallbacks for minor copy tweaks
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

  if (notConfirmed) {
    return { status: 'NOT_CONFIRMED', matched: 'not-confirmed' };
  }

  // If we didn't match any known state, treat as NOT_CONFIRMED
  return { status: 'NOT_CONFIRMED', matched: 'unknown' };
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

// --------------- HTML helpers: Appointments tab ----------
/**
 * Given a practice details page URL, fetch it, find ONLY the "Appointments" link
 * and return the HTML of the appointments page. If not found, returns null.
 */
async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // Prefer tab link text that contains "appointments"
  let href = $('a')
    .filter((_, el) => {
      const t = normalizeText($(el).text()).toLowerCase();
      return t.includes('appointment');
    })
    .first()
    .attr('href');

  // Fallback: any anchor whose href includes '/appointments'
  if (!href) {
    href = $('a[href*="/appointments"]').first().attr('href');
  }

  if (!href) return null;

  // Resolve relative URLs
  const appointmentsUrl = new URL(href, detailsUrl).toString();

  // Polite delay between page hops
  await sleep(200 + Math.floor(Math.random() * 200));
  return httpGet(appointmentsUrl);
}

// --------------- HTTP with headers/retries ----------------
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
    console.error('[httpGet] Error', url, err?.response?.status || err?.message);
    return null;
  }
}

// ------------------- Core Scan Logic ---------------------
/**
 * Scans practices for one SearchArea job and returns results to email.
 */
async function scanJob(job) {
  const { _id: jobId, postcode, radiusMiles } = job;
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  // Get practices indexed within radius for this postcode.
  // Two options; keep whichever matches your DB shape:
  // A) Using precomputed distanceMiles field
  const practices = await Practice.find({
    distanceMiles: { $lte: radiusMiles },
    detailsUrl: { $exists: true, $ne: '' },
  })
    .select('_id name postcode detailsUrl distanceMiles')
    .lean();

  if (!practices.length) {
    console.log('No practices found in radius for this job.');
    return { accepting: [], childOnly: [] };
  }

  console.log(`Candidates: ${practices.length}`);

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(
    practices.map((p) =>
      limit(async () => {
        // Skip if already emailed today
        const already = await EmailLog.findOne({
          jobId, practiceId: p._id, dateKey,
        }).lean();
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

// ------------------- Email Composer ----------------------
async function sendJobEmail(job, found) {
  const recipients = EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return;

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
        lines.push(`${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/>` +
                   `<a href="${p.url}">${p.url}</a>`);
      });
    lines.push('<br/>');
  }

  if (hasChildOnly) {
    lines.push(`🟨 <b>Children-only</b> — ${found.childOnly.length}`);
    found.childOnly
      .sort((a, b) => (a.distanceMiles || 999) - (b.distanceMiles || 999))
      .forEach((p, i) => {
        lines.push(`${i + 1}. ${escapeHtml(p.name)} — ${p.postcode} — ${p.distanceMiles?.toFixed?.(1) ?? '?'} mi<br/>` +
                   `<a href="${p.url}">${p.url}</a>`);
      });
    lines.push('<br/>');
  }

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;">
      <h2 style="margin:0 0 8px">DentistRadar – ${escapeHtml(job.postcode)} (${job.radiusMiles} mi)</h2>
      <div style="color:#444;margin:0 0 12px">Date: ${dayjs().format('YYYY-MM-DD HH:mm')}</div>
      ${lines.join('\n')}
      <hr style="margin:16px 0;border:0;border-top:1px solid #e5e5e5">
      <div style="font-size:12px;color:#777">This email only includes practices verified on the Appointments page.</div>
    </div>
  `;

  const subject = `DentistRadar: ${job.postcode} (${job.radiusMiles} mi) — ${found.accepting.length} accepting${INCLUDE_CHILD ? `, ${found.childOnly.length} child-only` : ''}`;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: recipients,
    subject,
    html,
  });

  console.log(`Email sent: ${subject}`);
}

function escapeHtml(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ------------------- Runner ------------------------------
async function main() {
  console.log('Connecting to Mongo…');
  await mongoose.connect(MONGO_URI, { maxPoolSize: 10 });
  console.log('Mongo connected.');

  const jobs = await SearchArea.find({ active: true }).lean();
  if (!jobs.length) {
    console.log('No active SearchAreas. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  for (const job of jobs) {
    try {
      const found = await scanJob(job);
      await sendJobEmail(job, found);
    } catch (err) {
      console.error(`Job failed for ${job.postcode}`, err);
    }
    // polite pause between jobs to avoid spikes
    await sleep(800 + Math.floor(Math.random() * 700));
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
