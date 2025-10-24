import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import basicAuth from 'express-basic-auth';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { ensureDb, createWatch, listWatchesPublic, listWatchesAdmin, upsertUser, getUser, setPlan, markWelcomed } from './db.js';
import { sendWelcome, sendAvailability, sendTest } from './alerts.js';
import { runScan } from './scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

app.set('trust proxy', true);
const PRIMARY = (process.env.PRIMARY_DOMAIN || '').toLowerCase();
const DO_NOT_REDIRECT = new Set(['/webhook', '/health', '/favicon.ico']);
app.use((req,res,next)=>{ try{ if(!PRIMARY||DO_NOT_REDIRECT.has(req.path)) return next(); const host=String(req.headers.host||'').toLowerCase(); const proto=String(req.headers['x-forwarded-proto']||req.protocol||'http').toLowerCase(); if(host===PRIMARY&&proto==='https') return next(); const url=`https://${PRIMARY}${req.originalUrl||'/'}`; const current=`${proto}://${host}${req.originalUrl||'/'}`; if(url===current) return next(); return res.redirect(301,url);}catch{ next(); } });

const stripeSecret = process.env.STRIPE_SECRET || ''; const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => { try{ if (!stripe) return res.status(200).send(); const sig=req.headers['stripe-signature']; const secret=process.env.STRIPE_WEBHOOK_SECRET; if(!secret) return res.status(200).send(); const event=stripe.webhooks.constructEvent(req.body, sig, secret); if(event.type==='checkout.session.completed'){ const s=event.data.object; const email=s.customer_details?.email||s.customer_email; const plan=s.metadata?.plan||'pro'; if(email){ if(plan==='pro') setPlan(email,'pro'); if(plan==='quick') setPlan(email,'quick'); } } res.json({received:true}); }catch(err){ console.error('[webhook error]',err.message); res.status(400).send(`Webhook Error: ${err.message}`);} });

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());
ensureDb();
app.use('/', express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req,res)=>{ const t=process.env.HEALTH_TOKEN||''; if(t && req.query.token!==t) return res.status(403).json({ok:false}); res.json({ok:true, time:new Date().toISOString()}); });

const limiter = rateLimit({ windowMs:60000, max:30 });
app.post('/api/watch', limiter, async (req,res)=>{
  try{ const { email, postcode, radius_miles=10 } = req.body||{}; if(!email) return res.status(400).json({ok:false,error:'email required'}); if(!postcode) return res.status(400).json({ok:false,error:'postcode required'}); upsertUser(email); const pcs=String(postcode).split(',').map(s=>s.trim()).filter(Boolean); const created=[]; for(const pc of pcs){ const row=createWatch(String(email).trim(), pc, Number(radius_miles)); created.push({id:row.id, postcode:row.postcode}); } const u=getUser(email); if((u?.welcomed|0)===0){ try{ await sendWelcome(String(email).trim()); markWelcomed(String(email).trim()); }catch{} } res.json({ok:true, created, plan:u?.plan||'free'}); }catch(e){ console.error('POST /api/watch',e); res.status(500).json({ok:false,error:'failed'}); }
});

app.get('/api/watches', (req,res)=>{ try{ res.json({ items:listWatchesPublic() }); }catch{ res.status(500).json({ok:false,error:'failed'}); } });

const adminPass = process.env.ADMIN_PASSWORD || ''; const adminAuth = basicAuth({ users:{ admin: adminPass||'unset' }, challenge:true, unauthorizedResponse:'Auth required' });
app.get('/api/admin/watches', adminAuth, (req,res)=>{ try{ res.json({ items:listWatchesAdmin() }); }catch{ res.status(500).json({ok:false,error:'failed'}); } });
app.post('/api/admin/test-email', adminAuth, async (req,res)=>{ try{ const { to } = req.body||{}; if(!to) return res.status(400).json({ok:false,error:'to required'}); await sendTest(String(to).trim()); res.json({ok:true}); }catch{ res.status(500).json({ok:false,error:'failed'}); } });
app.post('/api/admin/availability', adminAuth, async (req,res)=>{ try{ const { postcode, practice, link } = req.body||{}; if(!postcode||!practice) return res.status(400).json({ok:false,error:'postcode and practice required'}); const pc=String(postcode).toUpperCase().replace(/\s+/g,''); const all=listWatchesAdmin(); const targets=all.filter(w=>(w.postcode||'').startsWith(pc)); let sent=0; for(const t of targets){ try{ await sendAvailability(String(t.email).trim(), { practice, postcode:t.postcode, link }); sent++; }catch(e){ console.warn('sendAvailability failed for', t.email, e.message); } } res.json({ok:true, matched:targets.length, sent}); }catch{ res.status(500).json({ok:false,error:'failed'}); } });

const scanLimiter = rateLimit({ windowMs:60000, max:2 });
app.post('/api/scan', scanLimiter, async (req,res)=>{ const t=process.env.SCAN_TOKEN||''; if(!t||(req.query.token!==t && req.headers['x-scan-token']!=t)) return res.status(403).json({ok:false,error:'forbidden'}); try{ const r=await runScan(); res.json({ ok:true, **r: r, time:new Date().toISOString() }); }catch{ res.status(500).json({ok:false,error:'scan failed'}); } });

app.post('/api/watch/:id/run', (req,res)=> res.json({ ok:true, result:{ scanned:0, alerts:0 } }));

app.post('/api/checkout/session', async (req,res)=>{ try{ if(!stripe) return res.status(400).json({ok:false,error:'Stripe not configured'}); const { email, plan } = req.body||{}; if(!email||!plan) return res.status(400).json({ok:false,error:'email and plan required'}); const price = plan==='pro' ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_QUICK; const mode = plan==='pro' ? 'subscription' : 'payment'; const successUrl = process.env.STRIPE_SUCCESS_URL || ((process.env.PUBLIC_BASE_URL||'') + '/?success=1'); const cancelUrl = process.env.STRIPE_CANCEL_URL || ((process.env.PUBLIC_BASE_URL||'') + '/pricing.html?canceled=1'); const session = await (new (Stripe)(process.env.STRIPE_SECRET)).checkout.sessions.create({ mode, line_items:[{ price, quantity:1 }], customer_email:email, success_url:successUrl, cancel_url:cancelUrl, metadata:{ plan } }); res.json({ ok:true, url: session.url }); }catch(e){ console.error('[checkout]',e); res.status(500).json({ok:false,error:'stripe failed'}); } });

const port = process.env.PORT || 8787; app.listen(port, ()=>console.log(`[Dentist Radar] listening on :${port}`));
