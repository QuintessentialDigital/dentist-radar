// Dentist Radar Server (aligned to 'watches' collection & curated emails)
// - Uses shared models.js (watches/users/emaillogs)
// - Welcome email uses HTML template via Postmark
// - Adds /api/debug/peek to verify DB/collections
// - Phase 2: Stripe webhook + plan activation email + "My Alerts" APIs

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
// JSON body parsing for normal APIs (no Stripe signature verification yet)
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
        // Only log scanner alert emails to avoid duplicate key on (null, null, null)
        if (type === "alert") {
          await EmailLog.create({
            to,
            subject,
            type,
            providerId: body.MessageID,
            meta,
            sentAt: new Date(),
          });
        }
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

// UPDATED: make planLimitFor rely primarily on plan, not strict status
async function planLimitFor(email) {
  const u = await User.findOne({ email: normEmail(email) }).lean();
  if (!u) return 1;

  const plan = (u.plan || "").toLowerCase();
  const status = (u.status || "").toLowerCase();

  if (plan === "family") return u.postcode_limit || 10;
  if (plan === "pro") return u.postcode_limit || 5;

  if (status === "active" && u.postcode_limit) return u.postcode_limit;

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
    res
      .status(500)
      .json({ ok: false, error: "server_error", message: "Something went wrong. Please try again later." });
  }
});

/* ---------------------------
   "My Alerts" APIs (list + delete)
--------------------------- */

// List all watches for a given email
app.get("/api/watch/list", async (req, res) => {
  try {
    const emailRaw = req.query.email || "";
    const email = normEmail(emailRaw);

    if (!emailRe.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_email",
        message: "Please enter a valid email address.",
      });
    }

    const watches = await Watch.find({ email }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, email, watches });
  } catch (e) {
    console.error("watch/list error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Delete a single watch (only if it belongs to that email)
app.delete("/api/watch/:id", async (req, res) => {
  try {
    const emailRaw = req.query.email || "";
    const email = normEmail(emailRaw);
    const id = req.params.id;

    if (!emailRe.test(email)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_email",
        message: "Please enter a valid email address.",
      });
    }

    if (!id) {
      return res.status(400).json({ ok: false, error: "missing_id" });
    }

    const deleted = await Watch.findOneAndDelete({ _id: id, email });
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    res.json({ ok: true, deletedId: id });
  } catch (e) {
    console.error("watch/delete error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
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
    const planKey = (plan || "pro").toLowerCase() === "family" ? "family" : "pro";
    const priceId = planKey === "family" ? priceFamily : pricePro;
    if (!priceId) return res.json({ ok: false, error: "missing_price" });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      metadata: {
        plan: planKey, // so webhook knows whether it's pro or family
      },
      success_url: `${SITE}/thankyou.html?plan=${planKey}`,
      cancel_url: `${SITE}/upgrade.html?canceled=true`,
    });
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err?.type, err?.code, err?.message);
    return res
      .status(500)
      .json({ ok: false, error: "stripe_error", message: err?.message || "unknown" });
  }
}

app.post("/api/create-checkout-session", handleCheckoutSession);
app.post("/api/stripe/create-checkout-session", handleCheckoutSession);

/* ---------------------------
   Stripe Webhook (plan activation + email)
   NOTE: this version assumes JSON body (no signature verification yet).
--------------------------- */
app.post("/api/stripe/webhook", async (req, res) => {
  try {
    const event = req.body;

    if (!event || !event.type) {
      return res.status(400).send(`Webhook Error: invalid payload`);
    }

    // Handle successful checkout
    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      const rawEmail =
        session.customer_details?.email || session.customer_email || session.client_reference_id || "";
      const email = normEmail(rawEmail);
      const planRaw = session.metadata?.plan || "pro";
      const plan = planRaw === "family" ? "family" : "pro";
      const postcode_limit = plan === "family" ? 10 : 5;

      if (email && emailRe.test(email)) {
        // Upsert User with plan, status, and limit
        const update = {
          email,
          plan,
          status: "active",
          postcode_limit,
        };

        await User.findOneAndUpdate(
          { email },
          { $set: update },
          { upsert: true, new: true }
        );

        // Send DentistRadar plan activation email
        const planLabel = plan === "family" ? "Family" : "Pro";
        const subject = `Your DentistRadar ${planLabel} plan is now active`;
        const html = `
          <html>
            <body style="font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333;line-height:1.6;">
              <h2 style="color:#0b63ff;">Your ${planLabel} plan is active 🎉</h2>
              <p>Hi,</p>
              <p>Thank you for upgrading to <strong>DentistRadar ${planLabel}</strong>.</p>
              <p>You can now track up to <strong>${postcode_limit} postcode${
                postcode_limit > 1 ? "s" : ""
              }</strong> for NHS dentist availability.</p>
              <p>What you can do next:</p>
              <ul>
                <li>Add or update your alerts on the homepage using your email.</li>
                <li>Manage or remove existing alerts on the “My Alerts” page.</li>
              </ul>
              <p>If you have any questions or feedback, just reply to this email.</p>
              <p>Best regards,<br>DentistRadar</p>
            </body>
          </html>
        `;

        await sendEmailHTML(email, subject, html, "plan_activated", {
          plan,
          postcode_limit,
          stripeSessionId: session.id,
        });

        console.log(`✅ Stripe webhook: activated ${planLabel} for ${email}`);
      } else {
        console.warn("⚠️ Stripe webhook: missing or invalid email on checkout.session.completed");
      }
    }

    // You can extend here later for subscription cancellations, etc.
    res.json({ received: true });
  } catch (err) {
    console.error("❌ Stripe webhook error:", err?.message || err);
    res.status(500).send(`Webhook Error: ${err?.message || "unknown"}`);
  }
});

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
    res.json(
      result && typeof result === "object"
        ? result
        : { ok: true, checked: 0, found: 0, alertsSent: 0 }
    );
  } catch (err) {
    console.error("❌ /api/scan error:", err);
    res.json({
      ok: true,
      checked: 0,
      found: 0,
      alertsSent: 0,
      note: "scan_exception",
    });
  }
});

/* ---------------------------
   SPA Fallback
--------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

/* ---------------------------
   Start
--------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Dentist Radar running on :${PORT}`);
});
