// Dentist Radar Server (v1.8.3 stable)
// Ensures MongoDB connects to the right DB ("dentistradar") even if env var missing

import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;
app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// ---------------------------
// MongoDB Connection
// ---------------------------
const uri =
  process.env.MONGO_URI ||
  "mongodb+srv://<username>:<password>@<cluster>.mongodb.net/dentistradar?retryWrites=true&w=majority";

mongoose
  .connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err.message));

// ---------------------------
// Mongo Models
// ---------------------------
const watchSchema = new mongoose.Schema(
  {
    email: String,
    postcode: String,
    radius: Number,
  },
  { timestamps: true }
);

const Watch = mongoose.model("Watch", watchSchema);

// ---------------------------
// POSTMARK EMAIL (optional)
// ---------------------------
async function sendEmail(to, subject, text) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("⚠️ No Postmark token, skipping email send.");
    return;
  }
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": key,
    },
    body: JSON.stringify({
      From: process.env.MAIL_FROM || "support@dentistradar.co.uk",
      To: to,
      Subject: subject,
      TextBody: text,
    }),
  });
  const j = await r.json();
  console.log("📧 Email result:", j);
}

// ---------------------------
// Stripe Integration (Upgrade)
// ---------------------------
const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const stripe = stripeKey ? new Stripe(stripeKey) : null;

app.post("/api/create-checkout-session", async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: "Stripe not configured" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: { name: "Dentist Radar Pro Plan" },
            unit_amount: 499, // £4.99
          },
          quantity: 1,
        },
      ],
      mode: "subscription",
      success_url: `${process.env.PUBLIC_ORIGIN || "https://dentistradar.co.uk"}/upgrade-success.html`,
      cancel_url: `${process.env.PUBLIC_ORIGIN || "https://dentistradar.co.uk"}/pricing.html`,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("Stripe session error:", err);
    res.status(500).json({ ok: false, error: "Stripe session failed" });
  }
});

// ---------------------------
// API Routes
// ---------------------------
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/watch/create", async (req, res) => {
  try {
    const { email, postcode, radius } = req.body;
    if (!email || !postcode || !radius) {
      return res.json({ ok: false, message: "Missing fields" });
    }

    const existing = await Watch.find({ email });
    if (existing.length >= 1) {
      const dup = existing.find((r) => r.postcode === postcode);
      if (dup) return res.json({ ok: false, error: "duplicate" });
      return res.json({ ok: false, error: "upgrade_required" });
    }

    const w = new Watch({ email, postcode, radius });
    await w.save();

    await sendEmail(
      email,
      "Dentist Radar alert created",
      `Your alert for ${postcode} (radius ${radius} miles) is now active. We'll notify you when NHS dentists open nearby.`
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Watch create error:", err);
    res.status(500).json({ ok: false, message: "Something went wrong." });
  }
});

// ---------------------------
// Start Server
// ---------------------------
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
