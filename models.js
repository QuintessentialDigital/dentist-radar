// models.js
// Central Mongoose models for DentistRadar
// - User: registered user
// - Watch: an "alert" (postcode + radius + email)
// - EmailLog: alert/email history & de-duplication

import mongoose from "mongoose";

let mongoReadyPromise = null;

export async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;

  if (!mongoReadyPromise) {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      throw new Error("MONGO_URI is required");
    }

    mongoReadyPromise = mongoose.connect(uri, {
      dbName: process.env.MONGO_DB || "dentistradar",
    });
  }

  return mongoReadyPromise;
}

// ----------------- User -----------------

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    name: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ----------------- Watch / Alert -----------------

const watchSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true }, // user email
    postcode: { type: String, required: true },

    // Optional so old code that uses "radius" still works
    radiusMiles: { type: Number },

    // For backward compatibility if your server/front-end uses "radius"
    radius: { type: Number },

    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastRunAt: { type: Date },

    // Some paths use unsubscribed instead of active=false
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Index on common lookup fields
watchSchema.index({ email: 1, postcode: 1, radiusMiles: 1, radius: 1 });

// ----------------- EmailLog -----------------

/**
 * EmailLog is where we prevent duplicates and keep a history of alerts.
 *
 * It is used in multiple ways:
 *  - Legacy scanner: per-practice logging using alertId + practiceId + appointmentUrl
 *  - Current scanner: per-watch logging using watchId + signature
 *  - Server-side email logging (Postmark) using type/subject/providerId/meta
 *
 * All fields are optional so legacy records continue to work.
 */

const emailLogSchema = new mongoose.Schema(
  {
    // Legacy: per-alert/practice logging
    alertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Watch",
      index: true,
    },

    // Current scanner: per-watch logging
    watchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Watch",
      index: true,
    },

    email: { type: String, index: true },
    postcode: { type: String },
    radiusMiles: { type: Number },

    // Legacy per-practice fields
    practiceId: { type: String }, // e.g. NHS service ID or slug
    appointmentUrl: { type: String },

    // Current scanner summary info for de-duplication
    acceptingCount: { type: Number },
    signature: { type: String }, // concatenated list of accepting URLs

    // Generic email logging (e.g. Postmark)
    type: { type: String }, // "alert", "welcome", "plan_activated", etc.
    subject: { type: String },
    providerId: { type: String }, // e.g. Postmark MessageID
    meta: { type: mongoose.Schema.Types.Mixed },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Helpful analytics indices (non-unique)
emailLogSchema.index({ email: 1, postcode: 1 });
emailLogSchema.index({ practiceId: 1 });
// watchId already has an index via field definition

// ----------------- Peek helper -----------------

export async function peek() {
  const [users, watches, logs] = await Promise.all([
    User.countDocuments(),
    Watch.countDocuments(),
    EmailLog.countDocuments(),
  ]);

  return { users, watches, logs };
}

// ----------------- Export models -----------------

export const User =
  mongoose.models.User || mongoose.model("User", userSchema);

export const Watch =
  mongoose.models.Watch || mongoose.model("Watch", watchSchema);

export const EmailLog =
  mongoose.models.EmailLog || mongoose.model("EmailLog", emailLogSchema);
