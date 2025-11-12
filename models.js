// models.js — stable models + connection (DentistRadar)

// Use ESM
import mongoose from "mongoose";

function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}

export async function connectMongo(raw) {
  const uri = forceDentistRadarDb(raw || process.env.MONGO_URI || "");
  if (!uri) throw new Error("MONGO_URI is required");
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(uri, { maxPoolSize: 10 });
  console.log("✅ Mongo connected DB: dentistradar");
}

// WATCHES (note: physical collection name is lowercase "watches")
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
      type: String, // 'welcome' | 'availability'
      to: String,
      subject: String,
      provider: { type: String, default: "postmark" },
      providerId: String,
      practiceUrl: String,
      status: String, // ACCEPTING | CHILD_ONLY
      dateKey: String,
      sentAt: { type: Date, default: Date.now },
      meta: Object
    },
    { collection: "EmailLog", timestamps: false, versionKey: false }
  );
EmailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: true, sparse: true });

export const Watch = mongoose.models.Watch || mongoose.model("Watch", WatchSchema);
export const EmailLog = mongoose.models.EmailLog || mongoose.model("EmailLog", EmailLogSchema);

// small helper for debugging
export const peek = (obj, n = 2) => JSON.stringify(obj, null, n);
