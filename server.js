// server.js — Dentist Radar (stable, production-ready)

import express from "express";
import cors from "cors";
import RateLimit from "express-rate-limit";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

/* ---------------- Path & Express setup ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves /public/*

/* ---------------- Database (SQLite) ---------------- */
const db = new Database(path.join(process.cwd(), "data.sqlite"));
db.pragma("journal_mode = WAL");

// Alerts table
db.prepare(`
  CREATE TABLE IF NOT EXISTS watches (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    email    TEXT NOT NULL,
    postcode TEXT NOT NULL,        -- stored uppercase, compact (no spaces)
    radius   INTEGER NOT NULL DEFAULT 10,
    created  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

// Unique combination to prevent duplicates
db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_email_postcode
  ON watches(email, postcode)
`).run();

// Minimal analytics (optional)
db.prepare(`
  CREATE TABLE IF NOT EXISTS analytics_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL,          -- 'view' | 'alert_created'
    created TEXT NOT NULL DEFAULT (datetime('now'))
  )
`).run();

const recordEvent = (type) => {
  try { db.prepare(`INSERT INTO analytics_events (type) VALUES (?)`).run(String(type)); }
  catch { /* ignore */ }
};

/* ---------------- Helpers: validation ---------------- */
const emailRe  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fullUK   = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/; // e.g., RG41 3XX, W1A 1HQ
const outward  = /^[A-Z]{1,2}\d[A-Z\d]?$/;              // e.g., RG41, W1A, EC1
const compact  = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");

const isValidPostcodeToken = (tok) => {
  const t = compact(tok);
  return fullUK.test(t) || outward.test(t);
};

/* ---------------- Config / policy ---------------- */
const MAX_FREE_POSTCODES = 2; // Free plan: max 2 areas per email
const scanLimiter = RateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ---------------- Routes ---------------- */

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Create alert (validated, dedup, free-plan limit)
app.post("/api/watch", (req, res) => {
  try {
    const { email, postcode, radius } = req.body || {};

    // Email
    if (!email || !emailRe.test(String(email))) {
      return res.status(400).json({ ok: false, error: "Invalid email" });
    }

    // Radius 1–30 integer
    const r = Number(radius);
    if (!Number.isInteger(r) || r < 1 || r > 30) {
      return res.status(400).json({ ok: false, error: "Radius must be 1–30" });
    }

    // Postcodes (comma-separated)
    const tokens = String(postcode || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return res.status(400).json({ ok: false, error: "Postcode required" });
    }

    // Validate each token
    for (const t of tokens) {
      if (!isValidPostcodeToken(t)) {
        return res.status(400).json({ ok: false, error: `Invalid postcode: ${t}` });
      }
    }

    // Free plan limit check (count distinct existing)
    const have = db
      .prepare(`SELECT COUNT(DISTINCT postcode) AS c FROM watches WHERE email=?`)
      .get(String(email).trim()).c | 0;

    const remaining = Math.max(0, MAX_FREE_POSTCODES - have);
    if (tokens.length > remaining) {
      return res.status(400).json({
        ok: false,
        error: `Free plan allows up to ${MAX_FREE_POSTCODES} postcodes per email. You already have ${have}.`,
        code: "free_limit",
        limit: MAX_FREE_POSTCODES,
        have,
        remaining,
      });
    }

    // Insert each token; skip duplicates via unique index
    const stmt = db.prepare("INSERT INTO watches (email, postcode, radius) VALUES (?,?,?)");
    let created = 0;
    let duplicates = 0;

    for (const t of tokens) {
      const pc = compact(t);
      try {
        stmt.run(String(email).trim(), pc, r);
        created++;
      } catch (e) {
        if (String(e?.code).includes("SQLITE_CONSTRAINT")) {
          // Unique index hit => duplicate
          duplicates++;
        } else {
          throw e;
        }
      }
    }

    if (created > 0) recordEvent("alert_created");
    return res.json({ ok: true, created, duplicates });
  } catch (e) {
    console.error("POST /api/watch error:", e);
    return res.status(500).json({ ok: false, error: "failed" });
  }
});

// List all watches (admin/simple)
app.get("/api/watches", (req, res) => {
  try {
    const items = db
      .prepare("SELECT id, email, postcode, radius, created FROM watches ORDER BY id DESC")
      .all();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: "failed" });
  }
});

// Optional: simple analytics summary
app.get("/api/analytics", (req, res) => {
  try {
    recordEvent("view");
    const pageviews =
      db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='view'").get().c | 0;
    const alerts =
      db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type='alert_created'").get().c |
      0;
    const users =
      db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c | 0;
    res.json({ ok: true, analytics: { pageviews, alerts, users } });
  } catch (e) {
    res.status(500).json({ ok: false, error: "failed" });
  }
});

// Secure scan stub (plug your real scraper later)
app.post("/api/scan", scanLimiter, (req, res) => {
  const t = process.env.SCAN_TOKEN || "";
  if (!t || (req.query.token !== t && req.headers["x-scan-token"] !== t)) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const total = db.prepare("SELECT COUNT(*) AS c FROM watches").get().c | 0;
    res.json({ ok: true, total, time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: "scan failed" });
  }
});

// Serve index.html for /
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------------- Start server ---------------- */
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Dentist Radar running on port ${PORT}`);
  console.log(`📂 Static files from: ${path.join(__dirname, "public")}`);
});
