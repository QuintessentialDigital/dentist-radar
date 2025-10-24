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

/* ---------- Resolve paths safely ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePublic = [
  path.join(__dirname, "public"),
  path.join(__dirname, "..", "public"),
  path.join(process.cwd(), "public")
];
let PUBLIC_DIR = candidatePublic.find(p => fs.existsSync(p)) || path.join(__dirname, "..", "public");
console.log("📂 Serving static from:", PUBLIC_DIR);

/* ---------- Express setup ---------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ---------- Database ---------- */
const db = new Database(path.join(process.cwd(), "data.sqlite"));
db.pragma("journal_mode = WAL");
db.prepare(`
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  postcode TEXT,
  radius INTEGER,
  created TEXT DEFAULT (datetime('now'))
)
`).run();

db.prepare(`
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  created TEXT DEFAULT (datetime('now'))
)
`).run();

function recordEvent(type) {
  try { db.prepare("INSERT INTO analytics_events (type) VALUES (?)").run(type); } catch {}
}
function counts() {
  const get = t => db.prepare("SELECT COUNT(*) AS c FROM analytics_events WHERE type=?").get(t).c|0;
  const users = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c|0;
  return { pageviews: get("view"), alerts: get("alert_created"), users };
}

/* ---------- Rate limiter ---------- */
const scanLimiter = RateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

/* ---------- Endpoints ---------- */
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

async function handleCreateWatch(req, res) {
  try {
    const { email, postcode, radius } = req.body || {};
    console.log("[CREATE WATCH] body:", req.body);

    if (!email || !postcode) return res.status(400).json({ ok: false, error: "email and postcode required" });
    const r = Number(radius || 10);
    db.prepare("INSERT INTO watches (email, postcode, radius) VALUES (?,?,?)")
      .run(String(email).trim(), String(postcode).trim(), r);
    recordEvent("alert_created");
    return res.json({ ok: true, message: "Alert created" });
  } catch (e) {
    console.error("POST /api/watch error:", e);
    res.status(500).json({ ok: false, error: "failed" });
  }
}
app.post("/api/watch", handleCreateWatch);
app.post("/api/watch/create", handleCreateWatch);

app.get("/api/watches", (req, res) => {
  const items = db.prepare("SELECT * FROM watches ORDER BY id DESC").all();
  res.json({ ok: true, items });
});

app.get("/api/analytics", (req, res) => {
  recordEvent("view");
  res.json({ ok: true, analytics: counts() });
});

app.post("/api/scan", scanLimiter, (req, res) => {
  const t = process.env.SCAN_TOKEN || "";
  if (!t || (req.query.token !== t && req.headers["x-scan-token"] !== t))
    return res.status(403).json({ ok: false, error: "forbidden" });
  const total = db.prepare("SELECT COUNT(*) AS c FROM watches").get().c;
  res.json({ ok: true, total, time: new Date().toISOString() });
});

/* ---------- Serve frontend ---------- */
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on port ${PORT}`));
