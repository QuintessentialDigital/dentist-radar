import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import morgan from 'morgan';
import { MongoClient } from 'mongodb';
import fetch from 'node-fetch';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'dentist_radar';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SCAN_TOKEN = process.env.SCAN_TOKEN || '';

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_PRIORITY = process.env.STRIPE_PRICE_PRIORITY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

if (!MONGO_URI) {
  console.error('❌ Missing MONGO_URI');
  process.exit(1);
}

// ====== DB ======
const client = new MongoClient(MONGO_URI);
let db, alertsCol, scansCol, metaCol, usersCol, eventsCol;

async function initDb() {
  await client.connect();
  db = client.db(DB_NAME);
  alertsCol = db.collection('alerts');
  scansCol = db.collection('scans');
  metaCol = db.collection('meta');
  usersCol = db.collection('users');
  eventsCol = db.collection('events');

  await alertsCol.createIndex({ email: 1, postcode: 1 }, { unique: true });
  await usersCol.createIndex({ email: 1 }, { unique: true });
}
await initDb();

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ====== Helpers ======
function normEmail(v=''){ return String(v).trim().toLowerCase(); }
function normPostcode(v=''){ return String(v).trim().toUpperCase().replace(/\s+/g,''); }
function validateEmail(e=''){ return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
function validateUKPostcode(pc=''){
  const v = String(pc).trim().toUpperCase();
  const re = /^(GIR ?0AA|(?:[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}))$/i;
  return re.test(v);
}
function validateRadius(r){ const n=Number(r); return Number.isFinite(n)&&n>=1&&n<=50; }

async function sendEmail(to, subject, text){
  if (!POSTMARK_TOKEN) { console.log('[email skipped - no POSTMARK_TOKEN]'); return; }
  await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': POSTMARK_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      From: 'alerts@dentistradar.co.uk',
      To: to,
      Subject: subject,
      TextBody: text,
      MessageStream: 'outbound'
    })
  }).catch(err=>console.error('Postmark error',err));
}

function emailWelcome({email, postcode, radius}) {
  return `Thanks — your alert is active.\n\nWe’ll email you when a nearby NHS practice starts accepting new patients.\nPostcode: ${postcode}\nRadius: ${radius} miles\n\nTip: call the practice to confirm before travelling.\n\n— Dentist Radar`;
}

function emailAvailability({practice, postcode, link}) {
  return `Good news! ${practice} is showing as accepting new NHS patients near ${postcode}.\n${link ? 'Check details: '+link+'\n' : ''}\nPlease call the practice to confirm availability before travelling.\n\n— Dentist Radar`;
}

// ====== Plans ======
async function getUserPlan(email) {
  const u = await usersCol.findOne({ email: normEmail(email) });
  return u?.plan || 'free';
}
async function ensureUser(email) {
  const e = normEmail(email);
  await usersCol.updateOne(
    { email: e },
    { $setOnInsert: { email: e, plan: 'free', created: new Date() } },
    { upsert: true }
  );
}

// ====== API: Create alert ======
app.post('/api/watch/create', async (req,res)=>{
  try{
    const { email, postcodes, radius } = req.body || {};
    const cleanEmail = normEmail(email);
    if (!validateEmail(cleanEmail)) return res.status(400).json({ ok:false, error:'invalid_email' });

    await ensureUser(cleanEmail);
    const plan = await getUserPlan(cleanEmail);
    const maxPcs = plan === 'priority' ? 5 : 1;
    const r = validateRadius(radius) ? Number(radius) : 10;
    const pcs = String(postcodes||'').split(/[,\s]+/).filter(Boolean).map(normPostcode);

    if (pcs.length > maxPcs) return res.status(402).json({ ok:false, error:'upgrade_required', message:`Free plan allows ${maxPcs} postcode.` });
    for (const pc of pcs) if (!validateUKPostcode(pc)) return res.status(400).json({ ok:false, error:'invalid_postcode' });

    let inserted = 0;
    for (const pc of pcs){
      try{
        await alertsCol.insertOne({ email: cleanEmail, postcode: pc, radius: r, plan, created: new Date() });
        inserted++;
      }catch(e){ if (e.code !== 11000) throw e; }
    }

    await sendEmail(cleanEmail, 'Dentist Radar — Alert created', emailWelcome({ email: cleanEmail, postcode: pcs[0], radius: r }));
    res.json({ ok:true, inserted, plan });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

// ====== Admin ======
app.get('/api/watches', async (req,res)=>{
  if ((req.headers['x-admin']||'')!==ADMIN_PASSWORD) return res.status(403).json({ ok:false });
  const items = await alertsCol.find({}, { projection:{_id:0} }).sort({created:-1}).limit(500).toArray();
  res.json({ ok:true, items });
});

// ====== Scan ======
app.post('/api/scan', async (req,res)=>{
  const t=req.query.token||req.headers['x-scan-token']||'';
  if(t!==SCAN_TOKEN) return res.status(403).json({ok:false,error:'forbidden'});
  const now=new Date();
  await scansCol.insertOne({created:now});
  await metaCol.updateOne({key:'lastScanAt'},{ $set:{key:'lastScanAt',value:now}},{upsert:true});
  res.json({ok:true,time:now});
});

// ====== Static ======
app.use(express.static(path.join(__dirname,'public'),{maxAge:'1h'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ====== Start ======
app.listen(PORT,()=>console.log(`✅ Dentist Radar running on port ${PORT}`));
