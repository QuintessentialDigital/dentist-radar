// models.js — single source of truth for Mongoose models (guarded, prod-safe)
import mongoose from "mongoose";

/* ────────────────────────────────────────────────────────────────
   Connection (explicit DB selection)
   - If MONGO_URI already ends with /dbname → respected.
   - Else if MONGO_DBNAME is set → forces that db.
   - Logs the actual DB name on startup.
──────────────────────────────────────────────────────────────── */
export async function connectMongo(uri) {
  if (!uri) throw new Error("MONGO_URI missing");
  const DBNAME = (process.env.MONGO_DBNAME || "").trim();

  // does URI already contain a db name? e.g. ...mongodb.net/dentistradar?retryWrites=true
  const hasDbInUri = /mongodb(\+srv)?:\/\/[^/]+\/[^?]+/i.test(uri);

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(uri, {
    maxPoolSize: 12,
    ...(DBNAME && !hasDbInUri ? { dbName: DBNAME } : {})
  });

  console.log("✅ Mongo connected DB:", mongoose.connection.name);
  return mongoose.connection;
}

/* ────────────────────────────────────────────────────────────────
   Guarded model factory (prevents OverwriteModelError)
──────────────────────────────────────────────────────────────── */
function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

/* ────────────────────────────────────────────────────────────────
   Schemas bound to your real collection names
   IMPORTANT: Your data is in collection **watches** (lowercase plural)
──────────────────────────────────────────────────────────────── */

// Watches
const watchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },
    radius: Number
  },
  { collection: "watches", timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

// Users (optional – keep if you use plans/limits)
const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, index: true },
    plan: { type: String, default: "free" },        // free | pro | family
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" }
  },
  { collection: "users", timestamps: true, versionKey: false }
);

// Email logs
// NOTE: Includes optional fields your scanner uses for per-day dedupe:
// practiceUrl + dateKey (YYYY-MM-DD) + status
const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,                 // 'welcome' | 'availability' | 'other'
    provider: { type: String, default: "postmark" },
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now },

    // Scanner-dedupe fields (safe to be null if unused by server)
    practiceUrl: { type: String, index: true },
    dateKey: { type: String, index: true },         // e.g. '2025-11-10'
    status: { type: String }                         // 'ACCEPTING' | 'CHILD_ONLY' | 'NONE' | 'UNKNOWN'
  },
  { collection: "emaillogs", versionKey: false, timestamps: false }
);
emailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: false });

/* ────────────────────────────────────────────────────────────────
   Exports (guarded)
──────────────────────────────────────────────────────────────── */
export const Watch    = model("Watch", watchSchema);
export const User     = model("User", userSchema);
export const EmailLog = model("EmailLog", emailLogSchema);

/* ────────────────────────────────────────────────────────────────
   Debug helper (to verify DB + collections + counts)
──────────────────────────────────────────────────────────────── */
export async function peek() {
  const db = mongoose.connection;
  const name = db?.name;
  const colls = await db.db.listCollections().toArray();
  const names = colls.map((c) => c.name).sort();
  const watchCount = await Watch.countDocuments().catch(() => -1);
  return { db: name, collections: names, watchCount };
}

export default { connectMongo, Watch, User, EmailLog, peek };
