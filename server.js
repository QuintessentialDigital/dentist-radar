// Dentist Radar – server.js (baseline-safe, Stripe add-on, test helper)
// Node: ESM module (type: "module" in package.json)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import { MongoClient } from "mongodb";
import Stripe from "stripe";

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3000;

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ---------------------------------------------------
 * Environment (keep existing names you already use)
 * --------------------------------------------------- */
const MONGO_URI  = process.env.MONGO_URI;
const DB_NAME    = process.env.DB_NAME || "dentistradar";

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const MAIL_FROM      = process.env.MAIL_FROM || "alerts@dentistradar.co.uk";

const SCAN_TOKEN    = process.env.SCAN_TOKEN || "";        // for /api/scan
const TEST_ALERT_TOKEN = process.env.TEST_ALERT_TOKEN || ""; // for /api/test-alert

// Stripe (optional; if not set, upgrade endpoints return helpful errors)
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PRICE_PRO      = process.env.STRIPE_PRICE_PRO || "";
const STRIPE_PRICE_FAMILY   = process.env.STRIPE_PRICE_FAMILY || "";
const SITE_URL              = process.env.SITE_URL || "http://localhost:" + PORT;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

/* ---------------------------------------------------
 * Webhook raw parser MUST come before json() middleware
 * --------------------------------------------------- */
app.post(
  "/webhooks/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        // Not configured; acknowledge to avoid retries in test
        return res.status(200).send();
      }

      const sig = req.headers["stripe-signature"];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error("❌ Webhook signature failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      const db = globalThis.__db;
      if (!db) {
        console.warn("Webhook received before DB ready.");
        return res.status(200).send();
      }
      const users = db.collection("users");

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const email =
          (session.customer_details && session.customer_details.email) ||
          session.metadata?.email;
        const plan = (session.metadata?.plan || "pro").toLowerCase();
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        if (email) {
          const limit = plan === "family" ? 10 : 5;
          await users.updateOne(
            { email: email.toLowerCase() },
            {
              $set: {
                email: email.toLowerCase(),
                plan,
                status: "active",
                postcode_limit: limit,
                stripeCustomerId: customerId || null,
                stripeSubscriptionId: subscriptionId || null,
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
          console.log(`✅ Upgraded ${email} → ${plan} (${limit})`);
        }
      }

      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        const status = sub.status;
        const customerId = sub.customer;
        await users.updateOne(
          { stripeCustomerId: customerId },
          { $set: { status, updatedAt: new Date() } }
        );
      }

      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const customerId = sub.customer;
        // Downgrade to free
        await users.updateOne(
          { stripeCustomerId: customerId },
          { $set: { plan: "free", status: "canceled", postcode_limit: 1, updatedAt: new Date() } }
        );
      }

      res.status(200).send();
    } catch (e) {
      console.error("Webhook handler error", e);
      res.status(500).send();
    }
  }
);

/* ---------------------------------------------------
 * Normal middleware (after webhook raw parser)
 * --------------------------------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves your html/css/js

/* ---------------------------------------------------
 * MongoDB (keeps your collections & indexes)
 * --------------------------------------------------- */
if (!MONGO_URI) throw new Error("Missing MONGO_URI in environment");

let client, db, watches, alerts, users;
(async () => {
  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  watches = db.collection("watches");
  alerts  = db.collection("alerts");
  users   = db.collection("users");

  // Important indexes (idempotent)
  await watches.createIndex({ email: 1, postcode: 1 }, { unique: true });
  await watches.createIndex({ createdAt: -1 });
  await alerts.createIndex({ createdAt: -1 });
  await users.createIndex({ email: 1 }, { unique: true });

  // Expose for webhook/test helpers
  globalThis.__db = db;
  globalThis.__mongoClient = client;

  console.log("✅ MongoDB connected");
})().catch((e) => {
  console.error("Mongo connection error:", e);
  process.exit(1);
});

/* ---------------------------------------------------
 * Helpers (validation, email, limits)
 * --------------------------------------------------- */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const normEmail = (s) => String(s || "").trim().toLowerCase();

function normalizePostcode(raw = "") {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length < 5) return raw.toUpperCase().trim();
  return `${t.slice(0, t.length - 3)} ${t.slice(-3)}`.trim();
}

function looksLikeUkPostcode(pc) {
  return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test((pc || "").toUpperCase());
}

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN) return { ok: false, skipped: true, reason: "POSTMARK_TOKEN missing" };
  try {
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": POSTMARK_TOKEN
      },
      body: JSON.stringify({
        From: MAIL_FROM,
        To: to,
        Subject: subject,
        TextBody: text
      })
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getLimitForEmail(email) {
  try {
    const u = await users.findOne({ email: email.toLowerCase() });
    if (!u || u.status !== "active") return 1; // free
    if (u.plan === "family") return u.postcode_limit || 10;
    if (u.plan === "pro") return u.postcode_limit || 5;
    return 1;
  } catch {
    return 1;
  }
}

/* ---------------------------------------------------
 * API: Health
 * --------------------------------------------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ---------------------------------------------------
 * API: Create watch (baseline behaviour preserved)
 * --------------------------------------------------- */
app.post("/api/watch/create", async (req, res) => {
  try {
    const emailKey = normEmail(req.body?.email);
    const pcRaw = String(req.body?.postcode || "");
    const pc = normalizePostcode(pcRaw);
    const rNum = Number(req.body?.radius);

    if (!emailRe.test(emailKey)) {
      return res.status(400).json({ ok: false, error: "invalid_email", message: "Please enter a valid email address." });
    }
    if (!looksLikeUkPostcode(pc)) {
      return res.status(400).json({ ok: false, error: "invalid_postcode", message: "Please enter a valid UK postcode (e.g. RG1 2AB)." });
    }
    if (!rNum || isNaN(rNum) || rNum < 1 || rNum > 30) {
      return res.status(400).json({ ok: false, error: "invalid_radius", message: "Please select a radius between 1 and 30 miles." });
    }

    const existing = await watches.findOne({ email: emailKey, postcode: pc });
    if (existing) {
      return res.status(400).json({ ok: false, error: "duplicate", message: "An alert already exists for this postcode." });
    }

    const limit = await getLimitForEmail(emailKey);
    const count = await watches.countDocuments({ email: emailKey });
    if (count >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        message: `Your plan allows up to ${limit} postcode${limit > 1 ? "s" : ""}.`,
        upgradeLink: "/pricing.html"
      });
    }

    await watches.insertOne({
      email: emailKey,
      postcode: pc,
      radius: rNum,
      createdAt: new Date()
    });

    // Friendly confirmation email (baseline)
    await sendEmail(
      emailKey,
      `Dentist Radar — alerts enabled for ${pc}`,
      `We’ll email you when NHS dentists within ${rNum} miles of ${pc} start accepting patients.

Please call the practice to confirm availability before travelling.

— Dentist Radar`
    );

    res.json({ ok: true, message: "✅ Alert created — check your inbox!" });
  } catch (e) {
    console.error("watch/create error", e);
    res.status(500).json({ ok: false, error: "server_error", message: "Something went wrong. Please try again later." });
  }
});

/* ---------------------------------------------------
 * API: List watches (admin/simple)
 * --------------------------------------------------- */
app.get("/api/watches", async (req, res) => {
  try {
    const items = await watches
      .find({}, { projection: { _id: 0 } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json({ ok: true, items, count: items.length, time: new Date().toISOString() });
  } catch (e) {
    console.error("watches list error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------------------------------
 * API: Stripe – create checkout session (add-on)
 * --------------------------------------------------- */
app.post("/api/stripe/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const plan = String(req.body?.plan || req.query.plan || "pro").toLowerCase();
    const email = normEmail(req.body?.email || req.query.email || "");
    if (!emailRe.test(email)) return res.status(400).json({ ok: false, error: "invalid_email" });

    const priceId = plan === "family" ? STRIPE_PRICE_FAMILY : STRIPE_PRICE_PRO;
    if (!priceId) return res.status(400).json({ ok: false, error: "missing_price" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${SITE_URL}/thankyou.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/upgrade.html?canceled=1`,
      customer_email: email,
      metadata: { email, plan },
      subscription_data: { metadata: { email, plan } },
      allow_promotion_codes: true
    });

    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error", err);
    res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

/* ---------------------------------------------------
 * API: Test helper – send a fake availability email (token-protected)
 * --------------------------------------------------- */
app.post("/api/test-alert", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    if (!TEST_ALERT_TOKEN || token !== TEST_ALERT_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const email = normEmail(req.body?.email);
    const pc = normalizePostcode(String(req.body?.postcode || ""));
    const practice = String(req.body?.practice || "Test Dental Practice");
    const link = String(req.body?.link || "");

    if (!emailRe.test(email)) return res.status(400).json({ ok: false, error: "invalid_email" });
    if (!looksLikeUkPostcode(pc)) return res.status(400).json({ ok: false, error: "invalid_postcode" });

    const subject = `NHS dentist update: ${practice} — now accepting near ${pc}`;
    const body = [
      `Good news! ${practice} is showing as accepting new NHS patients near ${pc}.`,
      link ? `Check details: ${link}` : "",
      "",
      "Please call the practice to confirm availability before travelling.",
      "",
      "— Dentist Radar (test alert)"
    ].filter(Boolean).join("\n");

    const result = await sendEmail(email, subject, body);

    try {
      const testAlerts = globalThis.__db?.collection("test_alerts");
      await testAlerts?.insertOne({
        email, postcode: pc, practice, link: link || null,
        sent: !!result?.ok, status: result?.status || null, createdAt: new Date()
      });
    } catch (e) {
      console.warn("test_alerts insert warn:", e.message);
    }

    res.json({ ok: true, message: "Test alert email attempted.", emailResult: result });
  } catch (e) {
    console.error("test-alert error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------------------------------
 * API: Scan – token-protected; calls existing scanner if present
 * --------------------------------------------------- */
async function runScanSafe() {
  try {
    // If you have your real scanner attached somewhere (e.g., globalThis.__runScan),
    // call it to preserve existing behaviour.
    if (typeof globalThis.__runScan === "function") {
      return await globalThis.__runScan({ db, watches, alerts, users, sendEmail });
    }
    // Fallback no-op (won't break your live site if scanner module isn't loaded here)
    return { ok: true, changes_found: 0 };
  } catch (e) {
    console.error("runScanSafe error:", e);
    return { ok: false, error: e.message || "scan_error" };
  }
}

app.post("/api/scan", async (req, res) => {
  try {
    const token = String(req.query.token || req.headers["x-scan-token"] || "");
    if (!SCAN_TOKEN || token !== SCAN_TOKEN) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    const r = await runScanSafe();
    res.json({ ok: !!r.ok, ...(r || {}), time: new Date().toISOString() });
  } catch (e) {
    console.error("scan error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------------------------------
 * SPA/static fallback (keeps all your public pages working)
 * --------------------------------------------------- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------------------------------------------
 * Start server
 * --------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Dentist Radar running on ${PORT}`);
});
