// Dentist Radar Server (aligned to 'watches' collection & curated emails)
// - Uses shared models.js (watches/users/emaillogs)
// - Welcome email uses HTML template via Postmark
// - Adds /api/debug/peek to verify DB/collections
// - Stripe webhook + plan activation email + "My Alerts" APIs + Unsubscribe

import express from "express";
import { scanPostcode } from "./scanner.js"; // Pure scanner: NHS -> JSON summary
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

import { renderEmail } from "./emailTemplates.js";
import { connectMongo, Watch, User, EmailLog, peek } from "./models.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
// ✅ Allow standard HTML form posts (application/x-www-form-urlencoded)
app.use(express.urlencoded({ extended: false }));
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
  return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test(
    (pc || "").toUpperCase()
  );
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

app.get("/api/debug/peek", async (req, res) => {
  try {
    const info = await peek();
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message });
  }
});

/* ---------------------------
   Shared Watch Creation Handler
--------------------------- */
async function handleCreateWatch(req, res) {
  try {
    const email = normEmail(req.body?.email);
    const postcode = normalizePostcode(String(req.body?.postcode || ""));
    const radius = Number(req.body?.radius);

    console.log("🔔 /api/watch(create) body:", req.body);

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

    const watch = await Watch.create({ email, postcode, radius });

    // 1) Welcome email
    const { subject: welcomeSubject, html: welcomeHtml } = renderEmail(
      "welcome",
      { postcode, radius }
    );
    await sendEmailHTML(email, welcomeSubject, welcomeHtml, "welcome", {
      postcode,
      radius,
    });

    // 2) Run scanner once and send premium acceptance email if any
    console.log(
      `[WATCH] Running immediate scan for ${email} – ${postcode} (${radius}mi)`
    );
    let scanResult;
    try {
      scanResult = await scanPostcode(postcode, radius);
    } catch (err) {
      console.error("[WATCH] scanPostcode error:", err?.message || err);
      // Don't break signup if scan fails; just return success without alert
      return res.json({
        ok: true,
        message: "Alert created (scan failed, no acceptance email).",
      });
    }

    if (scanResult.acceptingCount > 0) {
      const practices = scanResult.accepting || [];
      const year = new Date().getFullYear();

      const rowsHtml = practices
        .map((p) => {
          const name = p.name || "Unknown practice";
          const phone = p.phone || "Not available";

          const patientType = p.patientType
            ? p.patientType
            : p.childOnly
            ? "Children only"
            : "Adults & children";

          const distance =
            p.distanceText ||
            (typeof p.distanceMiles === "number"
              ? `${p.distanceMiles.toFixed(1)} miles`
              : "");

          const nhsUrl = p.nhsUrl || p.profileUrl || "#";

          const mapUrl =
            p.mapUrl ||
            `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${name} ${p.address || ""} ${postcode}`
            )}`;

          return `
            <tr>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px;">
                <strong>${name}</strong>
              </td>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px;">
                ${patientType}
              </td>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px; white-space:nowrap;">
                ${distance || ""}
              </td>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px;">
                ${phone}
              </td>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px;">
                <a href="${nhsUrl}" style="color:#0b63ff; text-decoration:none;">View on NHS</a>
              </td>
              <td style="border-bottom:1px solid #e5e7eb; padding:8px;">
                <a href="${mapUrl}" style="color:#0b63ff; text-decoration:none;">View map</a>
              </td>
            </tr>
          `;
        })
        .join("");

      const alertSubject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

      const alertHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>DentistRadar – NHS dentist alert</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f6fb; font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 8px 20px rgba(15, 23, 42, 0.08);">
            <tr>
              <td style="background:#0b63ff; padding:16px 24px; color:#ffffff;">
                <div style="font-size:20px; font-weight:700;">
                  DentistRadar
                </div>
                <div style="font-size:13px; opacity:0.85;">
                  NHS dentist availability alert
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:24px 24px 16px 24px;">
                <h2 style="margin:0 0 12px 0; font-size:20px; color:#111827;">
                  Good news – NHS dentists are accepting new patients near you
                </h2>

                <p style="margin:0 0 10px 0; font-size:14px; color:#4b5563; line-height:1.6;">
                  You are receiving this alert from <strong>DentistRadar</strong> because you registered 
                  for updates for postcode <strong>${postcode}</strong> within 
                  <strong>${radius} miles</strong>.
                </p>

                <p style="margin:0 0 18px 0; font-size:14px; color:#4b5563; line-height:1.6;">
                  Based on the latest information from the NHS website, the following practices are currently 
                  shown as <strong>accepting new NHS patients</strong> (subject to change and availability):
                </p>

                <div style="border:1px solid #e5e7eb; border-radius:10px; overflow:hidden;">
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="8" style="border-collapse:collapse; font-size:13px;">
                    <thead>
                      <tr style="background:#f3f4ff;">
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">Practice</th>
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">Patient type</th>
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">Distance</th>
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">Phone</th>
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">NHS page</th>
                        <th align="left" style="padding:10px 8px; border-bottom:1px solid #e5e7eb;">Map</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${rowsHtml}
                    </tbody>
                  </table>
                </div>

                <p style="margin:18px 0 8px 0; font-size:14px; color:#374151; line-height:1.6;">
                  <strong>Tip:</strong> NHS availability can change quickly. If you find a suitable practice, 
                  contact them as soon as possible to confirm they are still accepting new patients and to check 
                  appointment availability.
                </p>

                <p style="margin:8px 0 0 0; font-size:12px; color:#6b7280; line-height:1.6;">
                  This email is based on publicly available information from the NHS website at the time of scanning.
                  DentistRadar does not guarantee availability and cannot book appointments on your behalf.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 24px 18px 24px; border-top:1px solid #e5e7eb; font-size:12px; color:#9ca3af;">
                <div>
                  You are receiving this because you created an alert on DentistRadar for postcode ${postcode}.
                </div>
                <div style="margin-top:4px;">
                  © ${year} DentistRadar. All rights reserved.
                </div>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

      await sendEmailHTML(email, alertSubject, alertHtml, "alert", {
        postcode,
        radius,
        acceptingCount: practices.length,
        watchId: watch._id,
      });

      console.log(
        `[WATCH] Sent premium acceptance alert email to ${email} with ${practices.length} accepting practice(s).`
      );
    } else {
      console.log(
        `[WATCH] No accepting practices found for ${postcode} (${radius}mi) at signup.`
      );
    }

    return res.json({
      ok: true,
      message: "Alert created!",
      scanSummary: {
        acceptingCount: scanResult.acceptingCount,
        notAcceptingCount: scanResult.notAcceptingCount,
        scanned: scanResult.scanned,
      },
    });
  } catch (e) {
    console.error("watch/create error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}

/* ---------------------------
   Create Watch routes (old + new)
--------------------------- */

// OLD path for compatibility (forms or JS calling /api/watch)
app.post("/api/watch", handleCreateWatch);

// NEW explicit path
app.post("/api/watch/create", handleCreateWatch);

/* ---------------------------
   My Alerts APIs
--------------------------- */
app.get("/api/watch/list", async (req, res) => {
  try {
    const email = normEmail(req.query.email || "");
    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email" });

    const watches = await Watch.find({ email })
      .sort({ createdAt: -1 })
      .lean();
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
    if (!deleted)
      return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, deletedId: id });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   Manual Scan (for testing scanner only, no emails)
--------------------------- */
app.get("/api/scan", async (req, res) => {
  try {
    const { postcode, radius } = req.query;
    if (!postcode) {
      return res.status(400).json({ error: "postcode is required" });
    }
    const radiusMiles = Number(radius) || 5;

    console.log(
      `🧪 /api/scan called for postcode="${postcode}", radius=${radiusMiles}`
    );

    const result = await scanPostcode(postcode, radiusMiles);
    res.json(result);
  } catch (err) {
    console.error("Error in /api/scan:", err);
    res
      .status(500)
      .json({ error: "Scan failed", details: err.message });
  }
});

/* ---------------------------
   Stripe Checkout + Webhook
--------------------------- */
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const stripe = STRIPE_KEY ? new Stripe(STRIPE_KEY) : null;

// (Stripe handlers unchanged – same as before)
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

    const planKey =
      (plan || "pro").toLowerCase() === "family" ? "family" : "pro";
    const priceId = planKey === "family" ? priceFamily : pricePro;
    if (!priceId)
      return res.json({ ok: false, error: "missing_price" });

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
    return res
      .status(500)
      .json({ ok: false, error: "stripe_error" });
  }
}

app.post("/api/create-checkout-session", handleCheckoutSession);
app.post(
  "/api/stripe/create-checkout-session",
  handleCheckoutSession
);

app.post("/api/stripe/webhook", async (req, res) => {
  try {
    const event = req.body;
    if (!event || !event.type)
      return res.status(400).send("invalid payload");

    if (event.type === "checkout.session.completed") {
      const session = event.data?.object || {};
      const rawEmail =
        session.customer_details?.email ||
        session.customer_email ||
        session.client_reference_id ||
        "";
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
        const SITE =
          process.env.PUBLIC_ORIGIN ||
          "https://www.dentistradar.co.uk";
        const manageUrl = `${SITE}/my-alerts.html?email=${encodeURIComponent(
          email
        )}`;

        const html = `
          <h2>Your ${planLabel} plan is active 🎉</h2>
          <p>You can now track up to <strong>${postcode_limit} postcodes</strong>.</p>
          <p><a href="${manageUrl}">Manage your alerts</a></p>
        `;

        await sendEmailHTML(
          email,
          `Your ${planLabel} plan is active`,
          html,
          "plan_activated",
          {
            plan,
            postcode_limit,
            stripeSessionId: session.id,
          }
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err?.message);
    res
      .status(500)
      .send(`Webhook Error: ${err?.message}`);
  }
});

/* ---------------------------
   Unsubscribe Routes
--------------------------- */
function renderUnsubscribePage(success, infoText) {
  const title = success
    ? "You have been unsubscribed"
    : "Unsubscribe";
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
    if (!id)
      return res
        .status(400)
        .send(
          renderUnsubscribePage(false, "Invalid unsubscribe link.")
        );

    const deleted = await Watch.findByIdAndDelete(id);
    if (!deleted)
      return res
        .status(404)
        .send(
          renderUnsubscribePage(false, "Alert not found.")
        );

    const pc = deleted.postcode || "";
    return res.send(
      renderUnsubscribePage(
        true,
        `You will no longer receive alerts for <strong>${pc}</strong>.`
      )
    );
  } catch (e) {
    return res
      .status(500)
      .send(
        renderUnsubscribePage(
          false,
          "Something went wrong."
        )
      );
  }
});

app.get("/unsubscribe/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const deleted = await Watch.findByIdAndDelete(id);

    if (!deleted)
      return res
        .status(404)
        .send(
          renderUnsubscribePage(false, "Alert not found.")
        );
    const pc = deleted.postcode || "";

    return res.send(
      renderUnsubscribePage(
        true,
        `You will no longer receive alerts for <strong>${pc}</strong>.`
      )
    );
  } catch (e) {
    return res
      .status(500)
      .send(
        renderUnsubscribePage(
          false,
          "Something went wrong."
        )
      );
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
