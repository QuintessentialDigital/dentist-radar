import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----- MongoDB Connection -----
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) throw new Error('Missing MONGO_URI in environment');

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error', err));

const watchSchema = new mongoose.Schema({
  email: String,
  postcode: String,
  radius: Number,
  createdAt: { type: Date, default: Date.now }
});
const userSchema = new mongoose.Schema({
  email: String,
  plan: { type: String, default: 'free' },
  postcode_limit: { type: Number, default: 1 },
  status: { type: String, default: 'active' }
});

const Watch = mongoose.model('Watch', watchSchema);
const User = mongoose.model('User', userSchema);

// ----- Stripe Setup -----
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO;
const STRIPE_PRICE_FAMILY = process.env.STRIPE_PRICE_FAMILY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = process.env.SITE_URL || 'https://www.dentistradar.co.uk';

const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

// ----- ROUTES -----

// Health check
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Create alert (same logic you had before)
app.post('/api/watch/create', async (req, res) => {
  try {
    const { email, postcode, radius } = req.body;

    // Validate fields
    if (!email || !email.includes('@'))
      return res.status(400).json({ ok: false, error: 'Invalid email format' });
    if (!postcode || postcode.length < 5)
      return res.status(400).json({ ok: false, error: 'Invalid UK postcode' });
    if (!radius || radius < 1 || radius > 30)
      return res.status(400).json({ ok: false, error: 'Radius must be between 1 and 30 miles' });

    // Check for duplicate
    const exists = await Watch.findOne({ email, postcode });
    if (exists) return res.json({ ok: false, error: 'Alert already exists' });

    // Check plan limit
    const user = await User.findOne({ email });
    const limit = user?.postcode_limit || 1;
    const count = await Watch.countDocuments({ email });
    if (count >= limit) {
      return res.json({ ok: false, upgrade: true, message: 'Free plan supports 1 postcode. Upgrade to add more.' });
    }

    await Watch.create({ email, postcode, radius });
    res.json({ ok: true, message: 'Alert created successfully!' });
  } catch (err) {
    console.error('Create alert error', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// ----- Stripe checkout -----
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.json({ ok: false, error: 'stripe_not_configured' });
    const { email, plan } = req.body;
    if (!email || !email.includes('@')) return res.json({ ok: false, error: 'invalid_email' });

    const priceId = plan === 'family' ? STRIPE_PRICE_FAMILY : STRIPE_PRICE_PRO;
    if (!priceId) return res.json({ ok: false, error: 'missing_price' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${SITE_URL}/thankyou.html?plan=${plan}`,
      cancel_url: `${SITE_URL}/upgrade.html?canceled=true`,
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('Stripe session error', err);
    res.status(500).json({ ok: false, error: 'access_denied', message: err.message });
  }
});

// ----- Stripe webhook -----
import crypto from 'crypto';
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email;
    const plan = session.metadata?.plan || 'pro';

    User.findOneAndUpdate(
      { email },
      { plan, postcode_limit: plan === 'family' ? 10 : 5 },
      { upsert: true }
    ).then(() => console.log(`✅ Upgraded ${email} to ${plan}`));
  }

  res.json({ received: true });
});

// ----- Serve Frontend -----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----- Start Server -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
