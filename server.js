import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import Stripe from 'stripe';
import fetch from 'node-fetch';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const client = new MongoClient(process.env.MONGO_URI);
let db;
if (process.env.MONGO_URI) {
  await client.connect();
  db = client.db(process.env.DB_NAME || 'dentist_radar');
  console.log('✅ Mongo connected');
}

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const limiter = new RateLimiterMemory({ points: 3, duration: 30 });

// 📩 Utility: simple email validation
function validEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

// 📍 Create new alert
app.post('/api/watch/create', async (req, res) => {
  try {
    await limiter.consume(req.ip);
    const { email, postcode, radius = 5 } = req.body;
    if (!email || !validEmail(email)) return res.status(400).json({ ok: false, error: 'Invalid email' });
    if (!postcode) return res.status(400).json({ ok: false, error: 'Postcode required' });

    const collection = db.collection('alerts');
    const existing = await collection.findOne({ email, postcode });
    if (existing) return res.json({ ok: true, msg: 'Alert already exists' });

    await collection.insertOne({ email, postcode, radius, plan: 'free', created: new Date() });
    res.json({ ok: true, msg: 'Alert created' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// 🧭 Health check
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date() }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ Dentist Radar running on ${PORT}`));
