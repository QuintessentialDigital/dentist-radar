// server.js — Dentist Radar (vNext)
import express from "express";
import cors from "cors";
import RateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
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

db.prepare(`
  CREATE TABLE IF NOT EXISTS watches (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    email    TEXT NOT NULL,
    postcode TEXT NOT NULL,      -- uppercase, no internal spaces
    radius   INTEGER NOT NULL DEFAULT 10,
    created  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_email_postcode
  ON watches(email, postcode)
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL,  -- 'view' | 'alert_created'
    created TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

const recordEvent = (type) => {
  try { db.prepare(`INSERT INTO analytics_events (type) VALUES (?)`).run(String(type)); } catch {}
};

/* ---------- Email (Postmark) ---------- */
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const FROM_EMAIL     = process.env.FROM_EMAIL || ""; // e.g., alerts@dentistradar.co.uk

async function sendEmail(to, subject, text) {
  if (!POSTMARK_TOKEN || !FROM_EMAIL) {
    console.log("📭 Email skipped (configure POSTMARK_TOKEN and FROM_EMAIL).", { to, subject });
    return { ok: false, skipped: true };
  }
  const res = await fetch("https://api.postmarkapp.com/email", {
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
      TextBody: text
    })
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
const MAX_FREE_POSTCODES = 1; // ✅ Free plan now allows ONE postcode

const scanLimiter = RateLimit({
  windowMs: 60_000, max: 10,
  standardHeaders: true, legacyHeaders: false
});

/* ---------- Routes ---------- */

app.get("/health", (req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// Create alert (validates + free-plan + dedupe + confirmation email)
app.post("/api/watch", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};

    // Email
    if (!email || !emailRe.test(String(email))) {
      return res.status(400).json({ ok:false, error:"Please enter a valid email." });
    }

    // Radius 1–30 integer
    const r = Number(radius);
    if (!Number.isInteger(r) || r < 1 || r > 30) {
      return res.status(400).json({ ok:false, error:"Radius must be a whole number between 1 and 30." });
    }

    // Postcodes (free = 1)
    const tokens = String(postcode || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return res.status(400).json({ ok:false, error:"Enter at least one postcode." });
    }
    if (tokens.length > MAX_FREE_POSTCODES) {
      return res.status(400).json({
        ok:false,
        error:`Free plan allows ${MAX_FREE_POSTCODES} postcode.`,
        code:"free_limit",
        limit: MAX_FREE_POSTCODES
      });
    }
    for (const t of tokens) {
      if (!isValidPostcodeToken(t)) {
        return res.status(400).json({ ok:false, error:`Invalid postcode: ${t}. Use full (RG41 3XX) or outward (RG41).` });
      }
    }

    const stmt = db.prepare("INSERT INTO watches (email, postcode, radius) VALUES (?,?,?)");
    let created = 0, duplicates = 0;
    for (const t of tokens) {
      const pc = compact(t);
      try {
        stmt.run(String(email).trim(), pc, r);
        created++;
      } catch (e) {
        if (String(e?.code).includes("SQLITE_CONSTRAINT")) duplicates++;
        else throw e;
      }
    }

    if (created > 0) {
      recordEvent("alert_created");
      // Send confirmation email
      const list = tokens.map(t => compact(t)).join(", ");
      const subject = `Dentist Radar: alert set for ${list}`;
      const body = [
        `Thanks — your alert is active.`,
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
      try { await sendEmail(String(email).trim(), subject, body); }
      catch (e) { console.error("Email send failed:", e?.message || e); }
    }

    return res.json({
      ok:true,
      created,
      duplicates,
      message: created ? "Alert created. We’ll email you when there is a match." : "Nothing new was added."
    });

  } catch (e) {
    console.error("POST /api/watch error:", e);
    return res.status(500).json({ ok:false, error:"Sorry — something went wrong creating your alert." });
  }
});

// List watches (admin)
app.get("/api/watches", (req,res)=>{
  try{
    const items = db.prepare("SELECT id,email,postcode,radius,created FROM watches ORDER BY id DESC").all();
    res.json({ ok:true, items });
  }catch(e){
    res.status(500).json({ ok:false, error:"failed" });
  }
});

// Analytics
app.get("/api/analytics", (req,res)=>{
  try{
    recordEvent("view");
    const pageviews = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'").get().c|0;
    const alerts    = db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'").get().c|0;
    const users     = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c|0;
    res.json({ ok:true, analytics:{ pageviews, alerts, users }});
  }catch(e){
    res.status(500).json({ ok:false, error:"failed" });
  }
});

// Secured scan stub
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

const PORT = process.env.PORT || 8787;
app.listen(PORT, ()=> {
  console.log(`✅ Dentist Radar running on port ${PORT}`);
});
