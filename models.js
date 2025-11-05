// models.js — single source of truth for Mongoose models + shared connection
import mongoose from 'mongoose';

/* =========================
   Schemas
   ========================= */

// Practices (ingested list of NHS practices)
const PracticeSchema = new mongoose.Schema(
  {
    name: String,
    postcode: String,              // e.g., "RG41 4UW"
    detailsUrl: String,            // NHS details page (used to locate Appointments tab)
    distanceMiles: Number,         // legacy/optional
    lat: Number,                   // optional: practice latitude
    lon: Number                    // optional: practice longitude
  },
  { collection: 'Practices' }
);

// helpful index (fast de-dupe/lookups)
PracticeSchema.index({ detailsUrl: 1 }, { sparse: true });
PracticeSchema.index({ nhsUrl: 1 }, { sparse: true });
PracticeSchema.index({ url: 1 }, { sparse: true });

// Email log (dedupe + trace)
const EmailLogSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, index: true }, // optional for legacy (SearchAreas)
    practiceId: { type: mongoose.Schema.Types.ObjectId, index: true },
    practiceUrl: String,

    status: { type: String, enum: ['ACCEPTING', 'CHILD_ONLY', 'WELCOME', 'OTHER'] },
    dateKey: { type: String, index: true }, // YYYY-MM-DD for daily dedupe

    // generic email log fields for welcome/other emails
    to: String,
    subject: String,
    provider: String,
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now },

    createdAt: { type: Date, default: Date.now }
  },
  { collection: 'EmailLog', versionKey: false }
);

// Users (recipients)
const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    active: { type: Boolean, default: true },
    receiveAlerts: { type: Boolean, default: true },

    // targeting (optional)
    postcodes: [String],                    // e.g. ["RG41 4UW","RG1"]
    areas: [{ postcode: String, radiusMiles: Number }],

    // plan/admin
    plan: { type: String, default: 'free' },
    postcode_limit: { type: Number, default: 1 },
    status: { type: String, default: 'active' }
  },
  { collection: 'Users', timestamps: true, versionKey: false }
);

// Watch (your “table” that drives jobs)
const WatchSchema = new mongoose.Schema(
  {
    email: { type: String, index: true },
    postcode: { type: String, index: true },  // normalized like "RG41 4UW"
    radius: Number                            // miles
  },
  { collection: 'Watch', timestamps: true, versionKey: false }
);
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

// Postcodes (lat/lon lookup for radius filtering)
const PostcodeSchema = new mongoose.Schema(
  {
    postcode: { type: String, required: true, unique: true, index: true }, // normalized "RG41 4UW"
    lat: { type: Number, required: true },
    lon: { type: Number, required: true }
  },
  { collection: 'Postcodes', versionKey: false }
);

/* =========================
   Safe model getter
   ========================= */
function getModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

/* =========================
   Exports (models)
   ========================= */
export const Practice = getModel('Practice', PracticeSchema);
export const EmailLog = getModel('EmailLog', EmailLogSchema);
export const User     = getModel('User', UserSchema);
export const Watch    = getModel('Watch', WatchSchema);
export const Postcode = getModel('Postcode', PostcodeSchema);

/* =========================
   Shared connection helpers
   ========================= */
let connectingPromise = null;

export async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;   // connected
  if (connectingPromise) return connectingPromise;
  if (!uri) throw new Error('MONGO_URI is required');

  connectingPromise = mongoose
    .connect(uri, { maxPoolSize: 10 })
    .then(conn => conn)
    .finally(() => { connectingPromise = null; });

  return connectingPromise;
}

export async function disconnectMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
