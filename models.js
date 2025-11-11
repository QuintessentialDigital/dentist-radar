// models.js
import mongoose from "mongoose";

/** Always write to the 'dentistradar' database, regardless of incoming URI db segment */
function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
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

/** Guarded model helper (avoids OverwriteModelError) */
function model(name, schema, collection) {
  if (mongoose.models[name]) return mongoose.models[name];
  if (collection) return mongoose.model(name, schema, collection);
  return mongoose.model(name, schema);
}

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

/** EmailLog (explicit collection) */
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
emailLogSchema.index({ practiceUrl: 1, dateKey: 1 }, { unique: false });
export const EmailLog = model("EmailLog", emailLogSchema, "EmailLog");

export default { connectMongo, Watch, EmailLog };
