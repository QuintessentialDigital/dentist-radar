// Dentist Radar — Production Server v1.6
// © 2025 DentistRadar.co.uk

import express from "express";
import cors from "cors";
import RateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(process.cwd(), "data.sqlite"));
db.pragma("journal_mode = WAL");

// ---------- TABLE SETUP ----------
db.prepare(`
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  postcode TEXT NOT NULL,
  radius INTEGER DEFAULT 10,
  created TEXT DEFAULT (datetime('now'))
)`).run();

db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_postcode ON watches(email, postcode)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  created TEXT DEFAULT (datetime('now'))
)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS manage_tokens (
  email TEXT NOT NULL,
  token TEXT NOT NULL,
  expires TEXT NOT NULL,
  created TEXT DEFAULT (datetime('now')),
  UNIQUE(email)
)`).run();

function recordEvent(type) {
  try {
    db.prepare(`INSERT INTO analytics_events(type) VALUES (?)`).run(type);
  } catch {}
}

// ---------- EMAIL SETUP ----------
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const BASE_URL = process.env.BASE_URL || "https://www.dentistradar.co.uk";

async function sendEmail(to, subject, body) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.log("📭 Skipping email (Postmark not configured).", { to, subject });
    return { ok: false, skipped: true };
  }

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_TOKEN
    },
    body: JSON.stringify({
      From: FROM_EMAIL,
      To: to,
      Subject: subject,
      TextBody: body
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Postmark error:", err);
    return { ok: false, error: err };
  }
  return { ok: true };
}

// ---------- VALIDATION ----------
const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const postcodeRegex = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const outwardRegex = /^[A-Z]{1,2}\d[A-Z\d]?$/i;

const normalize = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

// ---------- API ROUTES ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Create alert
app.post("/api/watch", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};
    if (!email || !emailRegex.test(email))
      return res.status(400).json({ ok: false, error: "Enter a valid email address." });

    const r = Number(radius || 10);
    if (r < 1 || r > 30)
      return res.status(400).json({ ok: false, error: "Radius must be between 1 and 30 miles." });

    const pcs = String(postcode || "").split(",").map(normalize).filter(Boolean);
    if (pcs.length === 0) return res.status(400).json({ ok: false, error: "Enter a postcode." });
    if (pcs.length > 1)
      return res.status(400).json({ ok: false, error: "Free plan allows 1 postcode only." });

    for (const pc of pcs) {
      if (!postcodeRegex.test(pc) && !outwardRegex.test(pc))
        return res.status(400).json({ ok: false, error: `Invalid postcode: ${pc}` });
    }

    const stmt = db.prepare("INSERT INTO watches(email, postcode, radius) VALUES (?,?,?)");
    let created = 0,
      duplicates = 0;
    for (const pc of pcs) {
      try {
        stmt.run(email, pc, r);
        created++;
      } catch (e) {
        if (String(e.message).includes("UNIQUE")) duplicates++;
        else throw e;
      }
    }

    if (created > 0) {
      recordEvent("alert_created");

      const list = pcs.join(", ");
      const subject = `Dentist Radar: alert set for ${list}`;
      const text = [
        `Your NHS dentist alert has been created.`,
        ``,
        `We'll email you when a nearby practice starts accepting NHS patients:`,
        `• Email: ${email}`,
        `• Postcode: ${list}`,
        `• Radius: ${r} miles`,
        ``,
        `Please double-check directly with the practice before visiting.`,
        ``,
        `— Dentist Radar`
      ].join("\n");

      await sendEmail(email, subject, text);
    }

    res.json({
      ok: true,
      created,
      duplicates,
      message: created
        ? "✅ Alert created! We'll email you when availability changes."
        : "This alert already exists."
    });
  } catch (e) {
    console.error("POST /api/watch", e);
    res.status(500).json({ ok: false, error: "Server error creating alert." });
  }
});

// Admin
app.get("/api/watches", (req, res) => {
  try {
    const rows = db
      .prepare("SELECT id,email,postcode,radius,created FROM watches ORDER BY id DESC LIMIT 100")
      .all();
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load alerts." });
  }
});

// Analytics
app.get("/api/analytics", (req, res) => {
  try {
    recordEvent("view");
    const pageviews = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'").get()
      .c;
    const alerts = db
      .prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'")
      .get().c;
    const users = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c;
    res.json({ ok: true, analytics: { pageviews, alerts, users } });
  } catch {
    res.status(500).json({ ok: false, error: "Failed to load analytics." });
  }
});

// Manage — Request magic link
app.post("/api/manage/request", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !emailRegex.test(email))
      return res.status(400).json({ ok: false, error: "Enter a valid email." });

    const token = crypto.randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 mins
    db.prepare(
      "INSERT INTO manage_tokens(email, token, expires) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET token=excluded.token, expires=excluded.expires"
    ).run(email, token, expires);

    const link = `${BASE_URL}/manage.html#token=${token}&email=${encodeURIComponent(email)}`;
    const subject = "Dentist Radar: manage your alerts";
    const text = [
      `Use the link below to manage or delete your alerts (valid 30 minutes):`,
      link,
      "",
      `If you didn’t request this, ignore this email.`,
      "",
      "— Dentist Radar"
    ].join("\n");

    await sendEmail(email, subject, text);
    res.json({ ok: true, message: "Magic link sent to your email." });
  } catch (e) {
    console.error("POST /api/manage/request", e);
    res.status(500).json({ ok: false, error: "Failed to send link." });
  }
});

// Manage — List
app.get("/api/manage/list", (req, res) => {
  try {
    const { token, email } = req.query;
    const row = db.prepare("SELECT * FROM manage_tokens WHERE email=?").get(email);
    if (!row || row.token !== token)
      return res.status(403).json({ ok: false, error: "Invalid or expired token." });

    const now = new Date();
    if (new Date(row.expires) < now)
      return res.status(403).json({ ok: false, error: "Token expired." });

    const list = db.prepare("SELECT * FROM watches WHERE email=? ORDER BY id DESC").all(email);
    res.json({ ok: true, items: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to load alerts." });
  }
});

// Manage — Delete
app.post("/api/manage/delete", (req, res) => {
  try {
    const { id, email, token } = req.body || {};
    const row = db.prepare("SELECT * FROM manage_tokens WHERE email=?").get(email);
    if (!row || row.token !== token)
      return res.status(403).json({ ok: false, error: "Invalid or expired token." });

    db.prepare("DELETE FROM watches WHERE id=? AND email=?").run(id, email);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to delete alert." });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on port ${PORT}`));
