// server.js — Dentist Radar (Stable v1.8+)
// Keeps validation, Mongo, Postmark, Stripe intact. No UI changes.

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import Stripe from "stripe";
import { runScan } from "./scanner.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// --- Config ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "dentistradar";
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const POSTMARK_KEY = process.env.POSTMARK_KEY || "";
const DOMAIN = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM = process.env.MAIL_FROM || `no-reply@${DOMAIN}`;
const SCAN_TOKEN = process.env.SCAN_TOKEN || "";

// --- Validate ---
if (!MONGO_URI) throw new Error("Missing MONGO_URI in environment");

// --- Mongo ---
mongoose
  .connect(MONGO_URI, { dbName: DB_NAME, useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log(`✅ MongoDB connected → db="${DB_NAME}"`))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// --- Models ---
const WatchSchema = new mongoose.Schema({
  email: String,
  postcode: [String],
  radius: Number,
  plan: { type: String, default: "free" },
  createdAt: { type: Date, default: Date.now },
});

const AlertSchema = new mongoose.Schema({
  email: String,
  message: String,
  createdAt: { type: Date, default: Date.now },
});

const Watch = mongoose.model("Watch", WatchSchema);
const Alert = mongoose.model("Alert", AlertSchema);

// --- Email (Postmark) ---
async function sendEmail(to, subject, body) {
  if (!POSTMARK_KEY) { console.warn("📭 Postmark disabled —", subject); return; }
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": POSTMARK_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ From: MAIL_FROM, To: to, Subject: subject, TextBody: body }),
    });
    const text = await res.text();
    if (!res.ok) console.error("❌ Postmark API error:", res.status, text);
    else console.log("📧 Email queued OK:", subject);
  } catch (err) {
    console.error("❌ Email send exception:", err.message);
  }
}

// --- Health ---
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Create alert (keeps your validation + upgrade guard) ---
app.post("/api/watch/create", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body;
    if (!email || !postcode) {
      return res.status(400).json({ ok: false, error: "Please provide a valid email and postcode." });
    }

    const pcList = String(postcode).split(/[,;]+/).map(x => x.trim()).filter(Boolean);

    // Load user's existing watches
    const userWatches = await Watch.find({ email }).lean();
    const existingPCs = new Set(userWatches.flatMap(w => w.postcode || []));
    const newPCs = pcList.filter(pc => !existingPCs.has(pc));
    const plan = userWatches[0]?.plan || "free";

    // Free plan: total postcodes must not exceed 1
    if (plan === "free" && (existingPCs.size + newPCs.length) > 1) {
      return res.json({
        ok: false,
        error: "Free plan supports one postcode. Please upgrade to Pro or Family.",
        upgrade: true,
      });
    }

    // Duplicate guard
    const dup = await Watch.findOne({ email, postcode: { $in: pcList } });
    if (dup) return res.json({ ok: false, error: "Alert already exists for this postcode." });

    // Save watch
    const watch = new Watch({ email, postcode: pcList, radius: Number(radius) || 5, plan });
    await watch.save();

    // Welcome email
    await sendEmail(
      email,
      "Dentist Radar Alert Created",
      `We’ll notify you when NHS dentists near ${pcList.join(", ")} start accepting new patients.`
    );

    res.json({ ok: true, message: "Alert created successfully! You’ll receive an email soon." });
  } catch (err) {
    console.error("❌ Error creating alert:", err.message);
    res.status(500).json({ ok: false, error: "Server error creating alert" });
  }
});

// --- Admin Manual Scan (unchanged) ---
app.post("/api/scan", async (req, res) => {
  if (!SCAN_TOKEN || req.query.token !== SCAN_TOKEN) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  try {
    const result = await runScan();
    res.json({ ok: true, result, time: new Date().toISOString() });
  } catch (err) {
    console.error("❌ Scan failed:", err.message);
    res.status(500).json({ ok: false, error: "Scan failed" });
  }
});

// --- Stripe Checkout (unchanged) ---
app.post("/api/checkout", async (req, res) => {
  if (!stripe) return res.status(400).json({ ok: false, error: "Stripe not configured" });
  try {
    const { email, plan } = req.body;
    const priceId = plan === "family" ? process.env.STRIPE_PRICE_FAMILY : process.env.STRIPE_PRICE_PRO;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://${DOMAIN}/success.html`,
      cancel_url: `https://${DOMAIN}/cancel.html`,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err.message);
    res.status(500).json({ ok: false, error: "Stripe checkout failed" });
  }
});

// --- Fallback to SPA entry ---
app.get("*", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

app.listen(PORT, () => console.log(`🚀 Dentist Radar running on port ${PORT}`));
