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

// INIT
ensureDb();

// Serve static first (public)
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Health/version
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
app.get('/version', (req, res) => {
  res.json({ v: '1.0.3' }); // update this if you need to confirm redeploys
});

// ===== WATCH API =====
app.post('/api/watch', (req, res) => {
  try {
    const { email, postcode, radius_miles = 10, frequency_minutes = 60 } = req.body || {};
    if (!email || !postcode) return res.status(400).json({ ok:false, error:'email and postcode required' });

    const u = upsertUser(String(email).trim());
    const w = createWatch({
      user_id: u.id,
      postcode: String(postcode).toUpperCase().replace(/\s+/g,''),
      radius_miles: Number(radius_miles),
      frequency_minutes: Number(frequency_minutes),
      contact_email: String(email).trim()
    });
    return res.json({ ok:true, watch: w });
  } catch (e) {
    console.error('POST /api/watch', e);
    return res.status(500).json({ ok:false, error:'failed' });
  }
});

app.get('/api/watches', (req,res) => {
  try { return res.json({ items: listWatches() }); }
  catch(e){ console.error('GET /api/watches', e); return res.status(500).json({ ok:false, error:'failed' }); }
});

// Quick-create (simple GET, for testing)
app.get('/api/watch/create', (req, res) => {
  try {
    const email = String(req.query.email || '').trim();
    const postcode = String(req.query.postcode || '').toUpperCase().replace(/\s+/g,'');
    const radius = Number(req.query.radius || 10);
    if (!email || !postcode) return res.status(400).json({ ok:false, error:'email and postcode required' });

    const u = upsertUser(email);
    const w = createWatch({
      user_id: u.id,
      postcode,
      radius_miles: radius,
      frequency_minutes: 60,
      contact_email: email
    });
    return res.json({ ok:true, watch:w });
  } catch (e) {
    console.error('GET /api/watch/create', e);
    return res.status(500).json({ ok:false, error:'failed' });
  }
});

// Run scan (POST + GET for convenience)
app.post('/api/watch/:id/run', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const w = listWatches().find(x=>x.id===id);
    if (!w) return res.status(404).json({ ok:false, error:'not found' });
    const r = await runScan(w);
    return res.json({ ok:true, result:r });
  }catch(e){
    console.error('POST /api/watch/:id/run', e);
    return res.status(500).json({ ok:false, error:'failed' });
  }
});
app.get('/api/watch/:id/run', async (req,res)=>{
  try{
    const id = Number(req.params.id);
    const w = listWatches().find(x=>x.id===id);
    if (!w) return res.status(404).json({ ok:false, error:'not found' });
    const r = await runScan(w);
    return res.json({ ok:true, result:r });
  }catch(e){
    console.error('GET /api/watch/:id/run', e);
    return res.status(500).json({ ok:false, error:'failed' });
  }
});

// ===== SIMPLE NO-JS ADMIN =====
app.get('/admin2', (req, res) => {
  try {
    const items = listWatches();
    const rows = items.map(w => `
      <tr>
        <td>#${w.id}</td>
        <td>${w.postcode}</td>
        <td>${w.radius_miles} mi</td>
        <td>${w.frequency_minutes} min</td>
        <td>${w.contact_email||'-'}</td>
        <td><a href="/api/watch/${w.id}/run">Run now</a></td>
      </tr>
    `).join('') || `<tr><td colspan="6">No watches yet.</td></tr>`;

    res.send(`<!doctype html>
      <meta charset="utf-8">
      <title>Admin2 — Dentist Radar</title>
      <body style="font-family:system-ui;margin:24px;max-width:1000px">
        <h1>🛠 Admin2 (no JavaScript)</h1>
        <form action="/api/watch/create" method="get" style="margin-bottom:16px;border:1px solid #eee;padding:12px;border-radius:8px">
          <strong>Create watch:</strong>
          <input name="email" placeholder="you@gmail.com" required>
          <input name="postcode" placeholder="RG41" required>
          <input name="radius" type="number" value="10" min="1" max="50" required>
          <button type="submit">Create</button>
        </form>
        <table border="1" cellspacing="0" cellpadding="6">
          <thead><tr><th>ID</th><th>Postcode</th><th>Radius</th><th>Freq</th><th>Email</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:12px"><a href="/api/watches">View raw JSON</a> · <a href="/version">Version</a></p>
      </body>`);
  } catch (e) {
    res.status(500).send('Admin error');
  }
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`[Dentist Radar] listening on :${port}`));
startScheduler();
