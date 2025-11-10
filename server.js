// Dentist Radar Server (aligned to 'watches' collection & curated emails)
// - Uses shared models.js (watches/users/emaillogs)
// - Welcome email uses HTML template via Postmark
// - Adds /api/debug/peek to verify DB/collections

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

import { runScan } from "./scanner.js";
import { renderEmail } from "./emailTemplates.js";
import { connectMongo, Watch, User, EmailLog, peek } from "./models.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

/* ---------------------------
   Mongo — connect to URI as-is
--------------------------- */
const RAW_URI = process.env.MONGO_URI || "";
connectMongo(RAW_URI)
  .then((c) => console.log("✅ MongoDB connected →", c?.name))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

/* ---------------------------
   Helpers (email + validation)
--------------------------- */
async function sendEmailHTML(to, subject, html, type = "other", meta = {}) {
  const key = process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("ℹ️ POSTMARK token not set → skip email.");
    return { ok: false, skipped: true };
  }
  try {
    const r = await axios.post(
      "https://api.postmarkapp.com/email",
      {
        From: process.env.MAIL_FROM || process.env.EMAIL_FROM || "alerts@dentistradar.co.uk",
        To: to,
        Subject: subject,
        HtmlBody: html,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": key,
        },
        timeout: 12000,
        validateStatus: () => true,
      }
    );

    const ok = r.status >= 200 && r.status < 300;
    const body = r.data || {};
    if (ok) {
      try {
        await EmailLog.create({
          to,
          subject,
          type,
          providerId: body.MessageID,
          meta,
          sentAt: new Date(),
        });
      } catch (e) {
        console.error("⚠️ EmailLog save error:", e?.message || e);
      }
    } else {
      console.error("❌ Postmark error:", r.status, body);
    }
    return { ok, status: r.status, body };
  } catch (e) {
    console.error("❌ Postmark exception:", e?.message);
    return { ok: false, error: e?.message };
  }
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
app.get("/api/health", (req, res) =>
  res.json({ ok: true, db: mongoose.connection?.name, time: new Date().toISOString() })
);
app.get("/health", (req, res) =>
  res.json({ ok: true, db: mongoose.connection?.name, time: new Date().toISOString() })
);

// Quick peek to verify we're on the correct DB/collection
app.get("/api/debug/peek", async (req, res) => {
  try {
    const info = await peek();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* ---------------------------
   Create Watch (Welcome email improved)
--------------------------- */
app.post("/api/watch/create", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const postcode = normalizePostcode(String(req.body?.postcode || ""));
    const radius = Number(req.body?.radius);

    if (!emailRe.test(email))
      return res
        .status(400)
        .json({ ok: false, error: "invalid_email", message: "Please enter a valid email address." });
    if (!looksLikeUkPostcode(postcode))
      return res.status(400).json({
        ok: false,
        error: "invalid_postcode",
        message: "Please enter a valid UK postcode (e.g. RG1 2AB).",
      });
    if (!radius || radius < 1 || radius > 30)
      return res.status(400).json({
        ok: false,
        error: "invalid_radius",
        message: "Please select a radius between 1 and 30 miles.",
      });

    // Duplicate check
    const exists = await Watch.findOne({ email, postcode }).lean();
    if (exists)
      return res
        .status(400)
        .json({ ok: false, error: "duplicate", message: "Alert already exists for this postcode." });

    // Plan limit
    const limit = await planLimitFor(email);
    const count = await Watch.countDocuments({ email });
    if (count >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        message: `Your plan allows up to ${limit} postcode${limit > 1 ? "s" : ""}.`,
        upgradeLink: "/pricing.html",
      });
    }

    await Watch.create({ email, postcode, radius });

    // Curated Welcome email
    const { subject, html } = renderEmail("welcome", { postcode, radius });
    await sendEmailHTML(email, subject, html, "welcome", { postcode, radius });

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
      success_url: `${SITE}/thankyou.html?plan=${plan || "pro"}`,
      cancel_url: `${SITE}/upgrade.html?canceled=true`,
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
const __dirname = path.dirname(__filename);
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------------------
   Start
--------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Dentist Radar running on :${PORT}`);
});
