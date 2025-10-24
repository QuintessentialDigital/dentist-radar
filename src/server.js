import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'express-basic-auth';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { ensureDb, createWatch, listWatchesPublic, listWatchesAdmin, upsertUser, getUser, setPlan, markWelcomed } from './db.js';
import { sendWelcome } from './alerts.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const stripeSecret = process.env.STRIPE_SECRET || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    if (!stripe) return res.status(200).send();
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(200).send();
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const plan = session.metadata?.plan || 'pro';
      if (email) {
        if (plan === 'pro') setPlan(email, 'pro');
        if (plan === 'quick') setPlan(email, 'quick');
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[webhook error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
ensureDb();
app.use('/', express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => {
  const t = process.env.HEALTH_TOKEN || '';
  if (t && req.query.token !== t) return res.status(403).json({ ok: false });
  res.json({ ok: true, time: new Date().toISOString() });
});
const limiter = rateLimit({ windowMs: 60_000, max: 30 });
app.post('/api/watch', limiter, async (req, res) => {
  try {
    const { email, postcode, radius_miles = 10 } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    if (!postcode) return res.status(400).json({ ok: false, error: 'postcode required' });
    upsertUser(email);
    const pcs = String(postcode).split(',').map(s => s.trim()).filter(Boolean);
    const created = [];
    pcs.forEach(pc => {
      const row = createWatch(String(email).trim(), pc, Number(radius_miles));
      created.push({ id: row.id, postcode: row.postcode });
    });
    const u = getUser(email);
    if ((u?.welcomed|0) === 0) {
      try { await sendWelcome(String(email).trim()); markWelcomed(String(email).trim()); } catch {}
    }
    res.json({ ok: true, created, plan: u?.plan || 'free' });
  } catch (e) {
    console.error('POST /api/watch', e);
    res.status(500).json({ ok: false, error: 'failed' });
  }
});
app.get('/api/watches', (req, res) => {
  try { res.json({ items: listWatchesPublic() }); }
  catch (e) { res.status(500).json({ ok:false, error:'failed' }); }
});
const adminPass = process.env.ADMIN_PASSWORD || '';
const adminAuth = basicAuth({
  users: { admin: adminPass || 'unset' },
  challenge: true,
  unauthorizedResponse: 'Auth required'
});
app.get('/api/admin/watches', adminAuth, (req, res) => {
  try { res.json({ items: listWatchesAdmin() }); }
  catch (e) { res.status(500).json({ ok:false, error:'failed' }); }
});
app.post('/api/watch/:id/run', (req, res) => { res.json({ ok: true, result: { scanned: 0, alerts: 0 } }); });
app.post('/api/checkout/session', async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok:false, error:'Stripe not configured' });
    const { email, plan } = req.body || {};
    if (!email || !plan) return res.status(400).json({ ok:false, error:'email and plan required' });
    const price = plan === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_QUICK;
    const mode = plan === 'pro' ? 'subscription' : 'payment';
    const successUrl = process.env.STRIPE_SUCCESS_URL || ((process.env.PUBLIC_BASE_URL || '') + '/?success=1');
    const cancelUrl = process.env.STRIPE_CANCEL_URL || ((process.env.PUBLIC_BASE_URL || '') + '/pricing.html?canceled=1');
    const session = await (new Stripe(process.env.STRIPE_SECRET)).checkout.sessions.create({
      mode, line_items: [{ price, quantity: 1 }],
      customer_email: email, success_url: successUrl, cancel_url: cancelUrl,
      metadata: { plan }
    });
    res.json({ ok:true, url: session.url });
  } catch (e) {
    console.error('[checkout]', e);
    res.status(500).json({ ok:false, error:'stripe failed' });
  }
});
const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`[Dentist Radar] listening on :${port}`));
