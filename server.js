// Dentist Radar Server (aligned to 'watches' collection & curated emails)
// - Uses shared models.js (watches/users/emaillogs)
// - Welcome email uses HTML template via Postmark
// - Adds /api/debug/peek to verify DB/collections
// - Phase 2: Stripe webhook + plan activation email + "My Alerts" APIs + Unsubscribe

import express from "express";
import { scanPostcodeRadius } from "./scanner.js";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

import { runAllScans } from "./scanner.js";
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
    if (ok && type === "alert") {
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
    } else if (!ok) {
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
  const e = normEmail(email);
  const u = await User.findOne({ email: e }).lean();
  if (!u) return 1;

  const plan = (u.plan || "").toLowerCase();
  if (plan === "family") return 10;
  if (plan === "pro") return 5;

  return 5;
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

app.get("/api/debug/peek", async (req, res) => {
  try {
    const info = await peek();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* ---------------------------
   Create Watch (Welcome email)
--------------------------- */
app.post("/api/watch/create", async (req, res) => {
  try {
    const email = normEmail(req.body?.email);
    const postcode = normalizePostcode(String(req.body?.postcode || ""));
    const radius = Number(req.body?.radius);

    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email" });

    if (!looksLikeUkPostcode(postcode))
      return res.status(400).json({ ok: false, error: "invalid_postcode" });

    if (!radius || radius < 1 || radius > 30)
      return res.status(400).json({ ok: false, error: "invalid_radius" });

    const exists = await Watch.findOne({ email, postcode }).lean();
    if (exists)
      return res.status(400).json({ ok: false, error: "duplicate" });

    const limit = await planLimitFor(email);
    const count = await Watch.countDocuments({ email });
    if (count >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        upgradeLink: "/pricing.html",
      });
    }

    await Watch.create({ email, postcode, radius });

    const { subject, html } = renderEmail("welcome", { postcode, radius });
    await sendEmailHTML(email, subject, html, "welcome", { postcode, radius });

    res.json({ ok: true, message: "Alert created!" });
  } catch (e) {
    console.error("watch/create error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   My Alerts APIs
--------------------------- */
app.get("/api/watch/list", async (req, res) => {
  try {
    const email = normEmail(req.query.email || "");
    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email" });

    const watches = await Watch.find({ email }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, email, watches });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/watch/:id", async (req, res) => {
  try {
    const email = normEmail(req.query.email || "");
    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email" });

    const id = req.params.id;
    const deleted = await Watch.findOneAndDelete({ _id: id, email });
    if (!deleted) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   Stripe Checkout + Webhook
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
      metadata: { plan: planKey },
      success_url: `${SITE}/thankyou.html?plan=${planKey}`,
      cancel_url: `${SITE}/upgrade.html?canceled=true`,
    });
    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err?.message);
    return res.status(500).json({ ok: false, error: "stripe_error" });
  }
}

app.post("/api/create-checkout-session", handleCheckoutSession);
app.post("/api/stripe/create-checkout-session", handleCheckoutSession);

app.post("/api/stripe/webhook", async (req, res) => {
  try {
    const event = req.body;
    if (!event || !event.type) return res.status(400).send("invalid payload");

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      const rawEmail =
        session.customer_details?.email || session.customer_email || session.client_reference_id || "";
      const email = normEmail(rawEmail);
      const planRaw = session.metadata?.plan || "pro";
      const plan = planRaw === "family" ? "family" : "pro";
      const postcode_limit = plan === "family" ? 10 : 5;

      if (emailRe.test(email)) {
        await User.findOneAndUpdate(
          { email },
          { $set: { email, plan, status: "active", postcode_limit } },
          { upsert: true, new: true }
        );

        const planLabel = plan === "family" ? "Family" : "Pro";
        const SITE = process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";
        const manageUrl = `${SITE}/my-alerts.html?email=${encodeURIComponent(email)}`;

        const html = `
          <h2>Your ${planLabel} plan is active 🎉</h2>
          <p>You can now track up to <strong>${postcode_limit} postcodes</strong>.</p>
          <p><a href="${manageUrl}">Manage your alerts</a></p>
        `;

        await sendEmailHTML(email, `Your ${planLabel} plan is active`, html, "plan_activated", {
          plan,
          postcode_limit,
          stripeSessionId: session.id,
        });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err?.message);
    res.status(500).send(`Webhook Error: ${err?.message}`);
  }
});

/* ---------------------------
   Manual Scan (token-gated)
--------------------------- */
// Simple test API – NO EMAILS, just returns JSON summary
app.get("/api/scan", async (req, res) => {
  try {
    const postcode = (req.query.postcode || "").toString().trim();
    const radiusMiles = Number(req.query.radius || "25");

    if (!postcode) {
      return res
        .status(400)
        .json({ error: "postcode query parameter is required" });
    }

    console.log(
      `🧪 /api/scan called for postcode="${postcode}", radius=${radiusMiles}`
    );

    // This only scans and returns data – does NOT send emails
    const summary = await scanPostcodeRadius(postcode, radiusMiles, {
      dryRun: true,
    });

    // Optional: don’t return the full HTML, just JSON
    return res.json({
  ok: true,
  postcode: summary.postcode,
  radiusMiles: summary.radiusMiles,
  accepting: summary.accepting,
  childOnly: summary.childOnly,
  notAccepting: summary.notAccepting,
  scanned: summary.scanned,
  tookMs: summary.tookMs,
  allPractices: summary.allPractices.map((p) => ({
    name: p.name,
    distanceText: p.distanceText,
    phone: p.phone,
    profileUrl: p.profileUrl,
    appointmentsUrl: p.appointmentsUrl,
    accepting: p.accepting,
    childOnly: p.childOnly,
    notAccepting: p.notAccepting,
  })),
});

  } catch (err) {
    console.error("❌ /api/scan error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});



/* ---------------------------
   Unsubscribe Routes
--------------------------- */
function renderUnsubscribePage(success, infoText) {
  const title = success ? "You have been unsubscribed" : "Unsubscribe";
  const body = infoText;

  return `
    <html>
      <body style="font-family:system-ui;background:#fafafa;padding:40px;">
        <div style="max-width:480px;margin:auto;background:#fff;border-radius:10px;padding:25px;border:1px solid #eee;">
          <h1>${title}</h1>
          <p>${body}</p>
          <a href="/" style="padding:10px 18px;background:#0b63ff;color:#fff;border-radius:8px;text-decoration:none;">Back</a>
        </div>
      </body>
    </html>
  `;
}

app.get("/unsubscribe", async (req, res) => {
  try {
    const id = req.query.alertId || req.query.alert;
    if (!id) return res.status(400).send(renderUnsubscribePage(false, "Invalid unsubscribe link."));

    const deleted = await Watch.findByIdAndDelete(id);
    if (!deleted) return res.status(404).send(renderUnsubscribePage(false, "Alert not found."));

    const pc = deleted.postcode || "";
    return res.send(renderUnsubscribePage(true, `You will no longer receive alerts for <strong>${pc}</strong>.`));
  } catch (e) {
    return res.status(500).send(renderUnsubscribePage(false, "Something went wrong."));
  }
});

app.get("/unsubscribe/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await Watch.findByIdAndDelete(id);

    if (!deleted) return res.status(404).send(renderUnsubscribePage(false, "Alert not found."));
    const pc = deleted.postcode || "";

    return res.send(renderUnsubscribePage(true, `You will no longer receive alerts for <strong>${pc}</strong>.`));
  } catch (e) {
    return res.status(500).send(renderUnsubscribePage(false, "Something went wrong."));
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
   Start server
--------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 DentistRadar running on :${PORT}`);
});
