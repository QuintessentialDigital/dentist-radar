import express from "express";
import RateLimit from "express-rate-limit";
import cors from "cors";
import basicAuth from "express-basic-auth";
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

const db = new Database("data.sqlite");
db.prepare(`CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  postcode TEXT,
  radius INTEGER,
  created TEXT
)`).run();

const analytics = { pageviews: 0, alerts: 0, users: 0 };

const scanLimiter = RateLimit({
  windowMs: 60000,
  max: 10,
  message: "Too many requests from this IP, slow down."
});

// ---------- Routes ----------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.post("/api/watch/create", (req, res) => {
  const { email, postcode, radius } = req.body;
  if (!email || !postcode) return res.status(400).json({ ok: false });
  db.prepare(
    "INSERT INTO watches (email, postcode, radius, created) VALUES (?, ?, ?, datetime('now'))"
  ).run(email, postcode, radius || 10);
  analytics.alerts++;
  analytics.users = db.prepare("SELECT COUNT(DISTINCT email) AS c FROM watches").get().c;
  res.json({ ok: true, message: "Alert created" });
});

app.get("/api/watches", (req, res) => {
  const data = db.prepare("SELECT * FROM watches ORDER BY created DESC").all();
  res.json({ ok: true, items: data });
});

app.post("/api/scan", scanLimiter, async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (!token || (req.query.token !== token && req.headers["x-scan-token"] !== token))
    return res.status(403).json({ ok: false, error: "forbidden" });
  try {
    const rows = db.prepare("SELECT * FROM watches").all();
    res.json({ ok: true, total: rows.length, time: new Date().toISOString() });
  } catch {
    res.status(500).json({ ok: false, error: "scan failed" });
  }
});

// ---------- Analytics ----------
app.get("/api/analytics", (req, res) => {
  analytics.pageviews++;
  res.json({ ok: true, analytics });
});

// ---------- Admin ----------
app.use(
  "/admin",
  basicAuth({
    users: { admin: process.env.ADMIN_PASSWORD || "admin" },
    challenge: true
  })
);
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public/admin.html"));
});

// ---------- Frontend ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on port ${PORT}`));
