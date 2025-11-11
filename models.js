// models.js — unified models with forced DB "dentistradar"
import mongoose from "mongoose";

/** Force the connection to use the 'dentistradar' database regardless of incoming URI */
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri; // already set
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}

export async function connectMongo(uri) {
  const FIXED_URI = forceDentistRadarDb(uri || process.env.MONGO_URI || "");
  if (!FIXED_URI) throw new Error("MONGO_URI is required");
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(FIXED_URI, {
    maxPoolSize: 10,
  });
  console.log("✅ Mongo connected DB:", mongoose.connection.name);
  return mongoose.connection;
}

/** Guarded model helper to avoid OverwriteModelError */
function model(name, schema, collection) {
  if (mongoose.models[name]) return mongoose.models[name];
  return mongoose.model(name, schema, collection);
}

/* ---------------------------
   Schemas / Models
--------------------------- */

/** Watch entries (explicit collection: 'watches') */
const watchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },
    radius: Number,
  },
  { timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });
export const Watch = model("Watch", watchSchema, "watches");

/** Users (explicit collection: 'users') */
const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, index: true },
    plan: { type: String, default: "free" }, // free | pro | family
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" },
  },
  { timestamps: true, versionKey: false }
);
export const User = model("User", userSchema, "users");

/** Email logs (explicit collection: 'EmailLog') */
const emailLogSchema = new mongoose.Schema(
  {
    type: String, // 'welcome' | 'availability' | 'other'
    provider: { type: String, default: "postmark" },
    providerId: String,
    practiceUrl: String,
    dateKey: String,
    status: String, // ACCEPTING | CHILD_ONLY | ...
    meta: Object,
    sentAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
// Do NOT make (practiceUrl,dateKey) unique — we use this collection for many email types.
emailLogSchema.index({ practiceUrl: 1, dateKey: 1 });
export const EmailLog = model("EmailLog", emailLogSchema, "EmailLog");

/* ---------------------------
   Helpers
--------------------------- */

/** Quick debug snapshot used by server.js */
export async function peek() {
  const db = mongoose.connection;
  const [watches, users, emaillog] = await Promise.all([
    db.db.collection("watches").countDocuments().catch(() => 0),
    db.db.collection("users").countDocuments().catch(() => 0),
    db.db.collection("EmailLog").countDocuments().catch(() => 0),
  ]);
  return {
    db: db.name,
    counts: { watches, users, emaillog },
  };
}

export default { connectMongo, Watch, User, EmailLog, peek };
