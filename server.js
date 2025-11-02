// Dentist Radar Server (v1.8.6)
// v1.8.6 adds: secure /api/scan endpoint (token-gated) that uses scanner.js
// v1.8.5 baseline kept: Mongo save, welcome email + EmailLog, Stripe checkout, SPA fallback

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";

// NEW: scanner import (safe addition – no changes to other flows)
import { runScan } from "./scanner.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ---------------------------
   MongoDB — force DB to "dentistradar"
--------------------------- */
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri; // already correct
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}

const RAW_URI = process.env.MONGO_URI || "";
const FIXED_URI = forceDentistRadarDb(RAW_URI);

mongoose
  .connect(FIXED_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected →", FIXED_URI.replace(/:[^@]+@/, ":***@")))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

/* ---------------------------
   Schemas / Models
--------------------------- */
const watchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },
    radius: Number
  },
  { timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, index: true },
    plan: { type: String, default: "free" }, // free|pro|family
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" }
  },
  { timestamps: true, versionKey: false }
);

/* EmailLog schema (lightweight) */
const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,            // 'welcome' | 'availability' | 'other'
    provider: { type: String, default: "postmark" },
    providerId: String,      // Postmark MessageID
    meta: Object,
    sentAt: { type: Date, default: Date.now }
  },
  { versionKey: false, timestamps: false }
);

const Watch   = mongoose.model("Watch", watchSchema);
const User    = mongoose.model("User", userSchema);
const EmailLog= mongoose.model("EmailLog", emailLogSchema);

/* ---------------------------
   Helpers (email + validation)
--------------------------- */
async function sendEmail(to, subject, text, type = "other", meta = {}) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("ℹ️ POSTMARK_TOKEN not set → skip email.");
    return { ok: false, skipped: true };
  }
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": key
    },
    body: JSON.stringify({
      From: process.env.MAIL_FROM || "alerts@dentistradar.co.uk",
      To: to,
      Subject: subject,
      TextBody: text
    })
  });

  const body = await r.json().catch(() => ({}));
  const ok = r.ok;

  if (ok) {
    // Persist a minimal log of the sent email
    try {
      await EmailLog.create({
        to,
        subject,
        type,
        providerId: body.MessageID,
        meta,
        sentAt: new Date()
      });
    } catch (e) {
      console.error("⚠️ EmailLog save error:", e?.message || e);
    }
  } else {
    console.error("❌ Postmark error:", body);
  }

  return { ok, status: r.status, body };
}

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
async function planLimitFor(email) {
  const u = await User.findOne({ email: normEmail(email) }).lean();
  if (!u || u.status !== "active") return 1;
  if (u.plan === "family") return u.postcode_limit || 10;
  if (u.plan === "pro") return u.postcode_limit || 5;
  return 1;
}

/* ---------------------------
   Health / Debug
--------------------------- */
app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: "dentistradar", time: new Date().toISOString() });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, db: "dentistradar", time: new Date().toISOString() });
});

/* ---------------------------
   Create Watch
--------------------------- */
app.post("/api/watch/create", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const postcode = normalizePostcode(String(req.body?.postcode || ""));
    const radius = Number(req.body?.radius);

    if (!emailRe.test(email)) return res.status(400).json({ ok: false, error: "invalid_email", message: "Please enter a valid email address." });
    if (!looksLikeUkPostcode(postcode)) return res.status(400).json({ ok: false, error: "invalid_postcode", message: "Please enter a valid UK postcode (e.g. RG1 2AB)." });
    if (!radius || radius < 1 || radius > 30) return res.status(400).json({ ok: false, error: "invalid_radius", message: "Please select a radius between 1 and 30 miles." });

    // Duplicate check
    const exists = await Watch.findOne({ email, postcode }).lean();
    if (exists) return res.status(400).json({ ok: false, error: "duplicate", message: "Alert already exists for this postcode." });

    // Plan limit
    const limit = await planLimitFor(email);
    const count = await Watch.countDocuments({ email });
    if (count >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        message: `Your plan allows up to ${limit} postcode${limit > 1 ? "s" : ""}.`,
        upgradeLink: "/pricing.html"
      });
    }

    await Watch.create({ email, postcode, radius });

    // Welcome email (now logged)
    await sendEmail(
      email,
      `Dentist Radar — alert active for ${postcode}`,
      `We’ll email you when NHS practices within ${radius} miles of ${postcode} start accepting new patients.

Please call the practice to confirm before travelling.

— Dentist Radar`,
      "welcome",
      { postcode, radius }
    );

    res.json({ ok: true, message: "✅ Alert created — check your inbox!" });
  } catch (e) {
    console.error("watch/create error:", e);
    res.status(500).json({ ok: false, error: "server_error", message: "Something went wrong. Please try again later." });
  }
});

/* ---------------------------
   Stripe Checkout (compat route names)
--------------------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

async function handleCheckoutSession(req, res) {
  try {
    if (!stripe) return res.json({ ok: false, error: "stripe_not_configured" });
    const { email, plan } = req.body || {};
    if (!emailRe.test(email || "")) return res.json({ ok: false, error: "invalid_email" });

    const SITE = process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";
    const pricePro = process.env.STRIPE_PRICE_PRO;
    const priceFamily = process.env.STRIPE_PRICE_FAMILY;
    const priceId = (plan || "pro").toLowerCase() === "family" ? priceFamily : pricePro;
    if (!priceId) return res.json({ ok: false, error: "missing_price" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${SITE}/thankyou.html?plan=${(plan||'pro')}`,
      cancel_url: `${SITE}/upgrade.html?canceled=true`
    });
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err?.type, err?.code, err?.message);
    return res.status(500).json({ ok: false, error: "stripe_error", message: err?.message || "unknown" });
  }
}

app.post("/api/create-checkout-session", handleCheckoutSession);
app.post("/api/stripe/create-checkout-session", handleCheckoutSession);

/* ---------------------------
   Manual / Cron Scan Endpoint (token-gated)
--------------------------- */
app.post("/api/scan", async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (!token || (req.query.token !== token && req.headers["x-scan-token"] !== token)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const result = await runScan(); // from scanner.js
    res.json(result && typeof result === "object" ? result : { ok: true, checked: 0, found: 0, alertsSent: 0 });
  } catch (err) {
    console.error("❌ /api/scan error:", err);
    res.json({ ok: true, checked: 0, found: 0, alertsSent: 0, note: "scan_exception" });
  }
});

/* ---------------------------
   SPA Fallback
--------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------------------
   Start
--------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Dentist Radar running on :${PORT}`);
});
