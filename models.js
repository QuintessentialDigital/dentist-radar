// models.js — unified models + stable connection for DentistRadar (DB forced to 'dentistradar')
import mongoose from "mongoose";

/* Force DB name to 'dentistradar' regardless of the provided URI db segment */
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;                 // already correct
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}

/* Public connect helper */
export async function connectMongo(raw) {
  const uri = forceDentistRadarDb(raw || process.env.MONGO_URI || "");
  if (!uri) throw new Error("MONGO_URI is required");
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { maxPoolSize: 10 });
  console.log("✅ Mongo connected DB: dentistradar");
}

/* ---------- Schemas & Models ---------- */
/* WATCHES — physical collection is lowercase 'watches' */
const WatchSchema =
  mongoose.models.Watch?.schema ||
  new mongoose.Schema(
    {
      email: { type: String, index: true },
      postcode: { type: String, index: true },
      radius: Number,
    },
    { collection: "watches", timestamps: true, versionKey: false }
  );
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

/* USER — keep lightweight; some code paths expect it */
const UserSchema =
  mongoose.models.User?.schema ||
  new mongoose.Schema(
    {
      email: { type: String, unique: true, index: true },
      plan: { type: String, default: "free" },          // free | pro | family
      postcode_limit: { type: Number, default: 1 },
      status: { type: String, default: "active" },
    },
    { collection: "users", timestamps: true, versionKey: false }
  );

/* EmailLog — logs welcome/availability sends + optional provider id */
const EmailLogSchema =
  mongoose.models.EmailLog?.schema ||
  new mongoose.Schema(
    {
      type: String,                // 'welcome' | 'availability' | ...
      to: String,                  // optional; not always set for per-practice logs
      subject: String,
      provider: { type: String, default: "postmark" },
      providerId: String,
      practiceUrl: String,         // for availability logs
      status: String,              // ACCEPTING | CHILD_ONLY
      dateKey: String,             // YYYY-MM-DD
      sentAt: { type: Date, default: Date.now },
      meta: Object,
    },
    { collection: "EmailLog", timestamps: false, versionKey: false }
  );
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true, sparse: true });

/* Optional: Evidence (used by some scanners for debugging snippets) */
const PracticeEvidenceSchema =
  mongoose.models.PracticeEvidence?.schema ||
  new mongoose.Schema(
    {
      practiceUrl: { type: String, index: true },
      dateKey: { type: String, index: true },
      verdict: String,     // ACCEPTING | CHILD_ONLY | NONE | UNKNOWN
      reason: String,      // MATCH | NEGATED | WAITLIST | CHILD_ONLY | ...
      source: String,      // 'appointments' | 'detail'
      snippet: String,
      scannedAt: { type: Date, default: Date.now },
    },
    { collection: "PracticeEvidence", versionKey: false }
  );

/* Guarded model exports (avoid OverwriteModelError) */
export const Watch = mongoose.models.Watch || mongoose.model("Watch", WatchSchema);
export const User  = mongoose.models.User  || mongoose.model("User", UserSchema);
export const EmailLog =
  mongoose.models.EmailLog || mongoose.model("EmailLog", EmailLogSchema);
export const PracticeEvidence =
  mongoose.models.PracticeEvidence || mongoose.model("PracticeEvidence", PracticeEvidenceSchema);

/* Small helper for quick console peeks */
export const peek = (obj, n = 2) => JSON.stringify(obj, null, n);

export default { connectMongo, Watch, User, EmailLog, PracticeEvidence, peek };
