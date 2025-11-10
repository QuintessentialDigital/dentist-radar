// models.js — single source of truth for Mongoose models (guarded)
import mongoose from "mongoose";

/** Connect (idempotent) */
export async function connectMongo(uri) {
  if (!uri) throw new Error("MONGO_URI missing");
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, { maxPoolSize: 12 });
  return mongoose.connection;
}

/** Guarded factory */
function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

/**
 * IMPORTANT:
 * Use the real collection names you already have in MongoDB.
 * You said the watch records are in **`watches`** (lowercase plural),
 * so we bind the schema to { collection: 'watches' }.
 */
const watchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },
    radius: Number
  },
  { collection: "watches", timestamps: true, versionKey: false }
);
// If you used uniqueness earlier, keep it (optional):
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const userSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, index: true },
    plan: { type: String, default: "free" }, // free|pro|family
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: "active" }
  },
  { collection: "users", timestamps: true, versionKey: false }
);

const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,            // 'welcome' | 'availability' | 'other'
    provider: { type: String, default: "postmark" },
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now }
  },
  { collection: "emaillogs", versionKey: false, timestamps: false }
);

export const Watch    = model("Watch", watchSchema);
export const User     = model("User", userSchema);
export const EmailLog = model("EmailLog", emailLogSchema);

/** Quick peek helper for debugging */
export async function peek() {
  const db = mongoose.connection;
  const name = db?.name;
  const colls = await db.db.listCollections().toArray();
  const names = colls.map(c => c.name).sort();
  const watchCount = await Watch.countDocuments().catch(() => -1);
  return { db: name, collections: names, watchCount };
}
