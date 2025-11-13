// models.js
// Central Mongoose models for DentistRadar
// - User: registered user
// - Watch: an "alert" (postcode + radius + email)
// - EmailLog: which practices have already been emailed FOR THAT ALERT/USER

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
  },
  { timestamps: true }
);

// Index on common lookup fields
watchSchema.index({ email: 1, postcode: 1, radiusMiles: 1, radius: 1 });

// ----------------- EmailLog -----------------

/**
 * EmailLog is where we prevent duplicates and keep a history of alerts.
 *
 * IMPORTANT:
 * - We *relax* required constraints so legacy code that saves partial logs
 *   doesn't throw validation errors.
 * - Our scanner still writes full entries with all fields populated.
 */

const emailLogSchema = new mongoose.Schema(
  {
    alertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Watch",
      index: true,
    },
    email: { type: String, index: true },
    postcode: { type: String },
    radiusMiles: { type: Number },

    practiceId: { type: String }, // e.g. NHS service ID or slug
    appointmentUrl: { type: String },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Helpful analytics indices (non-unique to avoid conflicts with partial rows)
emailLogSchema.index({ alertId: 1 });
emailLogSchema.index({ email: 1, postcode: 1 });
emailLogSchema.index({ practiceId: 1 });

// NOTE:
// We intentionally do NOT add a unique index here.
// The scanner de-duplicates using "findOne + upsert" logic,
// so it will behave correctly without a DB-level unique constraint.

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
