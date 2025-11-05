/**
 * DentistRadar — scanner.js (DB-first, v1.9-compat with new acceptance logic)
 * Flow:
 *   Watch → Practices from Mongo (within radius) → Appointments page → classify → email Watchers
 *
 * ENV (required):
 *   MONGO_URI
 *   POSTMARK_SERVER_TOKEN
 *   EMAIL_FROM  e.g., "DentistRadar <alerts@yourdomain.com>"
 *
 * ENV (optional):
 *   POSTMARK_MESSAGE_STREAM="outbound"
 *   MAX_CONCURRENCY="5"
 *   INCLUDE_CHILD_ONLY="false"     // include children-only in emails
 *   DEBUG_APPTS="0|1"
 *   POSTCODE_COORDS="RG41 4UW:51.411,-0.864;SW1A 1AA:51.501,-0.142"
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import dayjs from 'dayjs';
import axiosRetry from 'axios-retry';
import mongoose from 'mongoose';

/* ─────────────────────────
   Config / ENV
   ───────────────────────── */
const {
  MONGO_URI,
  POSTMARK_SERVER_TOKEN,
  EMAIL_FROM,
  POSTMARK_MESSAGE_STREAM = 'outbound',
  MAX_CONCURRENCY = '5',
  INCLUDE_CHILD_ONLY = 'false',
  DEBUG_APPTS = '0',
  POSTCODE_COORDS = ''
} = process.env;

if (!MONGO_URI) throw new Error('MONGO_URI is required');
if (!POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN is required');
if (!EMAIL_FROM) throw new Error('EMAIL_FROM is required');

const CONCURRENCY = Math.max(1, Number(MAX_CONCURRENCY) || 5);
const INCLUDE_CHILD = String(INCLUDE_CHILD_ONLY).toLowerCase() === 'true';
const DEBUG = String(DEBUG_APPTS) === '1';

/* ─────────────────────────
   Mongo models (guarded)
   ───────────────────────── */
function getModel(name, schema) { return mongoose.models[name] || mongoose.model(name, schema); }

const WatchSchema = new mongoose.Schema(
  { email: String, postcode: String, radius: Number },
  { collection: 'Watch', timestamps: true, versionKey: false }
);
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const EmailLogSchema = new mongoose.Schema(
  {
    practiceId: mongoose.Schema.Types.Mixed, // ObjectId or string
    dateKey: String,                         // YYYY-MM-DD
    status: { type: String, enum: ['ACCEPTING','CHILD_ONLY','WELCOME','OTHER'] },
    to: String,
    subject: String,
    providerId: String,
    sentAt: { type: Date, default: Date.now }
  },
  { collection: 'EmailLog', versionKey: false }
);
EmailLogSchema.index({ practiceId: 1, dateKey: 1 }, { unique: true });

const PracticeSchema = new mongoose.Schema(
  {
    name: String,
    postcode: String,
    lat: Number,
    lon: Number,
    detailsUrl: String,   // preferred
    nhsUrl: String,       // legacy field
    url: String,          // fallback
  },
  { collection: 'Practices', versionKey: false }
);

const PostcodeSchema = new mongoose.Schema(
  { postcode: { type: String, unique: true, index: true }, lat: Number, lon: Number },
  { collection: 'Postcodes', versionKey: false }
);

const Watch     = getModel('Watch', WatchSchema);
const EmailLog  = getModel('EmailLog', EmailLogSchema);
const Practice  = getModel('Practice', PracticeSchema);
const Postcode  = getModel('Postcode', PostcodeSchema);

let connectingPromise = null;
async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = mongoose.connect(uri, { maxPoolSize: 10 }).finally(() => { connectingPromise = null; });
  return connectingPromise;
}

/* ─────────────────────────
   HTTP
   ───────────────────────── */
axiosRetry(axios, {
  retries: 3,
  retryDelay: (n) => 700 * n + Math.floor(Math.random()*300),
  retryCondition: (e) => {
    const s = e?.response?.status;
    return !s || [429,403,408,500,502,503,504].includes(s);
  }
});
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
];
async function httpGet(url) {
  try {
    const ua = UAS[Math.floor(Math.random()*UAS.length)];
    const { data, status } = await axios.get(url, {
      headers: { 'User-Agent': ua, 'Accept-Language': 'en-GB,en;q=0.9' },
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 400
    });
    if (status >= 300) return null;
    return data;
  } catch (e) {
    console.error('[GET]', url, e?.response?.status || e?.message);
    return null;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ─────────────────────────
   Utils
   ───────────────────────── */
const normText = (s) => String(s||'').replace(/\s+/g,' ').replace(/[\u200B-\u200D\uFEFF]/g,'').trim();
const normPc   = (pc) => String(pc||'').toUpperCase().replace(/\s+/g,' ').trim();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||'').trim());

function parsePostcodeCoordsEnv(raw) {
  const map = new Map();
  String(raw || '').split(';').map(s => s.trim()).filter(Boolean).forEach(pair => {
    const [pcRaw, coords] = pair.split(':').map(s => (s || '').trim());
    if (!pcRaw || !coords) return;
    const [latStr, lonStr] = coords.split(',').map(s => (s || '').trim());
    const lat = Number(latStr), lon = Number(lonStr);
    if (Number.isFinite(lat) && Number.isFinite(lon)) map.set(normPc(pcRaw), { lat, lon });
  });
  return map;
}
const POSTCODE_COORDS_MAP = parsePostcodeCoordsEnv(POSTCODE_COORDS);

async function coordsForPostcode(pcRaw) {
  const pc = normPc(pcRaw);
  if (!pc) return null;
  if (POSTCODE_COORDS_MAP.has(pc)) return POSTCODE_COORDS_MAP.get(pc);
  const doc = await Postcode.findOne({ postcode: pc }).select('lat lon').lean();
  if (!doc) return null;
  return { lat: doc.lat, lon: doc.lon };
}

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

/* ─────────────────────────
   Watch → jobs
   ───────────────────────── */
async function buildJobs(filterPostcode) {
  const match = filterPostcode ? { postcode: normPc(filterPostcode) } : {};
  const rows = await Watch.aggregate([
    { $match: match },
    { $group: { _id: '$postcode', radius: { $first: '$radius' }, emails: { $addToSet: '$email' } } },
    { $project: { _id: 0, postcode: '$_id', radius: 1, emails: 1 } }
  ]);
  return rows.map(r => ({
    postcode: normPc(r.postcode),
    radiusMiles: Math.max(1, Math.min(30, Number(r.radius) || 10)),
    recipients: (r.emails || []).filter(validEmail)
  }));
}

/* ─────────────────────────
   Practices in radius (DB)
   ───────────────────────── */
async function findPracticesInRadius(centerPc, radiusMiles) {
  const centre = await coordsForPostcode(centerPc);
  if (!centre) {
    console.log('[WARN] No coords for job postcode', centerPc);
    return [];
  }

  // Pull only practices that have a URL we can try
  let practices = await Practice.find({
    $or: [
      { detailsUrl: { $exists: true, $ne: '' } },
      { nhsUrl:     { $exists: true, $ne: '' } },
      { url:        { $exists: true, $ne: '' } },
    ]
  }).select('_id name postcode lat lon detailsUrl nhsUrl url').lean();

  const out = [];
  for (const p of practices) {
    let lat = p.lat, lon = p.lon;

    // If practice has postcode but missing coords, resolve from Postcodes
    if ((lat == null || lon == null) && p.postcode) {
      const pc = await coordsForPostcode(p.postcode);
      if (pc) { lat = pc.lat; lon = pc.lon; }
    }

    // Compute distance (skip if unknown)
    let distance = Infinity;
    if (lat != null && lon != null) {
      distance = haversineMiles(centre.lat, centre.lon, lat, lon);
    }

    if (distance <= radiusMiles) {
      out.push({
        _id: p._id,
        name: p.name || '',
        postcode: p.postcode || '',
        url: p.detailsUrl || p.nhsUrl || p.url || '',
        distanceMiles: distance
      });
    }
  }

  // sort nearest first
  out.sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999));
  return out;
}

/* ─────────────────────────
   Appointments page loader (details → appointments)
   ───────────────────────── */
async function loadAppointmentsHtml(detailsUrl) {
  if (!detailsUrl) return null;

  if (/\/appointments(\/|$|\?|#)/i.test(detailsUrl)) {
    return httpGet(detailsUrl);
  }

  const detailsHtml = await httpGet(detailsUrl);
  if (!detailsHtml) return null;

  const $ = cheerio.load(detailsHtml);

  // a) by link text
  const labels = ['appointments','appointments and opening times','appointments & opening times','opening times'];
  let href;
  $('a').each((_, el) => {
    const t = normText($(el).text()).toLowerCase();
    if (labels.some(l => t.includes(l))) { href = $(el).attr('href'); if (href) return false; }
  });

  // b) by href pattern
  if (!href) href = $('a[href*="/appointments"]').first().attr('href');
  if (!href) href = $('a[href*="appointments-and-opening-times"]').first().attr('href');
  if (!href) href = $('a[href*="opening-times"]').first().attr('href');

  if (!href) {
    // try `${details}/appointments`
    try {
      const fallback = new URL('appointments', detailsUrl).toString();
      const html = await httpGet(fallback);
      if (html) return html;
    } catch(_) {}

    // no dedicated page → scan details page itself
    return { __inline__: true, html: detailsHtml };
  }

  const apptUrl = new URL(href, detailsUrl).toString();
  return httpGet(apptUrl);
}

/* ─────────────────────────
   Extract & classify (NEW acceptance logic)
   ───────────────────────── */
function extractAppointmentsText(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  // sections under headings
  $('h1,h2,h3').each((_, h) => {
    const heading = normText($(h).text()).toLowerCase();
    if (/appointment|opening\s+times/.test(heading)) {
      const section = [];
      let cur = $(h).next(); let hops = 0;
      while (cur.length && hops < 20) {
        const tag = (cur[0].tagName || '').toLowerCase();
        if (/^h[1-6]$/.test(tag)) break;
        if (['p','div','li','ul','ol'].includes(tag)) section.push(normText(cur.text()));
        cur = cur.next(); hops++;
      }
      const joined = section.join(' ').trim();
      if (joined) candidates.push(joined);
    }
  });

  // broader wrappers
  const wrappers = ['main','.nhsuk-main-wrapper','#content','#maincontent','.nhsuk-u-reading-width','.nhsuk-width-container'];
  for (const sel of wrappers) {
    const t = normText($(sel).text());
    if (t && t.length > 80) candidates.push(t);
  }

  // inset/notice
  const notices = ['.nhsuk-inset-text','.nhsuk-warning-callout','.nhsuk-notification-banner__content','.nhsuk-panel'];
  for (const sel of notices) {
    $(sel).each((_, el) => { const t = normText($(el).text()); if (t) candidates.push(t); });
  }

  if (!candidates.length) candidates.push(normText($.root().text()));
  candidates.sort((a,b)=> b.length - a.length);
  return candidates[0] || '';
}

// Your canonical messages + near variants
function classifyAcceptance(raw) {
  const t = normText(String(raw||'')).replace(/’/g,"'");

  const childOnly =
    (
      /(only\s+accepts?|currently\s+only\s+accepts?|accepting\s+only)\s+(new\s+)?nhs\s+patients/i.test(t) &&
      /children\s+(aged\s+17\s+or\s+under|only|under\s*18)/i.test(t)
    ) ||
    /this dentist currently only accepts? new nhs patients.*children\s+aged\s+17\s+or\s+under/i.test(t);

  const accepting =
    /this dentist currently accepts? new nhs patients/i.test(t) ||
    (/(accepts|is accepting|are accepting|currently accepting)\s+(new\s+)?nhs\s+patients/i.test(t) && !childOnly);

  const notConfirmed =
    /this dentist has not confirmed if they currently accept new nhs patients/i.test(t) ||
    /has\s+not\s+confirmed\s+if\s+.*accept/i.test(t);

  if (childOnly)    return { status: 'CHILD_ONLY' };
  if (accepting)    return { status: 'ACCEPTING' };
  if (notConfirmed) return { status: 'NOT_CONFIRMED' };
  return { status: 'NOT_CONFIRMED' };
}

/* ─────────────────────────
   Email via Postmark
   ───────────────────────── */
async function sendEmail(toList, subject, html) {
  if (!toList?.length) return;
  try {
    await axios.post('https://api.postmarkapp.com/email',
      { From: EMAIL_FROM, To: toList.join(','), Subject: subject, HtmlBody: html, MessageStream: POSTMARK_MESSAGE_STREAM },
      { headers: { 'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN, 'Accept': 'application/json', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log(`Email sent → ${toList.length} recipient(s): ${subject}`);
  } catch (e) {
    console.error('Postmark send error:', e?.response?.data || e?.message);
  }
}

/* ─────────────────────────
   Scan one postcode job (DB-first)
   ───────────────────────── */
async function scanJob({ postcode, radiusMiles, recipients }) {
  console.log(`\n--- Scan: ${postcode} (${radiusMiles} miles) — DB-first ---`);

  const practices = await findPracticesInRadius(postcode, radiusMiles);
  if (!practices.length) {
    console.log('[INFO] No practices with URLs found in radius.');
    return { accepting: [], childOnly: [] };
  }

  const limit = pLimit(CONCURRENCY);
  const dateKey = dayjs().format('YYYY-MM-DD');

  const accepting = [];
  const childOnly = [];

  await Promise.all(practices.map((p) => limit(async () => {
    const pid = p._id?.toString?.() || String(p._id);
    if (!p.url) return;

    // de-dup per practice per day
    const exists = await EmailLog.findOne({ practiceId: pid, dateKey }).lean();
    if (exists) return;

    const apptRes = await loadAppointmentsHtml(p.url);
    if (!apptRes) return;

    const html = typeof apptRes === 'string' ? apptRes : (apptRes && apptRes.__inline__ && apptRes.html) ? apptRes.html : '';
    if (!html) return;

    const section = extractAppointmentsText(html);
    const verdict = classifyAcceptance(section);

    if (verdict.status === 'ACCEPTING') {
      accepting.push(p);
      await EmailLog.create({ practiceId: pid, dateKey, status: 'ACCEPTING' });
    } else if (verdict.status === 'CHILD_ONLY' && INCLUDE_CHILD) {
      childOnly.push(p);
      await EmailLog.create({ practiceId: pid, dateKey, status: 'CHILD_ONLY' });
    } else if (DEBUG) {
      console.log('[DEBUG NO-MATCH]', p.url, '→', section.slice(0, 300));
    }
  })));

  // email Watch recipients for THIS postcode
  if (recipients?.length && (accepting.length || childOnly.length)) {
    const lines = [];
    const render = (arr, label) => {
      lines.push(`<b>${label}</b> — ${arr.length}<br>`);
      arr.sort((a,b)=> (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
         .forEach((x,i)=> lines.push(`${i+1}. ${x.name || 'Dental practice'} — ${x.postcode || ''} — ${x.distanceMiles?.toFixed?.(1) ?? '?'} mi — <a href="${x.url}">${x.url}</a><br>`));
      lines.push('<br>');
    };
    if (accepting.length) render(accepting, 'Accepting (adults/all)');
    if (childOnly.length) render(childOnly, 'Children-only');

    const subject = `DentistRadar: ${postcode} (${radiusMiles} mi) — ${accepting.length} accepting${INCLUDE_CHILD ? `, ${childOnly.length} child-only` : ''}`;
    const body = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial">
        <h3 style="margin:0 0 8px">DentistRadar – ${postcode} (${radiusMiles} mi)</h3>
        <div style="color:#666;margin:0 0 10px">${dayjs().format('YYYY-MM-DD HH:mm')}</div>
        ${lines.join('\n')}
        <hr style="border:0;border-top:1px solid #eee;margin:12px 0">
        <div style="font-size:12px;color:#777">We scan the <b>Appointments</b> page only. Please call the practice to confirm before travelling.</div>
      </div>
    `;
    await sendEmail(recipients, subject, body);
  } else {
    if (!recipients?.length) console.log('No recipients for this postcode; skipping email.');
    else console.log('No accepting/children-only results; no email sent.');
  }

  return { accepting, childOnly };
}

/* ─────────────────────────
   Exported runner (keeps server.js contract)
   ───────────────────────── */
export async function runScan(opts = {}) {
  await connectMongo(MONGO_URI);
  const jobs = await buildJobs(opts.postcode);
  if (!jobs.length) {
    console.log('[RESULT] No Watch entries.');
    return { jobs: 0, summaries: [] };
  }

  const summaries = [];
  for (const job of jobs) {
    const res = await scanJob(job);
    summaries.push({
      postcode: job.postcode,
      radiusMiles: job.radiusMiles,
      accepting: res.accepting.length,
      childOnly: res.childOnly.length
    });
    await sleep(300);
  }

  console.log('[DONE]', summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan().then(()=>process.exit(0)).catch((e)=>{ console.error(e); process.exit(1); });
}
