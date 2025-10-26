// server.js — Dentist Radar (Launch Edition)
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

/* ---------- Tables ---------- */
db.prepare(`
CREATE TABLE IF NOT EXISTS watches (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  email    TEXT NOT NULL,
  postcode TEXT NOT NULL,      -- uppercase, no spaces
  radius   INTEGER NOT NULL DEFAULT 10,
  created  TEXT NOT NULL DEFAULT (datetime('now'))
)`).run();

db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_w_email_pc ON watches(email, postcode)`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  type    TEXT NOT NULL,  -- 'view' | 'alert_created'
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

const recordEvent = (type) => {
  try { db.prepare(`INSERT INTO analytics_events(type) VALUES (?)`).run(String(type)); } catch {}
};

/* ---------- Email (Postmark) ---------- */
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL     = process.env.FROM_EMAIL || "";         // e.g. alerts@dentistradar.co.uk
const BASE_URL       = process.env.BASE_URL || "";            // e.g. https://www.dentistradar.co.uk

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.log("📭 Email skipped (configure POSTMARK_TOKEN & FROM_EMAIL).", { to, subject });
    return { ok: false, skipped: true };
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_TOKEN
    },
    body: JSON.stringify({ From: FROM_EMAIL, To: to, Subject: subject, TextBody: text })
  });
  const j = await res.json().catch(()=> ({}));
  if (!res.ok) throw new Error(j?.Message || "Email send failed");
  return { ok: true };
}

/* ---------- Validation ---------- */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fullUK  = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/; // RG41 3XX
const outward = /^[A-Z]{1,2}\d[A-Z\d]?$/;             // RG41
const compact = s => String(s||"").toUpperCase().replace(/\s+/g, "");

const isValidPostcodeToken = tok => {
  const t = compact(tok);
  return fullUK.test(t) || outward.test(t);
};

/* ---------- Policy ---------- */
const MAX_FREE_POSTCODES = 1; // Free plan = 1 postcode

const scanLimiter = RateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });

/* ---------- Routes ---------- */
app.get("/health", (req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// Create alert (validates, enforces free plan, dedupe, confirmation email)
app.post("/api/watch", async (req,res)=>{
  try{
    const { email, postcode, radius } = req.body || {};
    if (!email || !emailRe.test(String(email))) {
      return res.status(400).json({ ok:false, error:"Please enter a valid email." });
    }
    const r = Number(radius);
    if (!Number.isInteger(r) || r < 1 || r > 30) {
      return res.status(400).json({ ok:false, error:"Radius must be a whole number between 1 and 30." });
    }

    const tokens = String(postcode||"").split(",").map(s=>s.trim()).filter(Boolean);
    if (!tokens.length) return res.status(400).json({ ok:false, error:"Enter a postcode." });
    if (tokens.length > MAX_FREE_POSTCODES) {
      return res.status(400).json({ ok:false, error:`Free plan supports ${MAX_FREE_POSTCODES} postcode.`, code:"free_limit" });
    }
    for (const t of tokens) {
      if (!isValidPostcodeToken(t)) {
        return res.status(400).json({ ok:false, error:`Invalid postcode: ${t}. Use full (RG41 3XX) or outward (RG41).` });
      }
    }

    const stmt = db.prepare(`INSERT INTO watches(email, postcode, radius) VALUES (?,?,?)`);
    let created=0, duplicates=0;
    for (const t of tokens) {
      const pc = compact(t);
      try { stmt.run(String(email).trim(), pc, r); created++; }
      catch(e){ if(String(e?.code).includes("SQLITE_CONSTRAINT")) duplicates++; else throw e; }
    }

    if (created>0) {
      recordEvent("alert_created");
      // Send confirmation email
      const list = tokens.map(compact).join(", ");
      const subject = `Dentist Radar: alert set for ${list}`;
      const lines = [
        `Your alert is active.`,
        ``,
        `We’ll email you when a nearby practice appears to accept new NHS patients:`,
        `• Email: ${String(email).trim()}`,
        `• Postcode: ${list}`,
        `• Radius: ${r} miles`,
        ``,
        `Tip: Please double-check with the practice before you travel.`,
        ``,
        `— Dentist Radar`
      ].join("\n");
      try { await sendEmail(String(email).trim(), subject, lines); } catch(e) { console.error("Email send failed:", e?.message||e); }
    }

    res.json({ ok:true, created, duplicates, message: created? "Alert created. We’ll email you when there’s a match." : "Nothing new was added." });
  }catch(e){
    console.error("POST /api/watch", e);
    res.status(500).json({ ok:false, error:"Sorry — something went wrong creating your alert." });
  }
});

// Admin list
app.get("/api/watches", (req,res)=>{
  try{
    const items = db.prepare(`SELECT id,email,postcode,radius,created FROM watches ORDER BY id DESC`).all();
    res.json({ ok:true, items });
  }catch(e){ res.status(500).json({ ok:false, error:"failed" }); }
});

// Analytics (simple)
app.get("/api/analytics", (req,res)=>{
  try{
    recordEvent("view");
    const pageviews = db.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'`).get().c|0;
    const alerts    = db.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'`).get().c|0;
    const users     = db.prepare(`SELECT COUNT(DISTINCT email) AS c FROM watches`).get().c|0;
    res.json({ ok:true, analytics:{ pageviews, alerts, users }});
  }catch(e){ res.status(500).json({ ok:false, error:"failed" }); }
});

// Manage — request magic-link
app.post("/api/manage/request", async (req,res)=>{
  try{
    const { email } = req.body || {};
    if (!email || !emailRe.test(String(email))) return res.status(400).json({ ok:false, error:"Enter a valid email." });

    const token  = crypto.randomBytes(24).toString("base64url");
    const expiry = new Date(Date.now()+1000*60*30).toISOString(); // 30 mins
    db.prepare(`INSERT INTO manage_tokens(email, token, expires) VALUES(?,?,?)
                ON CONFLICT(email) DO UPDATE SET token=excluded.token, expires=excluded.expires`)
      .run(String(email).trim(), token, expiry);

    const manageUrl = (BASE_URL || "") + `/manage.html#token=${token}&email=${encodeURIComponent(String(email).trim())}`;

    const subject = "Dentist Radar: manage your alerts";
    const body = [
      `Use the link below to manage your alerts (valid for 30 minutes):`,
      manageUrl,
      ``,
      `If you didn't request this, you can ignore this email.`,
      ``,
      `— Dentist Radar`
    ].join("\n");
    try { await sendEmail(String(email).trim(), subject, body); } catch(e){ console.error("Manage email failed:", e?.message||e); }

    res.json({ ok:true });
  }catch(e){
    console.error("POST /api/manage/request", e);
    res.status(500).json({ ok:false, error:"failed" });
  }
});

// Manage — list
app.get("/api/manage/list", (req,res)=>{
  try{
    const { token, email } = req.query;
    if (!token || !email) return res.status(400).json({ ok:false, error:"missing" });

    const row = db.prepare(`SELECT token, expires FROM manage_tokens WHERE email=?`).get(String(email).trim());
    if (!row || row.token !== token || new
