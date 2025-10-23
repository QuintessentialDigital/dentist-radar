import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ensureDb,
  upsertUser,
  createWatch,
  listWatches
} from './db.js';

import { runScan } from './service.js';
import { startScheduler } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

// init DB & static
ensureDb();
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// health
app.get('/health', (req, res) => {
  const t = process.env.HEALTH_TOKEN || '';
  if (t && req.query.token && req.query.token !== t) {
    return res.status(403).json({ ok: false });
  }
  return res.json({ ok: true, time: new Date().toISOString() });
});

// ---- WATCH API ----

// POST (normal) - used by the homepage form
app.post('/api/watch', (req, res) => {
  try {
    const { email, postcode, radius_miles = 10, frequency_minutes = 60 } = req.body || {};
    if (!email || !postcode) return res.status(400).json({ ok:false, error: 'email and postcode required' });

    const u = upsertUser(String(email).trim());
    const w = createWatch({
      user_id: u.id,
      postcode: String(postcode).toUpperCase().replace(/\s+/g, ''),
      radius_miles: Number(radius_miles),
      frequency_minutes: Number(frequency_minutes),
      contact_email: String(email).trim()
    });

    return res.json({ ok: true, watch: w });
  } catch (e) {
    console.error('POST /api/watch', e);
    return res.status(500).json({ ok:false, error: 'failed' });
  }
});

// GET (quick-create for testing via URL)
app.get('/api/watch/create', (req, res) => {
  try {
    const email = String(req.query.email || '').trim();
    const postcode = String(req.query.postcode || '').toUpperCase().replace(/\s+/g, '');
    const radius = Number(req.query.radius || 10);
    if (!email || !postcode) return res.status(400).json({ ok:false, error: 'email and postcode required' });

    const u = upsertUser(email);
    const w = createWatch({
      user_id: u.id,
      postcode,
      radius_miles: radius,
      frequency_minutes: 60,
      contact_email: email
    });

    return res.json({ ok: true, watch: w });
  } catch (e) {
    console.error('GET /api/watch/create', e);
    return res.status(500).json({ ok:false, error: 'failed' });
  }
});

// list watches
app.get('/api/watches', (req, res) => {
  try { return res.json({ items: listWatches() }); }
  catch (e) { console.error('GET /api/watches', e); return res.status(500).json({ ok:false, error:'failed' }); }
});

// run a scan for a watch
app.post('/api/watch/:id/run', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const w = listWatches().find(x => x.id === id);
    if (!w) return res.status(404).json({ ok:false, error: 'not found' });
    const r = await runScan(w);
    return res.json({ ok:true, result: r });
  } catch (e) {
    console.error('POST /api/watch/:id/run', e);
    return res.status(500).json({ ok:false, error: 'failed' });
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`[Dentist Radar] listening on :${port}`));
startScheduler();
