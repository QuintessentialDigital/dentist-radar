// models.js — single source of truth for DB & models

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

// Watches: we will always use the physical collection name 'watches'
const WatchSchema =
  mongoose.models.Watch?.schema ||
  new mongoose.Schema(
    { email: { type: String, index: true }, postcode: { type: String, index: true }, radius: Number },
    { collection: "watches", timestamps: true, versionKey: false }
  );
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const EmailLogSchema =
  mongoose.models.EmailLog?.schema ||
  new mongoose.Schema(
    {
      type: { type: String, default: "availability" }, // 'availability' | 'welcome' | ...
      practiceUrl: { type: String, index: true },
      dateKey: { type: String, index: true }, // YYYY-MM-DD
      status: String, // ACCEPTING | CHILD_ONLY
      sentAt: { type: Date, default: Date.now }
    },
    { collection: "EmailLog", versionKey: false }
  );
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true, sparse: true });

export const Watch = mongoose.models.Watch || mongoose.model("Watch", WatchSchema);
export const EmailLog = mongoose.models.EmailLog || mongoose.model("EmailLog", EmailLogSchema);

// Tiny helper for quick peeks in logs
export const peek = (o, n = 1) => JSON.stringify(o, null, n);
