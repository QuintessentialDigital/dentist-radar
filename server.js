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
        From:
          process.env.MAIL_FROM ||
          process.env.EMAIL_FROM ||
          "alerts@dentistradar.co.uk",
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
  return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test(
    (pc || "").toUpperCase()
  );
}
async function planLimitFor(email) {
  const u = await User.findOne({ email: normEmail(email) }).lean();
  if (!u || u.status !== "active") return 1;
  if (u.plan === "family") return u.postcode_limit || 10;
  if (u.plan === "pro") return u.postcode_limit || 5;
  return 1;
}

/* ---------------------------
   Basic Admin Auth Helper
--------------------------- */
function checkAdminKey(req, res) {
  const expected = process.env.ADMIN_KEY;
  const key =
    req.query.key ||
    req.headers["x-admin-key"] ||
    req.headers["x-api-key"];

  if (!expected || key !== expected) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/* ---------------------------
   Health / Debug
--------------------------- */
app.get("/api/health", (req, res) =>
  res.json({
    ok: true,
    db: mongoose.connection?.name,
    time: new Date().toISOString(),
  })
);
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    db: mongoose.connection?.name,
    time: new Date().toISOString(),
  })
);

// Richer health endpoint with counts + last scan
app.get("/healthz", async (req, res) => {
  try {
    const { users, watches, logs } = await peek();

    const lastScan = await Watch.findOne(
      { lastRunAt: { $ne: null } },
      { lastRunAt: 1 }
    )
      .sort({ lastRunAt: -1 })
      .lean();

    res.json({
      status: "ok",
      time: new Date().toISOString(),
      mongo: {
        db: mongoose.connection?.name,
        users,
        watches,
        emailLogs: logs,
      },
      lastScanAt: lastScan?.lastRunAt || null,
    });
  } catch (err) {
    console.error("Healthz error:", err.message);
    res.status(500).json({ status: "error", error: err.message });
  }
});

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
   Admin JSON Overview
--------------------------- */
app.get("/api/admin/overview", async (req, res) => {
  if (!checkAdminKey(req, res)) return;

  try {
    const { users, watches, logs } = await peek();

    const lastScan = await Watch.findOne(
      { lastRunAt: { $ne: null } },
      { lastRunAt: 1 }
    )
      .sort({ lastRunAt: -1 })
      .lean();

    const topPostcodes = await Watch.aggregate([
      { $group: { _id: "$postcode", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);

    const recentLogs = await EmailLog.find({})
      .sort({ sentAt: -1 })
      .limit(10)
      .lean();

    res.json({
      status: "ok",
      time: new Date().toISOString(),
      totals: { users, watches, emailLogs: logs },
      lastScanAt: lastScan?.lastRunAt || null,
      topPostcodes,
      recentLogs,
    });
  } catch (err) {
    console.error("Admin overview error:", err.message);
    res.status(500).json({ status: "error", error: err.message });
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
      return res.status(400).json({
        ok: false,
        error: "invalid_email",
        message: "Please enter a valid email address.",
      });
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
      return res.status(400).json({
        ok: false,
        error: "duplicate",
        message: "Alert already exists for this postcode.",
      });

    // Plan limit
    const limit = await planLimitFor(email);
    const count = await Watch.countDocuments({ email });
    if (count >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        message: `Your plan allows up to ${limit} postcode${
          limit > 1 ? "s" : ""
        }.`,
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
      .json({
        ok: false,
        error: "server_error",
        message: "Something went wrong. Please try again later.",
      });
  }
});

/* ---------------------------
   Stripe Checkout (compat route names)
--------------------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

async function handleCheckoutSession(req, res) {
  try {
    if (!stripe)
      return res.json({ ok: false, error: "stripe_not_configured" });
    const { email, plan } = req.body || {};
    if (!emailRe.test(email || ""))
      return res.json({ ok: false, error: "invalid_email" });

    const SITE =
      process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";
    const pricePro = process.env.STRIPE_PRICE_PRO;
    const priceFamily = process.env.STRIPE_PRICE_FAMILY;
    const priceId =
      (plan || "pro").toLowerCase() === "family" ? priceFamily : pricePro;
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
    return res.status(500).json({
      ok: false,
      error: "stripe_error",
      message: err?.message || "unknown",
    });
  }
}

app.post("/api/create-checkout-session", handleCheckoutSession);
app.post("/api/stripe/create-checkout-session", handleCheckoutSession);

/* ---------------------------
   Manual / Cron Scan Endpoint (token-gated)
--------------------------- */
app.post("/api/scan", async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (
    !token ||
    (req.query.token !== token && req.headers["x-scan-token"] !== token)
  ) {
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
   Unsubscribe Endpoint
--------------------------- */
app.get("/unsubscribe", async (req, res) => {
  const { alert, email } = req.query;

  if (!alert || !email) {
    return res.status(400).send(`
      <html>
        <body style="font-family: Arial, sans-serif;">
          <h2>Unable to unsubscribe</h2>
          <p>The unsubscribe link is missing some information. Please check the link or contact support.</p>
        </body>
      </html>
    `);
  }

  try {
    const watch = await Watch.findOneAndUpdate(
      { _id: alert, email: normEmail(email) },
      { $set: { active: false } },
      { new: true }
    ).lean();

    if (!watch) {
      return res.status(404).send(`
        <html>
          <body style="font-family: Arial, sans-serif;">
            <h2>Alert not found</h2>
            <p>We couldn’t find an active alert matching this link. It may already have been unsubscribed.</p>
          </body>
        </html>
      `);
    }

    const radius = watch.radiusMiles ?? watch.radius ?? 25;

    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; max-width:600px; margin:40px auto; line-height:1.5;">
          <h2 style="color:#0b5cff;">You’ve been unsubscribed from this DentistRadar alert</h2>
          <p>
            We’ve stopped sending alerts for the postcode
            <strong>${watch.postcode}</strong> within <strong>${radius} miles</strong>
            to <strong>${email}</strong>.
          </p>
          <p>If this was a mistake, you can create a new alert any time from the DentistRadar website.</p>
          <p style="font-size:12px;color:#777;margin-top:24px;">
            If you have any questions, please contact DentistRadar support.
          </p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Unsubscribe error:", err.message);
    res.status(500).send(`
      <html>
        <body style="font-family: Arial, sans-serif;">
          <h2>Sorry, something went wrong</h2>
          <p>We weren’t able to process your unsubscribe request. Please try again later or contact support.</p>
        </body>
      </html>
    `);
  }
});

/* ---------------------------
   Admin Dashboard (HTML)
   NOTE: your existing admin.html still works at /admin.html
--------------------------- */
app.get("/admin/dashboard", async (req, res) => {
  if (!checkAdminKey(req, res)) return;

  try {
    const { users, watches, logs } = await peek();

    const lastScan = await Watch.findOne(
      { lastRunAt: { $ne: null } },
      { lastRunAt: 1 }
    )
      .sort({ lastRunAt: -1 })
      .lean();

    const alerts = await Watch.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const recentLogs = await EmailLog.find({})
      .sort({ sentAt: -1 })
      .limit(50)
      .lean();

    const lastScanAt = lastScan?.lastRunAt
      ? new Date(lastScan.lastRunAt).toISOString()
      : "never";

    const html = `
      <html>
        <head>
          <title>DentistRadar Admin Dashboard</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 1100px; margin: 30px auto; }
            h1, h2 { color: #0b5cff; }
            table { border-collapse: collapse; width: 100%; margin-bottom: 24px; font-size: 13px; }
            th, td { border: 1px solid #e0e0e0; padding: 6px 8px; text-align: left; }
            th { background: #f5f7fb; }
            .card { border:1px solid #e0e0e0; border-radius:8px; padding:12px 16px; margin-bottom:16px; background:#fafbff; }
            .muted { color:#777; font-size:12px; }
          </style>
        </head>
        <body>
          <h1>DentistRadar Admin Dashboard</h1>

          <div class="card">
            <h2>Overview</h2>
            <p>
              <strong>Users:</strong> ${users} &nbsp;&nbsp;
              <strong>Alerts (watches):</strong> ${watches} &nbsp;&nbsp;
              <strong>Email logs:</strong> ${logs}
            </p>
            <p class="muted">Last scan: ${lastScanAt}</p>
          </div>

          <div class="card">
            <h2>Recent Alerts (latest 50)</h2>
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Postcode</th>
                  <th>Radius</th>
                  <th>Active</th>
                  <th>Created</th>
                  <th>Last run</th>
                </tr>
              </thead>
              <tbody>
                ${alerts
                  .map((a) => {
                    const radius = a.radiusMiles ?? a.radius ?? "";
                    const created = a.createdAt
                      ? new Date(a.createdAt)
                          .toISOString()
                          .slice(0, 19)
                          .replace("T", " ")
                      : "";
                    const lastRun = a.lastRunAt
                      ? new Date(a.lastRunAt)
                          .toISOString()
                          .slice(0, 19)
                          .replace("T", " ")
                      : "";
                    return `
                      <tr>
                        <td>${a.email}</td>
                        <td>${a.postcode}</td>
                        <td>${radius}</td>
                        <td>${a.active ? "Yes" : "No"}</td>
                        <td>${created}</td>
                        <td>${lastRun}</td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h2>Recent Email Logs (latest 50)</h2>
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Postcode</th>
                  <th>Radius</th>
                  <th>Practice ID</th>
                  <th>Appointment URL</th>
                  <th>Sent at</th>
                </tr>
              </thead>
              <tbody>
                ${recentLogs
                  .map((l) => {
                    const sentAt = l.sentAt
                      ? new Date(l.sentAt)
                          .toISOString()
                          .slice(0, 19)
                          .replace("T", " ")
                      : "";
                    return `
                      <tr>
                        <td>${l.email || l.to || ""}</td>
                        <td>${l.postcode || ""}</td>
                        <td>${l.radiusMiles ?? ""}</td>
                        <td>${l.practiceId || ""}</td>
                        <td>${
                          l.appointmentUrl
                            ? `<a href="${l.appointmentUrl}" target="_blank">link</a>`
                            : ""
                        }</td>
                        <td>${sentAt}</td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>

          <p class="muted">
            Accessed at ${new Date().toISOString()}
          </p>
        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error("Admin dashboard error:", err.message);
    res.status(500).send("Admin dashboard error");
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
