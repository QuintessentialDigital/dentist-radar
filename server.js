// server.js — Dentist Radar v1.6.5
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || '';
const DB_NAME = process.env.DB_NAME || 'dentist_radar';
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'alerts@dentistradar.co.uk';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

if (!MONGO_URI) { console.error('Missing MONGO_URI in environment'); process.exit(1); }

let client, db, watches;
async function initDb() {
  client = new MongoClient(MONGO_URI, { connectTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);
  watches = db.collection('watches');
  await watches.createIndex({ email: 1, postcode: 1 }, { unique: true });
  await watches.createIndex({ email: 1 });
  await watches.createIndex({ createdAt: -1 });
}
await initDb().catch(err => { console.error('DB connect error:', err); process.exit(1); });

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;
function normalizePostcode(pc = '') {
  const t = pc.toUpperCase().replace(/\s+/g, '');
  const m = t.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  if (!m) return null;
  return `${m[1]} ${m[2]}`.toUpperCase();
}

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.warn('Email skipped: postmark not configured.');
    return { ok: false, skipped: true };
  }
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': POSTMARK_TOKEN
    },
    body: JSON.stringify({ From: FROM_EMAIL, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound' })
  }).catch(e => ({ ok: false, error: e.message }));
  try {
    if (res?.ok) return { ok: true };
    const j = await res.json().catch(()=>null);
    return { ok: false, error: j?.Message || 'email_failed' };
  } catch { return { ok: false, error: 'email_failed' }; }
}

function welcomeEmailBody({ postcode, radius }) {
  return [
    `You're set. We’ll alert you when NHS dentists open near ${postcode}.`,
    '', `Radius: ${radius} mile(s)`,
    '', 'Tip: Please call the practice to confirm availability before travelling.',
    '', '— Dentist Radar'
  ].join('\n');
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

// Static assets (serve HTML files from /public)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Health
app.get('/api/health', async (req, res) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true, db: true, time: new Date().toISOString() }); }
  catch { res.status(500).json({ ok: false, db: false }); }
});

// Create watch
app.post('/api/watch/create', async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};
    if (!emailRe.test(email || '')) return res.status(400).json({ ok: false, error: 'invalid_email' });

    const pc = normalizePostcode(postcode);
    if (!pc) return res.status(400).json({ ok: false, error: 'invalid_postcode' });

    const r = Math.max(1, Math.min(50, Number(radius || 5) || 5));
    const emailKey = email.toLowerCase();

    const existingCount = await watches.countDocuments({ email: emailKey });
    const exists = await watches.findOne({ email: emailKey, postcode: pc });
    if (exists) return res.json({ ok: true, msg: 'You already have this alert.' });
    if (existingCount >= 1) {
      return res.status(402).json({ ok: false, error: 'upgrade_required', message: 'Free plan supports 1 postcode. Upgrade for more.' });
    }

    await watches.insertOne({ email: emailKey, postcode: pc, radius: r, createdAt: new Date(), source: 'web' });
    sendEmail(email, `Dentist Radar — alerts enabled for ${pc}`, welcomeEmailBody({ postcode: pc, radius: r })).catch(()=>null);

    return res.json({ ok: true, msg: 'Alert created — check your inbox.' });
  } catch (e) {
    console.error('create error:', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// List watches
app.get('/api/watches', async (req, res) => {
  try {
    const email = (req.query.email || '').toString().toLowerCase().trim();
    const q = email ? { email } : {};
    const items = await watches.find(q).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ ok: true, items });
  } catch { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// Admin endpoints
function isAdmin(pw) { return ADMIN_PASSWORD && pw && pw === ADMIN_PASSWORD; }

app.post('/api/admin/list', async (req, res) => {
  const { password } = req.body || {};
  if (!isAdmin(password)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const items = await watches.find({}).sort({ createdAt: -1 }).limit(300).toArray();
  res.json({ ok: true, items });
});

app.post('/api/admin/test-email', async (req, res) => {
  const { password, to } = req.body || {};
  if (!isAdmin(password)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const r = await sendEmail(to, 'Dentist Radar — test email', 'This is a test email from Dentist Radar Admin.');
  if (r.ok) return res.json({ ok: true });
  res.status(500).json({ ok: false, error: r.error || 'email_failed' });
});

// ----- Explicit admin page routes (fix redirect to home) -----
app.get('/admin', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/admin.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);

// SPA fallback for other unknown routes
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => console.log('Dentist Radar listening on', PORT));
