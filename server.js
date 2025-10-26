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

const db = new Database("data.sqlite");
db.prepare(`CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  postcode TEXT,
  radius INTEGER,
  created TEXT DEFAULT (datetime('now'))
)`).run();

const scanLimiter = RateLimit({
  windowMs: 60000,
  max: 10,
  message: "Too many requests from this IP."
});

// Create alert
app.post("/api/watch", (req, res) => {
  const { email, postcode, radius } = req.body;
  if (!email || !postcode) return res.status(400).json({ ok: false, error: "Missing fields" });
  db.prepare("INSERT INTO watches (email, postcode, radius) VALUES (?, ?, ?)").run(email, postcode, radius || 10);
  res.json({ ok: true, message: "Alert created" });
});

// List alerts
app.get("/api/watches", (req, res) => {
  const items = db.prepare("SELECT * FROM watches ORDER BY created DESC").all();
  res.json({ ok: true, items });
});

// Health check
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Scan endpoint placeholder
app.post("/api/scan", scanLimiter, async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (!token || (req.query.token !== token && req.headers["x-scan-token"] !== token))
    return res.status(403).json({ ok: false, error: "forbidden" });
  const count = db.prepare("SELECT COUNT(*) AS c FROM watches").get().c;
  res.json({ ok: true, total: count, time: new Date().toISOString() });
});

// Serve frontend
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`✅ Dentist Radar running on port ${PORT}`));
