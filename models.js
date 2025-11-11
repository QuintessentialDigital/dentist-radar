// models.js — single source of truth for DB & models (with User)

import mongoose from "mongoose";

const { MONGO_URI = "" } = process.env;
if (!MONGO_URI) throw new Error("MONGO_URI is required");

// Force DB name to 'dentistradar' even if a different one sneaks in
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}
const FIXED_URI = forceDentistRadarDb(MONGO_URI);

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(FIXED_URI, { maxPoolSize: 10 });
  console.log("✅ Mongo connected DB:", mongoose.connection.name);
}

// ----- Schemas -----

// Watches — physical collection name 'watches'
const WatchSchema =
  mongoose.models.Watch?.schema ||
  new mongoose.Schema(
    {
      email: { type: String, index: true },
      postcode: { type: String, index: true },
      radius: Number
    },
    { collection: "watches", timestamps: true, versionKey: false }
  );
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

// Users — optional, used by server
const UserSchema =
  mongoose.models.User?.schema ||
  new mongoose.Schema(
    {
      email: { type: String, unique: true, index: true },
      plan: { type: String, default: "free" },          // free | pro | family
      postcode_limit: { type: Number, default: 1 },
      status: { type: String, default: "active" }       // active | paused | canceled
    },
    { collection: "users", timestamps: true, versionKey: false }
  );

// EmailLog — daily de-dupe and provider metadata
const EmailLogSchema =
  mongoose.models.EmailLog?.schema ||
  new mongoose.Schema(
    {
      type: { type: String, default: "availability" },  // availability | welcome | other
      practiceUrl: { type: String, index: true },
      dateKey: { type: String, index: true },           // YYYY-MM-DD
      status: String,                                   // ACCEPTING | CHILD_ONLY
      provider: { type: String, default: "postmark" },
      providerId: String,
      sentAt: { type: Date, default: Date.now }
    },
    { collection: "EmailLog", versionKey: false }
  );
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true, sparse: true });

// ----- Models -----
export const Watch    = mongoose.models.Watch    || mongoose.model("Watch", WatchSchema);
export const User     = mongoose.models.User     || mongoose.model("User", UserSchema);
export const EmailLog = mongoose.models.EmailLog || mongoose.model("EmailLog", EmailLogSchema);

// Tiny helper for quick, pretty logs
export const peek = (o, n = 1) => JSON.stringify(o, null, n);
