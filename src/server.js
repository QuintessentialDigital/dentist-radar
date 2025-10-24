// server.js — Dentist Radar (fixed static path + simple API)
import express from "express";
import RateLimit from "express-rate-limit";
import cors from "cors";
import basicAuth from "express-basic-auth";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

/* ---------- Resolve paths safely (handles both /public and /src/public) ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try common locations so we never hit /src/src/public again.
const candidatePublic = [
  path.join(__dirname, "public"),       // e.g. repo/src/public
  path.join(__dirname, "..", "public"), // e.g. repo/public
  path.join(process.cwd(), "public")    // fallback to process cwd
];
let PUBLIC_DIR = candidatePublic.find(p => fs.existsSync(p));
if (!PUBLIC_DIR) {
  // If nothing exists yet, default to ../public (Render often checks out at /opt/render/project/src)
  PUBLIC_DIR = path.join(__dirname, "..", "public");
}
console.log("📂 Serving static from:", PUBLIC_DIR);

/* ---------- App & middleware ---------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ---------- DB (simple, inline) ---------- */
const db = new Database(path.join(process.cwd(), "data.sqlite"));
db.pragma("journal_mode = WAL");
db.prepare(`
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    postcode TEXT NOT NULL,
    radius INTEGER NOT NULL DEFAULT 10,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();
db.prepare(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,      -- 'view' | 'alert_created'
    created TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

/* ---------- Simple counters (derived from analytics_events) ---------- */
function recordEvent(type) {
  try { db.prepare(`INSERT INTO analytics_events (type) VALUES (?)`).run(String(type)); }
  catch {}
}
function counts() {
  const get = (t) => db.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE type=?`).get(t).c|0;
  const users = db.prepare(`SELECT COUNT(DISTINCT email) AS c FROM watches`).get().c|0;
  return { pageviews: get("view"), alerts: get("alert_created"), users };
}

/* ---------- Rate limiter ---------- */
const scanLimiter = RateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, slow down."
});

/* ---------- Health ---------- */
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* ---------- Create watch (supports old and new paths) ---------- */
async function handleCreateWatch(req, res) {
  try {
    const { email, postcode, radius } = req.body || {};
    if (!email || !postcode) {
      return res.status(400).json({ ok: false, error: "email and postcode required" });
    }
    const r = Number(radius || 10);
    db.prepare(
      "INSERT INTO watches (email, postcode, radius) VALUES (?,?,?)"
    ).run(String(email).trim(), String(postcode).trim(), r);

    recordEvent("alert_created");
    return res.json({ ok: true, message: "Alert created" });
  } catch (e) {
    console.error("POST /api/watch error:", e);
    return res.status(500).json({ ok: false, error: "failed" });
  }
}
app.post("/api/watch", handleCreateWatch);
app.post("/api/watch/create", handleCreateWatch); // alias for older frontend code

/* ---------- List watches ---------- */
app.get("/api/watches", (req, res) => {
  try {
    const data = db.prepare("SELECT * FROM watches ORDER BY id DESC").all();
    res.json({ ok: true, items: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: "failed" });
  }
});

/* ---------- Analytics (very simple) ---------- */
app.get("/api/analytics", (req, res) => {
  try {
    recordEvent("view");
    res.json({ ok: true, analytics: counts() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "failed" });
  }
});

/* ---------- Secure scan endpoint (stub) ---------- */
app.post("/api/scan", scanLimiter, async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (!token || (req.query.token !== token && req.headers["x-scan-token"] !== token)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const rows = db.prepare("SELECT * FROM watches").all();
    // TODO: plug your real NHS parsing here and notify users if matches
    res.json({ ok: true, total: rows.length, time: new Date().toISOString() });
  } catch (e) {
    console.error("[scan failed]", e);
    res.status(500).json({ ok: false, error: "scan failed" });
  }
});

/* ---------- Admin gate (for /admin.html if you want to protect it) ---------- */
/* If you want /admin.html behind basic auth, uncomment the next block:

app.use(
  "/admin.html",
  basicAuth({
    users: { admin: process.env.ADMIN_PASSWORD || "admin" },
    challenge: true
  })
);

*/

/* ---------- Fallback routes ---------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// If you have a 404.html in /public, serve it for unknown routes.
app.use((req, res) => {
  const notFound = path.join(PUBLIC_DIR, "404.html");
  if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
  return res.status(404).json({ ok: false, error: "not found" });
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Dentist Radar running on :${PORT}`);
});
