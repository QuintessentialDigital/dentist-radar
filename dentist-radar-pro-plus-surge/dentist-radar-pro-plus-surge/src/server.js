import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureDb, createWatch, listWatches, triggerRunForWatch, upsertUserByEmail, countWatchesForUser, listUsers, setPlanByUserId, listAllWatches, createApiKey, listApiKeys, deleteApiKey } from './db.js';
import { scheduleAll } from './scheduler.js';
import { PLANS } from './plans.js';
import { hasStripe, createCheckoutSession, stripeWebhookHandler } from './stripe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

import { getMetrics } from './net.js';

app.use(helmet());
app.use(express.json({ verify:(req,res,buf)=>{ req.rawBody = buf; } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

ensureDb();

function adminAuth(req, res, next){
  const pass = process.env.ADMIN_PASSWORD || '';
  const hdr = req.headers['authorization']||'';
  if (!pass) return res.status(503).json({ error: 'ADMIN_PASSWORD not set' });
  if (!hdr.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate','Basic realm="admin"').send('Auth required');
  const b64 = hdr.split(' ')[1]||'';
  const decoded = Buffer.from(b64, 'base64').toString('utf8');
  const parts = decoded.split(':');
  const given = parts[1] || ''; // username ignored
  if (given !== pass) return res.status(403).send('Forbidden');
  next();
}


app.use('/', express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req,res)=>{
  const token = process.env.HEALTH_TOKEN || '';
  if (token && req.query.token && req.query.token !== token) return res.status(403).json({ ok:false });
  const m = getMetrics();
  res.json({ ok:true, time: new Date().toISOString(), metrics: m });
});


app.get('/api/config', (req,res)=>{
  res.json({ brand: process.env.BRAND_NAME || 'Dentist Radar', logo: process.env.BRAND_LOGO_URL || '', hasStripe: hasStripe(), plans: PLANS });
});

app.post('/api/watch', (req,res)=>{
  try{
    const { region='england', postcode, radius_miles, frequency_minutes, channels, contact, email } = req.body || {};
    if (!postcode || !radius_miles || !contact) return res.status(400).json({ error:'postcode, radius_miles, contact required' });
    // simple plan enforcement
    let userId = null, plan = 'free';
    if (email){ const u = upsertUserByEmail(email); userId = u.id; plan = u.plan || 'free'; }
    const P = PLANS[plan] || PLANS.free;
    if (userId){
      const c = countWatchesForUser(userId);
      if (c >= P.maxWatches) return res.status(403).json({ error:`Plan limit reached: ${P.maxWatches} watch(es)` });
    }
    let freq = Number(frequency_minutes || P.minFrequencyMinutes);
    if (freq < P.minFrequencyMinutes) freq = P.minFrequencyMinutes;
    const allowed = new Set(P.channels);
    const reqChannels = Array.isArray(channels) ? channels : [];
    const finalChannels = reqChannels.filter(c => allowed.has(c));
    const dropped = reqChannels.filter(c => !allowed.has(c));
    const w = createWatch({ user_id:userId, region:String(region).toLowerCase(), postcode:postcode.trim().toUpperCase(), radius_miles:Number(radius_miles), frequency_minutes:freq, channels:finalChannels, contact });
    res.json({ ok:true, watch:w, notice: dropped.length ? `Dropped channels not in plan: ${dropped.join(', ')}` : undefined });
  }catch(e){ console.error(e); res.status(500).json({ error:'failed' }); }
});

app.get('/api/watches', (req,res)=>{
  try{ res.json({ items: listWatches() }); }catch(e){ console.error(e); res.status(500).json({ error:'failed' }); }
});

app.post('/api/watch/:id/trigger', async (req,res)=>{
  try{ const result = await triggerRunForWatch(Number(req.params.id)); res.json({ ok:true, result }); }
  catch(e){ console.error(e); res.status(500).json({ error:'trigger failed' }); }
});

app.post('/api/billing/checkout', async (req,res)=>{
  try{
    const { email, plan } = req.body || {};
    if (!email || !plan) return res.status(400).json({ error:'email and plan required' });
    const session = await createCheckoutSession({ email, plan });
    res.json({ url: session.url });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe/webhook', (req,res)=>{
  try{
    const sig = req.headers['stripe-signature'];
    const result = stripeWebhookHandler(req.rawBody, sig);
    res.json(result);
  }catch(e){ console.error(e); res.status(400).send(`Webhook Error: ${e.message}`); }
});



// --- Admin API (Basic password) ---
app.get('/api/admin/users', adminAuth, (req,res)=>{
  res.json({ items: listUsers() });
});
app.post('/api/admin/users/:id/plan', adminAuth, (req,res)=>{
  const id = Number(req.params.id); const { plan } = req.body || {};
  if (!plan) return res.status(400).json({ error:'plan required' });
  const r = setPlanByUserId(id, plan);
  res.json({ ok:true, user: r });
});
app.get('/api/admin/watches', adminAuth, (req,res)=>{
  res.json({ items: listAllWatches() });
});
app.post('/api/admin/api-keys', adminAuth, (req,res)=>{
  const { user_id, label } = req.body || {};
  if (!user_id) return res.status(400).json({ error:'user_id required' });
  const r = createApiKey(Number(user_id), label||'default');
  res.json({ ok:true, key: r.key });
});
app.get('/api/admin/api-keys', adminAuth, (req,res)=>{
  const userId = Number(req.query.user_id||0);
  if (!userId) return res.status(400).json({ error:'user_id required' });
  res.json({ items: listApiKeys(userId) });
});
app.delete('/api/admin/api-keys/:id', adminAuth, (req,res)=>{
  deleteApiKey(Number(req.params.id));
  res.json({ ok:true });
});

const port = process.env.PORT || 8787;
app.listen(port, ()=> console.log(`[Dentist Radar] http://localhost:${port}`));
scheduleAll();
