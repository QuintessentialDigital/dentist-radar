// server.js — Dentist Radar (Stable v1.8+)
// ✅ Works with MongoDB, Postmark, Stripe, and scanner.js
// ✅ Keeps UI & logic unchanged
// ✅ Adds correct DB name + better email logs

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

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB_NAME || "dentistradar";
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || "";
const POSTMARK_KEY = process.env.POSTMARK_KEY || "";
const DOMAIN = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM = process.env.MAIL_FROM || `no-reply@${DOMAIN}`;

// --- Validation ---
if (!MONGO_URI) throw new Error("Missing MONGO_URI in environment");

// --- MongoDB Connection ---
mongoose
  .connect(MONGO_URI, {
    dbName: DB_NAME,
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log(`✅ MongoDB connected → db="${DB_NAME}"`))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const db = mongoose.connection;
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// --- Mongoose Models ---
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

// --- Email helper (Postmark) ---
async function sendEmail(to, subject, body) {
  if (!POSTMARK_KEY) {
    console.warn("📭 Postmark disabled —", subject);
    return;
  }
  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": POSTMARK_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        From: MAIL_FROM,
        To: to,
        Subject: subject,
        TextBody: body,
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error("❌ Postmark API error:", res.status, text);
    } else {
      console.log(`📧 Email queued OK (${subject})`);
    }
  } catch (err) {
    console.error("❌ Email send exception:", err.message);
  }
}

// --- Health ---
app.get("/api/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

// --- Create new alert ---
app.post("/api/watch/create", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body;
    if (!email || !postcode)
      return res.status(400).json({
        ok: false,
        error: "Please provide a valid email and postcode.",
      });

    const pcList = String(postcode)
      .split(/[,;]+/)
      .map((x) => x.trim())
      .filter(Boolean);

    if (pcList.length > 1) {
      const existing = await Watch.findOne({ email });
      if (existing && existing.plan === "free") {
        return res.json({
          ok: false,
          error:
            "Free plan supports one postcode. Please upgrade to Pro or Family.",
          upgrade: true,
        });
      }
    }

    const existing = await Watch.findOne({
      email,
      postcode: { $in: pcList },
    });
    if (existing) {
      return res.json({
        ok: false,
        error: "Alert already exists for this postcode.",
      });
    }

    const watch = new Watch({
      email,
      postcode: pcList,
      radius: Number(radius) || 5,
    });
    await watch.save();

    await sendEmail(
      email,
      "Dentist Radar Alert Created",
      `We’ll notify you when NHS dentists near ${pcList.join(
        ", "
      )} start accepting new patients.`
    );

    res.json({
      ok: true,
      message: "Alert created successfully! You’ll receive an email soon.",
    });
  } catch (err) {
    console.error("❌ Error creating alert:", err.message);
    res.status(500).json({ ok: false, error: "Server error creating alert" });
  }
});

// --- Admin Manual Scan ---
app.post("/api/scan", async (req, res) => {
  const token = process.env.SCAN_TOKEN || "";
  if (!token || req.query.token !== token) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  try {
    const result = await runScan();
    res.json({
      ok: true,
      result,
      time: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ Scan failed:", err.message);
    res.status(500).json({ ok: false, error: "Scan failed" });
  }
});

// --- Stripe Checkout ---
app.post("/api/checkout", async (req, res) => {
  if (!stripe)
    return res.status(400).json({ ok: false, error: "Stripe not configured" });
  try {
    const { email, plan } = req.body;
    const priceId =
      plan === "family"
        ? process.env.STRIPE_PRICE_FAMILY
        : process.env.STRIPE_PRICE_PRO;

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

// --- Default fallback (SPA route) ---
app.get("*", (req, res) => {
  res.sendFile(process.cwd() + "/public/index.html");
});

// --- Start Server ---
app.listen(PORT, () =>
  console.log(`🚀 Dentist Radar running on port ${PORT}`)
);
