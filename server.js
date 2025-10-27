// Dentist Radar — Production Server v1.7 (floating-label UI + duplicate note + free-limit prompt)
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

/* ---------- TABLES ---------- */
db.prepare(`
  CREATE TABLE IF NOT EXISTS watches (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    email    TEXT NOT NULL,
    postcode TEXT NOT NULL,
    radius   INTEGER NOT NULL DEFAULT 10,
    created  TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();

db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_pc ON watches(email, postcode)`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL,   -- 'view' | 'alert_created'
    created TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS manage_tokens (
    email   TEXT NOT NULL,
    token   TEXT NOT NULL,
    expires TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(email)
)`).run();

function recordEvent(type) {
  try { db.prepare("INSERT INTO analytics_events(type) VALUES (?)").run(String(type)); } catch {}
}

/* ---------- EMAIL (Postmark) ---------- */
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL     = process.env.FROM_EMAIL || ""; // e.g. alerts@dentistradar.co.uk
const BASE_URL       = process.env.BASE_URL || "https://www.dentistradar.co.uk";

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.log("📭 Skipping email (configure POSTMARK_TOKEN & FROM_EMAIL).", { to, subject });
    return { ok:false, skipped:true };
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept":"application/json",
      "Content-Type":"application/json",
      "X-Postmark-Server-Token": POSTMARK_TOKEN
    },
    body: JSON.stringify({ From: FROM_EMAIL, To: to, Subject: subject, TextBody: text })
  });
  if (!res.ok) {
    const err = await res.text().catch(()=> "");
    console.error("Postmark error:", err);
    return { ok:false, error:err };
  }
  return { ok:true };
}

/* ---------- VALIDATION ---------- */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fullUK  = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i; // RG41 3XX, W1A 1HQ
const outward = /^[A-Z]{1,2}\d[A-Z\d]?$/i;              // RG41, W1A, EC1
const normalize = s => String(s||"").trim().toUpperCase().replace(/\s+/g, "");

/* ---------- POLICY ---------- */
const MAX_FREE_POSTCODES = 1;

/* ---------- ROUTES ---------- */
app.get("/health", (req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// Create alert (returns {created, duplicates} and clear messages)
app.post("/api/watch", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};

    if (!email || !emailRe.test(String(email)))
      return res.status(400).json({ ok:false, error:"Please enter a valid email." });

    const r = Number(radius);
    if (!Number.isInteger(r) || r < 1 || r > 30)
      return res.status(400).json({ ok:false, error:"Radius must be a whole number between 1 and 30." });

    const tokens = String(postcode||"").split(",").map(s=>s.trim()).filter(Boolean);
    if (tokens.length === 0)
      return res.status(400).json({ ok:false, error:"Enter a postcode." });

    if (tokens.length > MAX_FREE_POSTCODES)
      return res.status(400).json({ ok:false, error:"Free plan supports 1 postcode.", code:"free_limit" });

    for (const t of tokens) {
      const pc = normalize(t);
      if (!fullUK.test(pc) && !outward.test(pc))
        return res.status(400).json({ ok:false, error:`Invalid postcode: ${t}` });
    }

    const stmt = db.prepare("INSERT INTO watches(email, postcode, radius) VALUES (?,?,?)");
    let created = 0, dup = 0;
    for (const t of tokens) {
      const pc = normalize(t);
      try { stmt.run(String(email).trim(), pc, r); created++; }
      catch(e){ if (String(e.message).includes("UNIQUE")) dup++; else throw e; }
    }

    if (created > 0) {
      recordEvent("alert_created");
      const list = tokens.map(normalize).join(", ");
      const subject = `Dentist Radar: alert set for ${list}`;
      const body = [
        `Your alert is active.`,
        ``,
        `We'll email you when a nearby practice appears to accept new NHS patients:`,
        `• Email: ${String(email).trim()}`,
        `• Postcode: ${list}`,
        `• Radius: ${r} miles`,
        ``,
        `Please double-check directly with the practice before you travel.`,
        ``,
        `— Dentist Radar`
      ].join("\n");
      await sendEmail(String(email).trim(), subject, body);
    }

    return res.json({
      ok: true,
      created,
      duplicates: dup,
      message: created
        ? "✅ Alert created! We'll email you when availability changes."
        : "This alert already exists."
    });
  } catch (e) {
    console.error("POST /api/watch", e);
    return res.status(500).json({ ok:false, error:"Server error creating alert." });
  }
});

// Admin list
app.get("/api/watches", (req,res)=>{
  try{
    const items = db.prepare(
      "SELECT id,email,postcode,radius,created FROM watches ORDER BY id DESC LIMIT 200"
    ).all();
    res.json({ ok:true, items });
  }catch{
    res.status(500).json({ ok:false, error:"Failed to load alerts." });
  }
});

// Simple analytics
app.get("/api/analytics", (req,res)=>{
  try{
    recordEvent("view");
    const views  = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'").get().c|0;
    const alerts = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'").get().c|0;
    const users  = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c|0;
    res.json({ ok:true, analytics:{ views, alerts, users }});
  }catch{
    res.status(500).json({ ok:false, error:"Failed." });
  }
});

/* Optional secured scan endpoint (stub) */
const scanLimiter = RateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post("/api/scan", scanLimiter, (req,res)=>{
  const t = process.env.SCAN_TOKEN || "";
  if (!t || (req.query.token !== t && req.headers["x-scan-token"] !== t)) {
    return res.status(403).json({ ok:false, error:"forbidden" });
  }
  try{
    const total = db.prepare("SELECT COUNT(*) AS c FROM watches").get().c|0;
    res.json({ ok:true, total, time:new Date().toISOString() });
  }catch{
    res.status(500).json({ ok:false, error:"scan failed" });
  }
});

// Serve index
app.get("/", (req,res)=> res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on ${PORT}`));
