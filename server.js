// Dentist Radar Server (v1.8.7) – Stable Baseline + Simulation Mode
// ---------------------------------------------------------------
// Only change: adds internalSimulatedScan() when SCAN_MODE=simulate
// Everything else works the same as your stable v1.8.6

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ---------------------------
   MongoDB Connection
--------------------------- */
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
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
  { email: String, postcode: String, radius: Number },
  { timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true },
    plan: { type: String, default: "free" },
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" }
  },
  { timestamps: true, versionKey: false }
);

const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,
    provider: { type: String, default: "postmark" },
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

const Watch = mongoose.model("Watch", watchSchema);
const User = mongoose.model("User", userSchema);
const EmailLog = mongoose.model("EmailLog", emailLogSchema);

/* ---------------------------
   Helpers
--------------------------- */
async function sendEmail(to, subject, text, type = "other", meta = {}) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("ℹ️ POSTMARK_TOKEN not set → skipping email.");
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
    await EmailLog.create({
      to,
      subject,
      type,
      providerId: body.MessageID,
      meta,
      sentAt: new Date()
    }).catch((e) => console.error("⚠️ EmailLog save error:", e.message));
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
   Health Check
--------------------------- */
app.get("/api/health", (req, res) => res.json({ ok: true, db: "dentistradar", time: new Date().toISOString() }));
app.get("/health", (req, res) => res.json({ ok: true, db: "dentistradar", time: new Date().toISOString() }));

/* ---------------------------
   Create Watch (main alert creation)
--------------------------- */
app.post("/api/watch/create", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const postcode = normalizePostcode(req.body?.postcode || "");
    const radius = Number(req.body?.radius);

    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email", message: "Please enter a valid email address." });
    if (!looksLikeUkPostcode(postcode))
      return res
        .status(400)
        .json({ ok: false, error: "invalid_postcode", message: "Please enter a valid UK postcode (e.g. RG1 2AB)." });
    if (!radius || radius < 1 || radius > 30)
      return res
        .status(400)
        .json({ ok: false, error: "invalid_radius", message: "Please select a radius between 1 and 30 miles." });

    const exists = await Watch.findOne({ email, postcode }).lean();
    if (exists) return res.status(400).json({ ok: false, error: "duplicate", message: "Alert already exists for this postcode." });

    const limit = await planLimitFor(email);
    const count = await Watch.countDocuments({ email });
    if (count >= limit)
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        message: `Your plan allows up to ${limit} postcode${limit > 1 ? "s" : ""}.`,
        upgradeLink: "/pricing.html"
      });

    await Watch.create({ email, postcode, radius });

    await sendEmail(
      email,
      `Dentist Radar — alert active for ${postcode}`,
      `We’ll email you when NHS practices within ${radius} miles of ${postcode} start accepting new patients.

Please call the practice directly to confirm before travelling.

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
   Stripe Checkout (same as before)
--------------------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

app.post("/api/create-checkout-session", async (req, res) => {
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
      success_url: `${SITE}/thankyou.html?plan=${plan || "pro"}`,
      cancel_url: `${SITE}/upgrade.html?canceled=true`
    });
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err.message);
    return res.status(500).json({ ok: false, error: "stripe_error", message: err.message || "unknown" });
  }
});

/* ---------------------------
   SIMULATION MODE
--------------------------- */
async function internalSimulatedScan() {
  const watches = await Watch.find({}).sort({ createdAt: -1 }).limit(5).lean();
  let alertsSent = 0;

  for (const w of watches) {
    await sendEmail(
      w.email,
      `NHS dentist update (simulation): accepting near ${w.postcode}`,
      `This is a simulation to verify alerts. If this were a real NHS update, you'd receive this email when a local practice starts accepting new patients near ${w.postcode}.`,
      "availability",
      { postcode: w.postcode, simulated: true }
    );
    alertsSent++;
  }
  return { checked: watches.length, found: alertsSent, alertsSent };
}

/* ---------------------------
   SCAN Endpoint
--------------------------- */
let cachedRunScan = null;
app.post("/api/scan", async (req, res) => {
  const t = process.env.SCAN_TOKEN || "";
  if (!t || (req.query.token !== t && req.headers["x-scan-token"] != t)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  try {
    const MODE = process.env.SCAN_MODE || "off";
    if (MODE === "simulate") {
      const result = await internalSimulatedScan();
      return res.json({ ok: true, ...(result || {}), mode: MODE, time: new Date().toISOString() });
    }

    if (!cachedRunScan) {
      try {
        const mod = await import("./scanner.js").catch(() => null);
        cachedRunScan = (mod && (mod.runScan || mod.default)) || (async () => ({ checked: 0, found: 0, alertsSent: 0 }));
      } catch {
        cachedRunScan = async () => ({ checked: 0, found: 0, alertsSent: 0 });
      }
    }

    const result = await cachedRunScan();
    return res.json({ ok: true, ...(result || {}), mode: MODE, time: new Date().toISOString() });
  } catch (e) {
    console.error("Scan failed:", e);
    return res.status(500).json({ ok: false, error: "scan_failed" });
  }
});

/* ---------------------------
   Static Files + Fallback
--------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------------------
   Start Server
--------------------------- */
app.listen(PORT, () => console.log(`🚀 Dentist Radar running on :${PORT}`));
