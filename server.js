// Dentist Radar Server (aligned to 'watches' collection & curated emails)
// - Uses shared models.js (watches/users/emaillogs)
// - Welcome email uses HTML template via Postmark
// - Adds /api/debug/peek to verify DB/collections
// - Stripe webhook + plan activation email + "My Alerts" APIs + Unsubscribe
// - Phase 2: Grouped scans (runAllScans) + admin endpoint for dryRun/testing

import express from "express";
import { scanPostcode } from "./scanner.js";
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
// Allow standard HTML form posts
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
   Global Cron State
--------------------------- */
let lastCronRun = null;

/* ---------------------------
   Helpers (email + validation)
--------------------------- */
async function sendEmailHTML(to, subject, html, type = "other", meta = {}) {
  const key = process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("ℹ️ POSTMARK token not set → skip email.");
    return { ok: false, skipped: true };
  }

  // 🔒 Global throttle for alert emails: max 1 per user per 6 hours
  if (type === "alert") {
    try {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const recentAlert = await EmailLog.findOne({
        to,
        type: "alert",
        sentAt: { $gte: sixHoursAgo },
      })
        .sort({ sentAt: -1 })
        .lean();

      if (recentAlert) {
        console.log(
          `⏱ Skipping alert to ${to} due to global throttle (last at ${recentAlert.sentAt})`
        );
        return { ok: false, skipped: true, reason: "throttled" };
      }
    } catch (e) {
      console.error("⚠️ Throttle check error:", e?.message || e);
      // fail open if throttle lookup fails – better to send than break alert flow
    }
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

function detectUkRegion(postcode) {
  const pc = (postcode || "").toUpperCase().trim();

  const m = pc.match(/^([A-Z]{1,2})/);
  if (!m) return "OTHER";
  const area = m[1];

  const NI = ["BT"]; // Northern Ireland

  const SCOTLAND = [
    "AB",
    "DD",
    "DG",
    "EH",
    "FK",
    "G",
    "HS",
    "IV",
    "KA",
    "KW",
    "KY",
    "ML",
    "PA",
    "PH",
    "TD",
    "ZE",
  ];

  const WALES = ["CF", "LD", "LL", "NP", "SA", "SY"];

  const CHANNEL_ISLANDS = ["GY", "JE"];
  const IOM = ["IM"];

  if (NI.includes(area)) return "NI";
  if (SCOTLAND.includes(area)) return "SCOTLAND";
  if (WALES.includes(area)) return "WALES";
  if (CHANNEL_ISLANDS.includes(area)) return "CHANNEL_ISLANDS";
  if (IOM.includes(area)) return "IOM";

  return "ENGLAND";
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

/**
 * Build the acceptance alert email (subject + HTML)
 * shared between:
 *  - immediate scan on signup
 *  - grouped cron scans (runAllScans)
 */
function buildAcceptanceEmail(postcode, radius, practices, opts = {}) {
  const year = new Date().getFullYear();
  const { manageUrl, unsubscribeUrl } = opts;

  const rowsHtml = practices
    .map((p) => {
      const name = p.name || "Unknown practice";
      const phone = p.phone || "Not available";

      const patientType =
        p.patientType ||
        (p.childOnly ? "Children only" : "Adults & children");

      const distance =
        p.distanceText ||
        (typeof p.distanceMiles === "number"
          ? `${p.distanceMiles.toFixed(1)} miles`
          : "");

      const nhsUrl = p.nhsUrl || "#";

      const mapUrl =
        p.mapUrl ||
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${name} ${p.address || ""} ${postcode}`
        )}`;

      return `
        <tr>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0;">
            <strong>${name}</strong><br/>
            <span style="font-size:12px; color:#6b7280;">${p.address || ""}</span>
          </td>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0;">
            ${patientType}
          </td>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0; white-space:nowrap;">
            ${distance || ""}
          </td>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0;">
            ${phone}
          </td>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0;">
            ${
              nhsUrl && nhsUrl !== "#"
                ? `<a href="${nhsUrl}" style="color:#0b63ff; text-decoration:none;">View on NHS</a>`
                : `<span style="color:#9ca3af;">N/A</span>`
            }
          </td>
          <td style="padding:10px; border-bottom:1px solid #f0f0f0;">
            <a href="${mapUrl}" style="color:#0b63ff; text-decoration:none;">View map</a>
          </td>
        </tr>
      `;
    })
    .join("");

  const subject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

  const manageBlock =
    manageUrl || unsubscribeUrl
      ? `
        <p style="margin:14px 0 4px 0; font-size:12px; color:#4b5563; line-height:1.6;">
          You can manage or stop these alerts at any time:
          ${
            manageUrl
              ? ` <a href="${manageUrl}" style="color:#0b63ff; text-decoration:none;">Manage your alerts</a>`
              : ""
          }
          ${manageUrl && unsubscribeUrl ? " &nbsp;•&nbsp;" : ""}
          ${
            unsubscribeUrl
              ? `<a href="${unsubscribeUrl}" style="color:#0b63ff; text-decoration:none;">Unsubscribe instantly</a>`
              : ""
          }
        </p>
      `
      : "";

  const englandNote = `
    <p style="margin:6px 0 0 0; font-size:11px; color:#6b7280; line-height:1.6;">
      DentistRadar currently supports NHS dentist searches in <strong>England</strong> only.
      If your postcode is in Scotland, Wales or Northern Ireland, results may be incomplete
      while we work on support for those regions.
    </p>
  `;

  const html = `<!DOCTYPE html>
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
                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse; font-size:13px;">
                    <thead>
                      <tr style="background:#f5f8ff; text-align:left;">
                        <th align="left" style="padding:10px;">Practice</th>
                        <th align="left" style="padding:10px;">Patient type</th>
                        <th align="left" style="padding:10px;">Distance</th>
                        <th align="left" style="padding:10px;">Phone</th>
                        <th align="left" style="padding:10px;">NHS page</th>
                        <th align="left" style="padding:10px;">Map</th>
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

                <p style="margin:8px 0 8px 0; font-size:12px; color:#6b7280; line-height:1.6;">
                  This email is based on publicly available information from the NHS website at the time of scanning.
                  DentistRadar does not guarantee availability and cannot book appointments on your behalf.
                </p>

                <!-- Share block -->
                <p style="margin:18px 0 4px 0; font-size:13px; color:#4b5563; line-height:1.6;">
                  If this alert helps you, please consider sharing DentistRadar with others who are struggling to find an NHS dentist.
                </p>
                <p style="margin:4px 0 0 0; font-size:12px; color:#2563eb; line-height:1.6;">
                  <a href="https://wa.me/?text=I%20found%20an%20NHS%20dentist%20using%20DentistRadar%20%E2%80%93%20it%20emails%20you%20when%20local%20NHS%20practices%20start%20accepting%20patients.%20Try%20it:%20https://www.dentistradar.co.uk" style="color:#2563eb; text-decoration:none;">Share on WhatsApp</a>
                  &nbsp;·&nbsp;
                  <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.dentistradar.co.uk" style="color:#2563eb; text-decoration:none;">Share on Facebook</a>
                </p>

                ${manageBlock}
                ${englandNote}
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

  return { subject, html };
}

/* ---------------------------
   Rate limiting for /api/watch & /api/watch/create
--------------------------- */
const RATE_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_MAX_REQUESTS = 8; // max requests per IP per window

// Map<ip, { count, windowStart }>
const rateBuckets = new Map();

function rateLimitWatchCreate(req, res, next) {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket?.remoteAddress ||
      "unknown";

    const now = Date.now();
    let bucket = rateBuckets.get(ip);

    if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
      bucket = { count: 0, windowStart: now }; // new window
    }

    bucket.count += 1;
    rateBuckets.set(ip, bucket);

    if (bucket.count > RATE_MAX_REQUESTS) {
      console.warn(
        `⚠️ rateLimit: IP ${ip} exceeded limit (${bucket.count} reqs in ${RATE_WINDOW_MS}ms)`
      );
      return res.status(429).json({
        ok: false,
        error: "rate_limited",
        message: "Too many requests. Please try again shortly.",
      });
    }

    next();
  } catch (e) {
    console.error("rateLimit error:", e?.message || e);
    // fail open rather than blocking everything
    next();
  }
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
    const rawEmail = req.body?.email;
    const rawPostcode = String(req.body?.postcode || "");
    const rawRadius = req.body?.radius;

    const email = normEmail(rawEmail);
    const postcode = normalizePostcode(rawPostcode);
    const radius = Number(rawRadius);

    console.log("🔔 /api/watch(create) body:", req.body);

    // Basic validation
    if (!emailRe.test(email)) {
      return res.status(400).json({ ok: false, error: "invalid_email" });
    }

    if (!looksLikeUkPostcode(postcode)) {
      return res.status(400).json({ ok: false, error: "invalid_postcode" });
    }

    if (!radius || radius < 1 || radius > 30) {
      return res.status(400).json({ ok: false, error: "invalid_radius" });
    }

    // 🔒 Region guardrail — MUST be before Watch.create
    const region = detectUkRegion(postcode);
    if (region !== "ENGLAND") {
      console.log(
        `⛔ Blocked watch for non-England postcode ${postcode} (region=${region})`
      );
      return res.status(400).json({
        ok: false,
        error: "unsupported_region",
        region,
        message:
          "DentistRadar currently supports NHS dentist searches in England only. " +
          "Support for Scotland, Wales and Northern Ireland will be added in future.",
      });
    }

    // 1) Check for an *active* watch with same email+postcode
    const existingActive = await Watch.findOne({
      email,
      postcode,
      active: { $ne: false }, // treat missing or true as active
    }).lean();

    if (existingActive) {
      return res.status(400).json({ ok: false, error: "duplicate" });
    }

    // 2) Plan limit should only count *active* watches
    const limit = await planLimitFor(email);
    const activeCount = await Watch.countDocuments({
      email,
      active: { $ne: false },
    });
    if (activeCount >= limit) {
      return res.status(402).json({
        ok: false,
        error: "upgrade_required",
        upgradeLink: "/pricing.html",
      });
    }

    // 3) If there's an inactive (unsubscribed) watch, reactivate it; otherwise create new
    let watch = await Watch.findOne({
      email,
      postcode,
      active: false,
    });

    if (watch) {
      watch = await Watch.findByIdAndUpdate(
        watch._id,
        { active: true, unsubscribedAt: null, radius },
        { new: true }
      );
      console.log(
        `[WATCH] Reactivated existing watch ${watch._id} for ${email} – ${postcode} (${radius}mi)`
      );
    } else {
      watch = await Watch.create({ email, postcode, radius });
      console.log(
        `[WATCH] Created new watch ${watch._id} for ${email} – ${postcode} (${radius}mi)`
      );
    }

    const SITE =
      process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";

    const manageUrl = `${SITE}/my-alerts.html?email=${encodeURIComponent(
      email
    )}`;
    const unsubscribeUrl = `${SITE}/unsubscribe/${watch._id}`;

    // 4) Welcome email
    const {
      subject: welcomeSubject,
      html: welcomeHtml,
    } = renderEmail("welcome", {
      postcode,
      radius,
      manageUrl,
      unsubscribeUrl,
    });

    await sendEmailHTML(email, welcomeSubject, welcomeHtml, "welcome", {
      postcode,
      radius,
      watchId: watch._id,
    });

    // 5) Run scanner once and send acceptance email if any
    console.log(
      `[WATCH] Running immediate scan for ${email} – ${postcode} (${radius}mi)`
    );
    let scanResult;
    try {
      scanResult = await scanPostcode(postcode, radius);
    } catch (err) {
      console.error("[WATCH] scanPostcode error:", err?.message || err);
      return res.json({
        ok: true,
        message: "Alert created (scan failed, no acceptance email).",
      });
    }

    if (scanResult.acceptingCount > 0) {
      const practices = scanResult.accepting || [];

      const { subject, html } = buildAcceptanceEmail(
        postcode,
        radius,
        practices,
        { manageUrl, unsubscribeUrl }
      );

      await sendEmailHTML(email, subject, html, "alert", {
        postcode,
        radius,
        acceptingCount: practices.length,
        watchId: watch._id,
        runMode: "signup",
      });

      console.log(
        `[WATCH] Sent acceptance alert email to ${email} with ${practices.length} accepting practice(s).`
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

// OLD path for compatibility
app.post("/api/watch", rateLimitWatchCreate, handleCreateWatch);

// NEW explicit path
app.post("/api/watch/create", rateLimitWatchCreate, handleCreateWatch);

/* ---------------------------
   My Alerts APIs
--------------------------- */
app.get("/api/watch/list", async (req, res) => {
  try {
    const email = normEmail(req.query.email || "");
    if (!emailRe.test(email))
      return res.status(400).json({ ok: false, error: "invalid_email" });
    const watches = await Watch.find({ email, active: { $ne: false } })
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
    if (!emailRe.test(email)) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid_email" });
    }

    const id = req.params.id;

    // Soft delete: mark inactive instead of removing the document
    const watch = await Watch.findOne({ _id: id, email });
    if (!watch) {
      return res
        .status(404)
        .json({ ok: false, error: "not_found" });
    }

    if (watch.active === false) {
      // Already inactive; nothing to do
      return res.json({
        ok: true,
        deletedId: id,
        status: "already_inactive",
      });
    }

    watch.active = false;
    watch.unsubscribedAt = new Date();
    await watch.save();

    return res.json({
      ok: true,
      deletedId: id,
      status: "soft_deleted",
    });
  } catch (e) {
    console.error("watch soft-delete error:", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "server_error" });
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

    const normalized = normalizePostcode(String(postcode));
    const region = detectUkRegion(normalized);

    if (region !== "ENGLAND") {
      return res.status(400).json({
        error: "unsupported_region",
        region,
        message:
          "DentistRadar test scan currently only supports England-based NHS postcodes.",
      });
    }

    console.log(
      `🧪 /api/scan called for postcode="${normalized}", radius=${radiusMiles}`
    );

    const result = await scanPostcode(normalized, radiusMiles);
    res.json(result);
  } catch (err) {
    console.error("Error in /api/scan:", err);
    res.status(500).json({ error: "Scan failed", details: err.message });
  }
});

/* ---------------------------
   Grouped Scans (Phase 2) – for cron + testing
--------------------------- */

/**
 * Run grouped scans for all watches in DB.
 * - Groups by (postcode, radius)
 * - Calls scanPostcode once per group
 * - For each watch:
 *     - If dryRun: just record summary
 *     - Else: send acceptance email if:
 *         - acceptingCount > 0
 *         - no alert in last 12 hours for that email+postcode+radius
 *     - And daily alert emails do not exceed DAILY_EMAIL_LIMIT
 */
async function runAllScans({ dryRun = false } = {}) {
  const started = Date.now();
  const watches = await Watch.find({ active: true }).lean();
  const groups = new Map();

  for (const w of watches) {
    const pc = w.postcode;
    const radius = w.radius || 5;
    const key = `${pc}::${radius}`;
    if (!groups.has(key)) {
      groups.set(key, { postcode: pc, radius, watches: [] });
    }
    groups.get(key).watches.push(w);
  }

  console.log(
    `[CRON] runAllScans – ${watches.length} watches, ${groups.size} group(s). dryRun=${dryRun}`
  );

  // 🔒 Daily cap for alert emails (cron + any alerts earlier in the day)
  const DAILY_EMAIL_LIMIT = 500;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let emailsSentToday = await EmailLog.countDocuments({
    type: "alert",
    sentAt: { $gte: todayStart },
  });

  console.log(
    `[CRON] Alert emails already sent today: ${emailsSentToday}/${DAILY_EMAIL_LIMIT}`
  );

  let totalScans = 0;
  let totalEmails = 0;
  let totalSkippedRecent = 0;

  const results = [];
  let anyAcceptingAcrossAllGroups = false;

  for (const [key, group] of groups.entries()) {
    const { postcode, radius, watches: groupWatches } = group;
    totalScans++;

    console.log(
      `[CRON] Scanning group ${key} – ${groupWatches.length} watch(es)`
    );

    let scan;
    try {
      scan = await scanPostcode(postcode, radius);
    } catch (e) {
      console.error(
        `[CRON] scanPostcode error for ${key}:`,
        e?.message || e
      );
      results.push({
        key,
        postcode,
        radius,
        error: e?.message || String(e),
      });
      continue;
    }

    const practices = scan.accepting || [];
    const acceptingCount = practices.length;

    if (acceptingCount === 0) {
      console.log(
        `[CRON] No accepting practices for ${key} – skipping emails.`
      );
      results.push({
        key,
        postcode,
        radius,
        watches: groupWatches.length,
        acceptingCount,
        emailsSent: 0,
        reason: "no_accepting",
      });
      continue;
    }

    anyAcceptingAcrossAllGroups = true;

    for (const w of groupWatches) {
      const email = normEmail(w.email || "");
      if (!emailRe.test(email)) continue;

      // Check last alert in last 12 hours for this email+postcode+radius
      const lastAlert = await EmailLog.findOne({
        to: email,
        type: "alert",
        "meta.postcode": postcode,
        "meta.radius": radius,
      })
        .sort({ sentAt: -1 })
        .lean();

      const now = Date.now();
      const twelveHoursMs = 12 * 60 * 60 * 1000;
      if (
        lastAlert &&
        lastAlert.sentAt &&
        now - new Date(lastAlert.sentAt).getTime() < twelveHoursMs
      ) {
        totalSkippedRecent++;
        continue;
      }

      if (dryRun) {
        results.push({
          key,
          postcode,
          radius,
          email,
          acceptingCount,
          wouldSend: true,
        });
      } else {
        // 🔒 Daily cap check: stop sending if we've hit the limit
        if (emailsSentToday >= DAILY_EMAIL_LIMIT) {
          console.warn(
            `[CRON] Daily alert email limit reached (${emailsSentToday}/${DAILY_EMAIL_LIMIT}). Skipping further sends.`
          );
          results.push({
            key,
            postcode,
            radius,
            email,
            acceptingCount,
            skipped: true,
            reason: "daily_limit_reached",
          });
          continue;
        }

        const SITE =
          process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";

        const manageUrl = `${SITE}/my-alerts.html?email=${encodeURIComponent(
          email
        )}`;
        const unsubscribeUrl = `${SITE}/unsubscribe/${w._id}`;

        const { subject, html } = buildAcceptanceEmail(
          postcode,
          radius,
          practices,
          { manageUrl, unsubscribeUrl }
        );

        const meta = {
          postcode,
          radius,
          acceptingCount,
          watchId: w._id,
          runMode: "cron",
        };
        await sendEmailHTML(email, subject, html, "alert", meta);
        totalEmails++;
        emailsSentToday++;
        console.log(
          `[CRON] Sent acceptance alert to ${email} for ${key} with ${acceptingCount} practice(s). (emailsSentToday=${emailsSentToday})`
        );
      }
    }
  }

  const tookMs = Date.now() - started;

  if (!anyAcceptingAcrossAllGroups && watches.length > 0) {
    console.warn(
      "[ALERT] runAllScans found ZERO accepting practices across all groups. " +
        "This might indicate an NHS wording/HTML change or a parsing bug."
    );
  }

  const summary = {
    totalWatches: watches.length,
    groups: groups.size,
    totalScans,
    totalEmails,
    totalSkippedRecent,
    tookMs,
    ranAt: new Date(),
    anyAcceptingAcrossAllGroups,
    emailsSentTodayEnd: emailsSentToday,
    dailyLimit: DAILY_EMAIL_LIMIT,
    results,
  };

  lastCronRun = summary;

  return summary;
}

/**
 * Admin endpoint to trigger grouped scans.
 * Use:
 *   POST /api/admin/run-all-scans?token=ADMIN_TOKEN&dryRun=true
 */
app.post("/api/admin/run-all-scans", async (req, res) => {
  try {
    const token =
      req.query.token || (req.body && req.body.token) || "";
    const adminToken = process.env.ADMIN_TOKEN || "";

    if (!adminToken || token !== adminToken) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const dryRunParam =
      req.query.dryRun ||
      (req.body && req.body.dryRun && String(req.body.dryRun));
    const dryRun = String(dryRunParam).toLowerCase() === "true";

    const summary = await runAllScans({ dryRun });

    return res.json({ ok: true, dryRun, summary });
  } catch (e) {
    console.error("run-all-scans error:", e?.message || e);
    return res
      .status(500)
      .json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   Admin: Cron heartbeat / status
--------------------------- */
app.get("/api/admin/cron-status", (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN || "";
    const token = req.query.token || "";

    if (!adminToken || token !== adminToken) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    if (!lastCronRun) {
      return res.json({ ok: true, hasRun: false });
    }

    return res.json({
      ok: true,
      hasRun: true,
      lastRun: lastCronRun,
    });
  } catch (e) {
    console.error("cron-status error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   Admin: Basic Usage Analytics + Email Volume
--------------------------- */
app.get("/api/admin/stats", async (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN || "";
    const token = req.query.token || "";

    if (!adminToken || token !== adminToken) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // -------- Core user / watch stats --------
    const totalUsers = await User.countDocuments();
    const totalWatches = await Watch.countDocuments();

    const activeWatches = await Watch.countDocuments({
      active: { $ne: false },
    });
    const inactiveWatches = totalWatches - activeWatches;

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const signups24h = await Watch.countDocuments({
      createdAt: { $gte: last24h },
    });

    const unsub24h = await Watch.countDocuments({
      active: false,
      unsubscribedAt: { $gte: last24h },
    });

    const topPostcodes = await Watch.aggregate([
      { $match: { active: { $ne: false } } },
      { $group: { _id: "$postcode", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 15 },
    ]);

    // -------- Success / feedback metrics --------
    const foundYesTotal = await Watch.countDocuments({ foundDentist: true });
    const foundNoTotal = await Watch.countDocuments({ foundDentist: false });

    const unsubWithFeedback = await Watch.countDocuments({
      active: false,
      foundDentist: { $ne: null },
    });

    const successRate =
      unsubWithFeedback > 0
        ? (foundYesTotal / unsubWithFeedback) * 100
        : 0;

    // -------- Email volume (Postmark load) --------
    const totalEmails = await EmailLog.countDocuments();
    const emails24h = await EmailLog.countDocuments({
      sentAt: { $gte: last24h },
    });

    // Last 7 days, grouped by day and type
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const emailDailyAgg = await EmailLog.aggregate([
      { $match: { sentAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$sentAt" },
          },
          total: { $sum: 1 },
          alerts: {
            $sum: {
              $cond: [{ $eq: ["$type", "alert"] }, 1, 0],
            },
          },
          welcomes: {
            $sum: {
              $cond: [{ $eq: ["$type", "welcome"] }, 1, 0],
            },
          },
          plans: {
            $sum: {
              $cond: [{ $eq: ["$type", "plan_activated"] }, 1, 0],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const emailDaily = emailDailyAgg.map((r) => {
      const other =
        r.total - (r.alerts || 0) - (r.welcomes || 0) - (r.plans || 0);
      return {
        date: r._id,          // "2025-11-21"
        total: r.total,
        alerts: r.alerts || 0,
        welcomes: r.welcomes || 0,
        plans: r.plans || 0,
        other: other < 0 ? 0 : other,
      };
    });

    return res.json({
      ok: true,
      // Users / watches
      totalUsers,
      totalWatches,
      activeWatches,
      inactiveWatches,
      signups24h,
      unsub24h,
      topPostcodes,
      // Success metrics
      foundYesTotal,
      foundNoTotal,
      unsubWithFeedback,
      successRate, // percent (0–100)
      // Email metrics
      totalEmails,
      emails24h,
      emailDaily,
    });
  } catch (err) {
    console.error("admin/stats error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});




/* ---------------------------
   Admin: Scanner Self-Check
   - Quick way to see if scanner & NHS pattern still behave
--------------------------- */

app.get("/api/admin/self-check", async (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN || "";
    const token = req.query.token || "";

    if (!adminToken || token !== adminToken) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    // You can tweak these test postcodes later or move to env vars.
    const TESTS = [
      {
        postcode: process.env.SELFCHECK_PC1 || "RG41 4UW",
        radius: Number(process.env.SELFCHECK_RADIUS1 || 25),
      },
      {
        postcode: process.env.SELFCHECK_PC2 || "BS24 7EH",
        radius: Number(process.env.SELFCHECK_RADIUS2 || 25),
      },
    ];

    const results = [];
    let allOk = true;

    for (const t of TESTS) {
      try {
        const r = await scanPostcode(t.postcode, t.radius);
        results.push({
          postcode: r.postcode,
          radius: r.radiusMiles,
          scanned: r.scanned,
          acceptingCount: r.acceptingCount,
          notAcceptingCount: r.notAcceptingCount,
          unknownCount: r.unknownCount,
          tookMs: r.tookMs,
        });

        // Very simple "health" heuristic:
        // - call succeeded
        // - and we got *some* results (scanned > 0)
        if (r.scanned === 0) {
          allOk = false;
        }
      } catch (err) {
        allOk = false;
        results.push({
          postcode: t.postcode,
          radius: t.radius,
          error: err?.message || String(err),
        });
      }
    }

    return res.json({
      ok: allOk,
      tests: results,
    });
  } catch (err) {
    console.error("admin/self-check error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ---------------------------
   Stripe Checkout + Webhook
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
    res.status(500).send(`Webhook Error: ${err?.message}`);
  }
});

/* ---------------------------
   Unsubscribe Routes
--------------------------- */
function renderUnsubscribePage(success, infoText, watchId, thankYou) {
  const title = success ? "You have been unsubscribed" : "Unsubscribe";
  const body = infoText;

  const shareBlock = success
    ? `
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0 10px;">
      <p style="font-size:13px;color:#4b5563;line-height:1.6;">
        If DentistRadar helped you find an NHS dentist, you can help others by sharing it in your local groups.
      </p>
      <p style="font-size:12px;line-height:1.6;">
        <a href="https://wa.me/?text=I%20found%20an%20NHS%20dentist%20using%20DentistRadar%20%E2%80%93%20it%20emails%20you%20when%20local%20NHS%20practices%20start%20accepting%20patients.%20Try%20it:%20https://www.dentistradar.co.uk"
           style="color:#2563eb;text-decoration:none;">Share on WhatsApp</a>
        &nbsp;·&nbsp;
        <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.dentistradar.co.uk"
           style="color:#2563eb;text-decoration:none;">Share on Facebook</a>
      </p>
    `
    : "";

  const feedbackBlock =
    success && watchId
      ? `
        <hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0 10px;">
        <p style="font-size:13px;color:#4b5563;line-height:1.6;">
          Quick question (optional): Did DentistRadar help you find an NHS dentist?
        </p>
        <p style="font-size:12px;line-height:1.6;">
          <a href="/unsubscribe?alertId=${watchId}&found=yes"
             style="color:#2563eb;text-decoration:none;">Yes, I found a dentist</a>
          &nbsp;·&nbsp;
          <a href="/unsubscribe?alertId=${watchId}&found=no"
             style="color:#2563eb;text-decoration:none;">Not yet</a>
        </p>
        ${
          thankYou
            ? `<p style="font-size:11px;color:#6b7280;line-height:1.5;margin-top:6px;">
                 Thanks, this helps us understand how useful DentistRadar is.
               </p>`
            : ""
        }
      `
      : "";

  return `
    <html>
      <body style="font-family:system-ui;background:#fafafa;padding:40px;">
        <div style="max-width:480px;margin:auto;background:#fff;border-radius:10px;padding:25px;border:1px solid #eee;">
          <h1>${title}</h1>
          <p>${body}</p>
          ${shareBlock}
          ${feedbackBlock}
          <a href="/" style="padding:10px 18px;background:#0b63ff;color:#fff;border-radius:8px;text-decoration:none;">Back</a>
        </div>
      </body>
    </html>
  `;
}

app.get("/unsubscribe", async (req, res) => {
  try {
    const id = req.query.alertId || req.query.alert || req.query.id;
    const found = (req.query.found || "").toLowerCase();

    if (!id) {
      return res
        .status(400)
        .send(
          renderUnsubscribePage(false, "Invalid unsubscribe link.", "", false)
        );
    }

    const watch = await Watch.findById(id);
    if (!watch) {
      return res
        .status(404)
        .send(
          renderUnsubscribePage(false, "Alert not found.", "", false)
        );
    }

    const update = {};
    const alreadyUnsubscribed = watch.active === false;

    // Soft delete if not already unsubscribed
    if (!alreadyUnsubscribed) {
      update.active = false;
      update.unsubscribedAt = new Date();
    }

    // Record feedback if provided
    if (found === "yes") {
      update.foundDentist = true;
    } else if (found === "no") {
      update.foundDentist = false;
    }

    let updated = watch;
    if (Object.keys(update).length > 0) {
      updated = await Watch.findByIdAndUpdate(
        id,
        { $set: update },
        { new: true }
      );
    }

    const pc = updated.postcode || "";
    const infoText = `You will no longer receive alerts for <strong>${pc}</strong>.`;
    const thankYou = found === "yes" || found === "no";

    return res.send(
      renderUnsubscribePage(true, infoText, id, thankYou)
    );
  } catch (e) {
    console.error("unsubscribe error:", e);
    return res
      .status(500)
      .send(
        renderUnsubscribePage(false, "Something went wrong.", "", false)
      );
  }
});

app.get("/unsubscribe/:id", (req, res) => {
  const id = req.params.id;
  if (!id) {
    return res
      .status(400)
      .send(
        renderUnsubscribePage(false, "Invalid unsubscribe link.", "", false)
      );
  }
  const url = `/unsubscribe?alertId=${encodeURIComponent(id)}`;
  return res.redirect(url);
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
