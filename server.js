import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import path from 'path';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Env
const MONGO_URI      = process.env.MONGO_URI;
const DB_NAME        = process.env.DB_NAME || 'dentistradar';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || '';
const MAIL_FROM      = process.env.MAIL_FROM || 'alerts@dentistradar.co.uk';

const STRIPE_SECRET  = process.env.STRIPE_SECRET || ''; // sk_live_... or sk_test_...
const PRICE_PRO      = process.env.PRICE_PRO || '';     // price_xxx (subscription)
const PRICE_FAMILY   = process.env.PRICE_FAMILY || '';  // price_xxx (subscription)
const APP_DOMAIN     = process.env.APP_DOMAIN || '';    // e.g. https://www.dentistradar.co.uk

if (!MONGO_URI) throw new Error('Missing MONGO_URI in environment');

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET, { apiVersion: '2023-10-16' }) : null;

// DB
let client, db, watches, alerts;
async function initDb() {
  client = new MongoClient(MONGO_URI, { connectTimeoutMS: 15000 });
  await client.connect();
  db = client.db(DB_NAME);

  watches = db.collection('watches');
  await watches.createIndex({ email: 1, postcode: 1 }, { unique: true });
  await watches.createIndex({ email: 1 });
  await watches.createIndex({ createdAt: -1 });

  alerts = db.collection('alerts');
  await alerts.createIndex({ createdAt: -1 });

  console.log('✅ MongoDB connected');
}
initDb().catch(err => { console.error('Mongo init error:', err); process.exit(1); });

// Helpers
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = s => String(s||'').trim().toLowerCase();

function normalizePostcode(raw = '') {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 5) return raw.toUpperCase().trim();
  const head = t.slice(0, t.length - 3), tail = t.slice(-3);
  return `${head} ${tail}`.replace(/\s+/g, ' ').trim();
}
function looksLikeUkPostcode(pc) {
  return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test((pc || '').toUpperCase());
}
function isAdmin(pwd) { return pwd && pwd === ADMIN_PASSWORD; }

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN) return { ok: false, skipped: true, reason: 'no_postmark_token' };
  try {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': POSTMARK_TOKEN
      },
      body: JSON.stringify({ From: MAIL_FROM, To: to, Subject: subject, TextBody: text })
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error('Email send error:', e);
    return { ok: false, error: e.message };
  }
}

// Health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Create Watch (max radius 30, duplicate & upgrade messaging)
app.post('/api/watch/create', async (req, res) => {
  try {
    const emailKey = normEmail(req.body?.email);
    const pc = normalizePostcode(req.body?.postcode || '');
    let rNum = Number(req.body?.radius);

    if (!emailRe.test(emailKey)) return res.status(400).json({ ok:false, error:'invalid_email' });
    if (!looksLikeUkPostcode(pc)) return res.status(400).json({ ok:false, error:'invalid_postcode' });
    if (isNaN(rNum)) rNum = 0;
    const r = Math.max(1, Math.min(30, rNum));
    if (!(r >= 1 && r <= 30)) return res.status(400).json({ ok:false, error:'invalid_radius' });

    const dup = await watches.findOne({ email: emailKey, postcode: pc });
    if (dup) {
      return res.status(400).json({
        ok: false, error: 'duplicate',
        msg: 'An alert already exists for this postcode.'
      });
    }

    const existingCount = await watches.countDocuments({ email: emailKey });
    if (existingCount >= 1) {
      return res.status(402).json({
        ok: false, error: 'upgrade_required',
        message: 'Free plan supports one postcode. Upgrade to Pro to add more alerts.',
        upgradeLink: '/pricing.html'
      });
    }

    await watches.insertOne({ email: emailKey, postcode: pc, radius: r, createdAt: new Date() });

    const subject = `Dentist Radar — alerts enabled for ${pc}`;
    const body = [
      `Thanks for joining Dentist Radar!`,
      ``,
      `We'll email you when NHS dentists within ${r} miles of ${pc} start accepting patients.`,
      ``,
      `You can remove or update your alert anytime.`,
      ``,
      `— Dentist Radar`
    ].join('\n');
    const mail = await sendEmail(emailKey, subject, body);
    try {
      await alerts.insertOne({
        kind: 'welcome', email: emailKey, postcode: pc, radius: r,
        status: mail?.ok ? 'sent' : 'skipped_or_failed', provider: 'postmark', createdAt: new Date()
      });
    } catch {}

    return res.json({ ok:true, msg:'✅ Alert created — check your inbox.' });
  } catch (err) {
    console.error('Create watch error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// Admin lists
app.post('/api/admin/watches', async (req,res)=>{
  const { password } = req.body || {};
  if (!isAdmin(password)) return res.status(403).json({ ok:false, error:'forbidden' });
  const items = await watches.find().sort({ createdAt:-1 }).limit(300).toArray();
  res.json({ ok:true, items });
});
app.post('/api/admin/alerts', async (req,res)=>{
  const { password } = req.body || {};
  if (!isAdmin(password)) return res.status(403).json({ ok:false, error:'forbidden' });
  const items = await alerts.find().sort({ createdAt:-1 }).limit(300).toArray();
  res.json({ ok:true, items });
});

// Stripe Checkout: create session for Pro/Family
app.post('/api/billing/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok:false, error:'stripe_not_configured' });
    const { plan, email } = req.body || {};
    const priceId = plan === 'family' ? PRICE_FAMILY : PRICE_PRO;

    if (!priceId) return res.status(400).json({ ok:false, error:'missing_price' });

    const successUrl = (APP_DOMAIN || `${req.protocol}://${req.get('host')}`) + '/pricing.html?status=success';
    const cancelUrl  = (APP_DOMAIN || `${req.protocol}://${req.get('host')}`) + '/pricing.html?status=cancel';

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: email && emailRe.test(email) ? email : undefined,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      metadata: { plan: plan || 'pro' }
    });

    res.json({ ok:true, url: session.url });
  } catch (err) {
    console.error('Stripe session error:', err);
    res.status(500).json({ ok:false, error:'stripe_error' });
  }
});

// Static pages
const pub = p => path.join(__dirname, 'public', p);
app.get('/pricing', (req,res)=>res.sendFile(pub('pricing.html')));
app.get('/about',   (req,res)=>res.sendFile(pub('about.html')));
app.get('/terms',   (req,res)=>res.sendFile(pub('terms.html')));
app.get('/privacy', (req,res)=>res.sendFile(pub('privacy.html')));
app.get('/admin',   (req,res)=>res.sendFile(pub('admin.html')));

// Catch-all for non-API GET → home
app.get('*', (req,res)=>{
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok:false, error:'not_found' });
  res.sendFile(pub('index.html'));
});

// Start
app.listen(PORT, ()=> console.log(`🚀 Dentist Radar running on port ${PORT}`));
