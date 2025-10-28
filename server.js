// Dentist Radar — full working server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) throw new Error('Missing MONGO_URI in environment');

const client = new MongoClient(MONGO_URI);
await client.connect();
const db = client.db('dentistradar');
const alerts = db.collection('alerts');

// Basic rate limits
const createLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const scanLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// --- Serve static frontend ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Health check ---
app.get('/health', async (req, res) => {
  try {
    res.json({ ok: true, time: new Date().toISOString() });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// --- API: Create alert ---
app.post('/api/watch', createLimiter, async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};
    if (!email || !postcode) {
      return res.status(400).json({ ok: false, error: 'Missing email or postcode' });
    }

    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
    }

    const tokens = postcode.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
    if (!tokens.length) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid postcode.' });
    }

    // Free plan: only 1 postcode
    if (tokens.length > 1) {
      return res.status(403).json({
        ok: false,
        code: 'free_limit',
        error: 'Free plan supports 1 postcode. Please upgrade to Pro.'
      });
    }

    // If already has 1 alert -> free limit
    const count = await alerts.countDocuments({ email });
    if (count >= 1) {
      return res.status(403).json({
        ok: false,
        code: 'free_limit',
        error: 'Free plan supports 1 postcode. Please upgrade to Pro.'
      });
    }

    // Duplicate prevention
    const exists = await alerts.findOne({ email, postcode: tokens[0] });
    if (exists) return res.json({ ok: true, duplicates: 1 });

    await alerts.insertOne({
      email,
      postcode: tokens[0],
      radius: Number(radius) || 10,
      created: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Error creating alert', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// --- API: Get all watches (for admin) ---
app.get('/api/watches', async (req, res) => {
  try {
    const items = await alerts.find().sort({ created: -1 }).toArray();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// --- API: Trigger scan manually ---
app.post('/api/scan', scanLimiter, async (req, res) => {
  const token = process.env.SCAN_TOKEN || '';
  if (!token || (req.query.token !== token && req.headers['x-scan-token'] !== token)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  try {
    // Placeholder for your scraper logic (runScan)
    // In production this would fetch NHS listings and email alerts.
    console.log('Manual scan triggered');
    res.json({ ok: true, time: new Date().toISOString() });
  } catch (e) {
    console.error('Scan failed', e);
    res.status(500).json({ ok: false, error: 'scan failed' });
  }
});

// --- Default route fallback ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`✅ Dentist Radar server running on port ${PORT}`);
});
