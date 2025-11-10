// models.js — single source of truth with HARD guard (no silent 'test')
import mongoose from "mongoose";

/* ────────────────────────────────────────────────────────────────
   Connection with explicit DB resolution + guard
──────────────────────────────────────────────────────────────── */
export async function connectMongo(uri) {
  if (!uri) throw new Error("MONGO_URI missing");

  const envDb = (process.env.MONGO_DBNAME || "").trim();
  const hasDbInUri = /mongodb(\+srv)?:\/\/[^/]+\/([^?]+)/i.test(uri);
  // Extract db from URI if present
  const uriDbMatch = uri.match(/mongodb(\+srv)?:\/\/[^/]+\/([^?]+)/i);
  const uriDb = uriDbMatch ? uriDbMatch[2] : "";

  // Determine the final DB name Mongoose will use
  const finalDbName = hasDbInUri ? uriDb : (envDb || "test");

  // HARD GUARD: never silently connect to 'test'
  const allowTest = String(process.env.ALLOW_TEST_DB || "").toLowerCase() === "true";
  if (finalDbName.toLowerCase() === "test" && !allowTest) {
    throw new Error(
      "Refusing to connect to MongoDB 'test' database. " +
      "Add a DB name to MONGO_URI (…/dentistradar) or set MONGO_DBNAME=dentistradar. " +
      "To override (not recommended), set ALLOW_TEST_DB=true."
    );
  }

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(uri, {
    maxPoolSize: 12,
    ...(hasDbInUri ? {} : (envDb ? { dbName: envDb } : {})),
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
   Schemas bound to your real, existing collection names
   You said the real data is in 'watches' (lowercase plural)
──────────────────────────────────────────────────────────────── */
const watchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },
    radius: Number,
  },
  { collection: "watches", timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, index: true },
    plan: { type: String, default: "free" }, // free|pro|family
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" },
  },
  { collection: "users", timestamps: true, versionKey: false }
);

const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String, // 'welcome' | 'availability' | 'other'
    provider: { type: String, default: "postmark" },
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now },

    // Scanner dedupe helpers (optional)
    practiceUrl: { type: String, index: true },
    dateKey: { type: String, index: true }, // 'YYYY-MM-DD'
    status: { type: String },               // 'ACCEPTING' | 'CHILD_ONLY' | 'NONE' | 'UNKNOWN'
  },
  { collection: "emaillogs", versionKey: false, timestamps: false }
);
emailLogSchema.index({ practiceUrl: 1, dateKey: 1 });

export const Watch    = model("Watch", watchSchema);
export const User     = model("User", userSchema);
export const EmailLog = model("EmailLog", emailLogSchema);

/* ────────────────────────────────────────────────────────────────
   Debug helper
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
