// models.js — single source of truth for Mongoose models + shared connection
import mongoose from 'mongoose';

/* =========================
   Schemas
   ========================= */
const SearchAreaSchema = new mongoose.Schema(
  {
    postcode: { type: String, required: true },
    radiusMiles: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { collection: 'SearchAreas' }
);

const PracticeSchema = new mongoose.Schema(
  {
    name: String,
    postcode: String,
    detailsUrl: String,
    distanceMiles: Number, // precomputed/ingested
  },
  { collection: 'Practices' }
);

const EmailLogSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, index: true },
    practiceId: { type: mongoose.Schema.Types.ObjectId, index: true },
    practiceUrl: String,
    status: { type: String, enum: ['ACCEPTING', 'CHILD_ONLY', 'WELCOME', 'OTHER'] },
    dateKey: { type: String, index: true }, // YYYY-MM-DD for de-dupe windows
    to: String,            // for welcome/other logs
    subject: String,       // for welcome/other logs
    provider: String,      // e.g., 'postmark'
    providerId: String,    // Postmark MessageID
    meta: Object,
    sentAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'EmailLog' }
);

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true },
    active: { type: Boolean, default: true },
    receiveAlerts: { type: Boolean, default: true },
    plan: { type: String, default: 'free' },          // free | pro | family
    postcode_limit: { type: Number, default: 1 },
    postcodes: [String],                               // e.g., ["RG6 1AB","RG1"]
    areas: [{ postcode: String, radiusMiles: Number }],// optional targeting objects
    status: { type: String, default: 'active' },
  },
  { collection: 'Users', timestamps: true, versionKey: false }
);

const WatchSchema = new mongoose.Schema(
  {
    email:   { type: String, index: true },
    postcode:{ type: String, index: true },
    radius:  Number,
  },
  { collection: 'Watch', timestamps: true, versionKey: false }
);
WatchSchema.index({ email: 1, postcode: 1 }, { unique: true });

/* =========================
   Safe model getter
   ========================= */
function getModel(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

/* =========================
   Export Models
   ========================= */
export const SearchArea = getModel('SearchArea', SearchAreaSchema);
export const Practice   = getModel('Practice',   PracticeSchema);
export const EmailLog   = getModel('EmailLog',   EmailLogSchema);
export const User       = getModel('User',       UserSchema);
export const Watch      = getModel('Watch',      WatchSchema);

/* =========================
   Shared connection helpers
   ========================= */
let connectingPromise = null;

export async function connectMongo(uri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection; // connected
  if (connectingPromise) return connectingPromise;
  if (!uri) throw new Error('MONGO_URI is required');

  connectingPromise = mongoose
    .connect(uri, { maxPoolSize: 10 })
    .then((conn) => conn)
    .finally(() => { connectingPromise = null; });

  return connectingPromise;
}

export async function disconnectMongo() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
}
