import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import fetch from 'node-fetch';
import Stripe from 'stripe';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(morgan('tiny'));

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || '';
const DB_NAME = process.env.DB_NAME || 'dentist_radar';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCAN_TOKEN = process.env.SCAN_TOKEN || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'alerts@dentistradar.co.uk';
const POSTMARK_STREAM = process.env.POSTMARK_STREAM || 'outbound';

// Stripe (optional)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO || '';       // e.g. price_…
const STRIPE_PRICE_FAMILY = process.env.STRIPE_PRICE_FAMILY || ''; // e.g. price_…
const STRIPE_SUCCESS_URL = (process.env.STRIPE_SUCCESS_URL || `${PUBLIC_ORIGIN}/success.html`) || '';
const STRIPE_CANCEL_URL = (process.env.STRIPE_CANCEL_URL || `${PUBLIC_ORIGIN}/cancel.html`) || '';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!MONGO_URI) console.warn('⚠️  MONGO_URI missing — DB writes will fail');

// ---------- DB ----------
let db, alertsCol, usersCol;
if (MONGO_URI) {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  alertsCol = db.collection('alerts');
  usersCol = db.collection('users');

  await alertsCol.createIndex({ email: 1, postcode: 1 }, { unique: true });
  await usersCol.createIndex({ email: 1 }, { unique: true });

  console.log('✅ Mongo connected');
}

// ---------- Helpers ----------
function normEmail(v = '') { return String(v).trim().toLowerCase(); }
function normPostcode(v = '') { return String(v).trim().toUpperCase().replace(/\s+/g, ''); }
function validateEmail(e = '') { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
function validateUKPostcode(pc = '') {
  const v = String(pc).trim().toUpperCase();
  const re = /^(GIR ?0AA|(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}))$/i;
  return re.test(v);
}

async function ensureUser(email) {
  if (!usersCol) return;
  const e = normEmail(email);
  await usersCol.updateOne(
    { email: e },
    { $setOnInsert: { email: e, plan: 'free', created: new Date() } },
    { upsert: true }
  );
}

// Email helpers
async function sendEmail({ to, subject, text }) {
  if (!POSTMARK_TOKEN) { console.log('[email] skipped (no POSTMARK_TOKEN)'); return; }
  try {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Postmark-Server-Token': POSTMARK_TOKEN },
      body: JSON.stringify({
        From: FROM_EMAIL,
        To: to,
        Subject: subject,
        TextBody: text,
        MessageStream: POSTMARK_STREAM
      })
    });
    console.log('[email] status', r.status);
  } catch (e) {
    console.error('[email] error', e);
  }
}

function welcomeEmail({ postcode, radius }) {
  return [
    'Thanks — your alert is active.',
    '',
    'We’ll email you when a nearby NHS practice starts accepting new patients.',
    `Postcode: ${postcode}`,
    `Radius: ${radius} miles`,
    '',
    'Please call the practice to confirm availability before travelling.',
    '',
    '— Dentist Radar'
  ].join('\n');
}

// ---------- Routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Create alert (Free plan = 1 postcode total)
app.post('/api/watch/create', async (req, res) => {
  try {
    if (!alertsCol) return res.status(500).json({ ok: false, error: 'db_unavailable' });

    const { email, postcode, radius = 5 } = req.body || {};
    const e = normEmail(email);
    const pc = normPostcode(postcode);
    const r = Number(radius) || 5;

    if (!validateEmail(e)) return res.status(400).json({ ok: false, error: 'invalid_email' });
    if (!validateUKPostcode(pc)) return res.status(400).json({ ok: false, error: 'invalid_postcode' });

    await ensureUser(e);

    // already have this exact alert?
    const dup = await alertsCol.findOne({ email: e, postcode: pc });
    if (dup) return res.json({ ok: true, msg: 'Alert already exists' });

    // enforce Free = 1 postcode
    const existingCount = await alertsCol.countDocuments({ email: e });
    if (existingCount >= 1) {
      return res.status(402).json({
        ok: false,
        error: 'upgrade_required',
        message: 'Free plan supports 1 postcode. Upgrade'
      });
    }

    await alertsCol.insertOne({ email: e, postcode: pc, radius: r, plan: 'free', created: new Date() });

    // welcome email (best-effort)
    sendEmail({
      to: e,
      subject: 'Dentist Radar — Alert created',
      text: welcomeEmail({ postcode: pc, radius: r })
    });

    res.json({ ok: true, msg: 'Alert created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Simple Postmark test
app.get('/api/test-email', async (req, res) => {
  const to = (req.query.to || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'add ?to=email@example.com' });
  await sendEmail({ to, subject: 'Dentist Radar — test', text: 'Hello from Dentist Radar (test).' });
  res.json({ ok: true });
});

// Stripe checkout (optional; safe fallback)
async function createCheckout(res, priceId, customerEmail) {
  if (!stripe || !priceId || !STRIPE_SUCCESS_URL || !STRIPE_CANCEL_URL) {
    return res.status(501).json({ ok: false, error: 'stripe_not_configured' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      customer_email: customerEmail || undefined,
      allow_promotion_codes: true
    });
    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[stripe] error', e);
    return res.status(500).json({ ok: false, error: 'stripe_error' });
  }
}

app.post('/api/checkout/pro', async (req, res) => {
  const email = (req.body?.email || '').trim();
  return createCheckout(res, STRIPE_PRICE_PRO, email);
});

app.post('/api/checkout/family', async (req, res) => {
  const email = (req.body?.email || '').trim();
  return createCheckout(res, STRIPE_PRICE_FAMILY, email);
});

// Catch-all
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Dentist Radar running on ${PORT}`));
