// Dentist Radar — Production Server v1.6
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

// ---------- TABLES ----------
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

const recordEvent = (type) => {
  try { db.prepare("INSERT INTO analytics_events(type) VALUES (?)").run(type); } catch {}
};

// ---------- EMAIL ----------
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL = process.env.FROM_EMAIL || "";
const BASE_URL = process.env.BASE_URL || "https://www.dentistradar.co.uk";

async function sendEmail(to, subject, body) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.log("📭 Skipping email (Postmark not configured)", { to, subject });
    return;
  }

  await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_TOKEN
    },
    body: JSON.stringify({ From: FROM_EMAIL, To: to, Subject: subject, TextBody: body })
  });
}

// ---------- VALIDATION ----------
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fullUK = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const outward = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const normalize = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");

// ---------- ROUTES ----------
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/watch", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};
    if (!email || !emailRe.test(email))
      return res.status(400).json({ ok: false, error: "Enter a valid email." });

    const r = Number(radius || 10);
    if (r < 1 || r > 30)
      return res.status(400).json({ ok: false, error: "Radius must be 1–30 miles." });

    const pcs = String(postcode || "").split(",").map(normalize).filter(Boolean);
    if (!pcs.length) return res.status(400).json({ ok: false, error: "Enter a postcode." });
    if (pcs.length > 1)
      return res.status(400).json({ ok: false, error: "Free plan allows 1 postcode only." });

    for (const pc of pcs)
      if (!fullUK.test(pc) && !outward.test(pc))
        return res.status(400).json({ ok: false, error: `Invalid postcode: ${pc}` });

    const stmt = db.prepare("INSERT INTO watches(email, postcode, radius) VALUES (?,?,?)");
    let created = 0, dup = 0;
    for (const pc of pcs) {
      try { stmt.run(email, pc, r); created++; }
      catch (e) { if (String(e.message).includes("UNIQUE")) dup++; else throw e; }
    }

    if (created) {
      recordEvent("alert_created");
      const subject = `Dentist Radar: alert set for ${pcs.join(", ")}`;
      const body = [
        `Your NHS dentist alert is active.`,
        ``,
        `We'll notify you when a nearby practice starts accepting NHS patients:`,
        `• Email: ${email}`,
        `• Postcode: ${pcs.join(", ")}`,
        `• Radius: ${r} miles`,
        ``,
        `Please confirm directly with the practice before visiting.`,
        ``,
        `— Dentist Radar`
      ].join("\n");
      await sendEmail(email, subject, body);
    }

    res.json({ ok: true, message: created ? "✅ Alert created successfully!" : "Already exists." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Server error." });
  }
});

// Admin
app.get("/api/watches", (req, res) => {
  try {
    const items = db.prepare("SELECT * FROM watches ORDER BY id DESC LIMIT 100").all();
    res.json({ ok: true, items });
  } catch {
    res.status(500).json({ ok: false, error: "Failed." });
  }
});

// Analytics
app.get("/api/analytics", (req, res) => {
  try {
    recordEvent("view");
    const views = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'").get().c;
    const alerts = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'").get().c;
    const users = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c;
    res.json({ ok: true, analytics: { views, alerts, users } });
  } catch {
    res.status(500).json({ ok: false, error: "Failed." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on ${PORT}`));
