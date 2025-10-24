import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'express-basic-auth';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';

import { ensureDb, upsertUser, createWatch, listWatchesPublic, listWatchesAdmin, getUserByEmail, setPlan, setQuickUntil, setWelcomed } from './db.js';
import { runScan } from './service.js';
import { startScheduler } from './scheduler.js';
import { sendWelcome } from './alerts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const stripeSecret = process.env.STRIPE_SECRET || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// Stripe webhook BEFORE json()
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  try{
    const sig = req.headers['stripe-signature'];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !secret) return res.status(200).send();
    const event = stripe.webhooks.constructEvent(req.body, sig, secret);
    if (event.type === 'checkout.session.completed'){
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      const plan = session.metadata?.plan || 'pro';
      if (email){
        if (plan === 'pro'){ setPlan(email, 'pro'); }
        if (plan === 'quick'){
          const until = new Date(Date.now() + 7*24*60*60*1000).toISOString();
          setQuickUntil(email, until);
          setPlan(email, 'quick');
        }
      }
    }
    res.json({ received: true });
  } catch (err){
    console.error('[webhook error]', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const createLimiter = rateLimit({ windowMs: 60_000, max: 15 });

ensureDb();
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Health
app.get('/health', (req,res)=>{
  const t = process.env.HEALTH_TOKEN || '';
  if (t && (!req.query.token || req.query.token !== t)) return res.status(403).json({ ok:false });
  res.json({ ok:true, time: new Date().toISOString() });
});

// Create watch — supports multiple postcodes if Pro
app.post('/api/watch', createLimiter, async (req,res)=>{
  try{
    const { email, postcode, postcodes, radius_miles=10 } = req.body||{};
    if (!email) return res.status(400).json({ ok:false, error:'email required' });

    const user = upsertUser(String(email).trim());
    const current = getUserByEmail(email);
    const plan = (current?.plan || 'free');

    let pcs = [];
    if (postcodes && Array.isArray(postcodes)) pcs = postcodes;
    else if (postcode) pcs = String(postcode).split(',').map(s=>s.trim()).filter(Boolean);
    if (pcs.length === 0) return res.status(400).json({ ok:false, error:'postcode required' });

    const maxForPlan = plan === 'pro' ? 5 : 1;
    const toCreate = pcs.slice(0, maxForPlan);
    const created = [];

    for (const pc of toCreate){
      const w = createWatch({
        user_id: user.id,
        postcode: String(pc).toUpperCase().replace(/\s+/g,''),
        radius_miles: Number(radius_miles),
        frequency_minutes: plan === 'pro' ? 30 : 180,
        contact_email: String(email).trim()
      });
      created.push({ id: w.id, postcode: w.postcode });
    }

    // Send welcome exactly once
    if ((current?.welcomed|0) === 0){
      try { await sendWelcome(String(email).trim()); setWelcomed(String(email).trim()); } catch(e){ console.error('[welcome]', e.message); }
    }

    const upgradeNeeded = pcs.length > maxForPlan;
    res.json({ ok:true, created, upgrade_needed: upgradeNeeded, plan });
  }catch(e){
    console.error('POST /api/watch', e);
    res.status(500).json({ ok:false, error:'failed' });
  }
});

// Public list (no emails)
app.get('/api/watches', (req,res)=>{
  try{ res.json({ items: listWatchesPublic() }); }
  catch(e){ res.status(500).json({ ok:false, error:'failed' }); }
});

// Manual run
app.post('/api/watch/:id/run', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const w = listWatchesAdmin().find(x=> x.id===id);
    if (!w) return res.status(404).json({ ok:false, error:'not found' });
    const r = await runScan(w);
    res.json({ ok:true, result: r });
  }catch(e){
    console.error('POST /api/watch/:id/run', e);
    res.status(500).json({ ok:false, error:'failed' });
  }
});

// Admin (Basic auth)
const adminPass = process.env.ADMIN_PASSWORD || '';
const adminAuth = basicAuth({
  users: { admin: adminPass || 'unset' },
  challenge: true,
  unauthorizedResponse: 'Auth required'
});
app.get('/api/admin/watches', adminAuth, (req,res)=>{
  try{ res.json({ items: listWatchesAdmin() }); }
  catch(e){ res.status(500).json({ ok:false, error:'failed' }); }
});

// Stripe Checkout
app.post('/api/checkout/session', async (req,res)=>{
  try{
    if (!stripe) return res.status(400).json({ ok:false, error:'Stripe not configured' });
    const { email, plan } = req.body||{};
    if (!email || !plan) return res.status(400).json({ ok:false, error:'email and plan required' });
    const price = plan === 'pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_QUICK;
    const mode = plan === 'pro' ? 'subscription' : 'payment';

    const successUrl = process.env.STRIPE_SUCCESS_URL || ((process.env.PUBLIC_BASE_URL || '') + '/?success=1');
    const cancelUrl = process.env.STRIPE_CANCEL_URL || ((process.env.PUBLIC_BASE_URL || '') + '/pricing.html?canceled=1');

    const session = await (stripe.checkout.sessions.create({
      mode,
      line_items: [{ price, quantity: 1 }],
      customer_email: email,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { plan }
    }));
    res.json({ ok:true, url: session.url });
  }catch(e){
    console.error('[checkout]', e);
    res.status(500).json({ ok:false, error:'stripe failed' });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, ()=> console.log(`[Dentist Radar] listening on :${port}`));
startScheduler();
