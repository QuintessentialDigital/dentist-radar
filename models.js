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
    radiusMiles: { type: Number, required: true },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastRunAt: { type: Date },
  },
  { timestamps: true }
);

watchSchema.index({ email: 1, postcode: 1, radiusMiles: 1 });

// ----------------- EmailLog -----------------

/**
 * EmailLog is where we prevent duplicates.
 *
 * IMPORTANT:
 * - We de-dup per ALERT (watch) + PRACTICE, not globally.
 *   That means:
 *   - User A and User B with same postcode both get their own emails.
 *   - User A doesn't get spammed twice for the same practice on the same alert.
 */
const emailLogSchema = new mongoose.Schema(
  {
    alertId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Watch",
      required: true,
      index: true,
    },
    email: { type: String, required: true, index: true },
    postcode: { type: String, required: true },
    radiusMiles: { type: Number, required: true },

    practiceId: { type: String, required: true }, // e.g. NHS service ID or slug
    appointmentUrl: { type: String, required: true },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ✅ key uniqueness: an alert can only email a given practice once
emailLogSchema.index(
  { alertId: 1, practiceId: 1, appointmentUrl: 1 },
  { unique: true }
);

// Optional helpful index for analytics
emailLogSchema.index({ email: 1, postcode: 1 });

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
