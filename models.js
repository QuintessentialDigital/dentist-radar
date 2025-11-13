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

    // Make this OPTIONAL so old code that uses "radius" still works
    radiusMiles: { type: Number },

    // For backward compatibility if your server/front-end uses "radius"
    radius: { type: Number },

    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    lastRunAt: { type: Date },
  },
  { timestamps: true }
);

// Index on what we typically care about
watchSchema.index({ email: 1, postcode: 1, radiusMiles: 1, radius: 1 });

// ----------------- EmailLog -----------------

/**
 * EmailLog is where we prevent duplicates.
 *
 * We de-dup per ALERT (watch) + PRACTICE, not globally.
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

    // We'll log the effective radius used (miles)
    radiusMiles: { type: Number, required: true },

    practiceId: { type: String, required: true }, // NHS service ID / slug
    appointmentUrl: { type: String, required: true },

    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// An alert can only email a given practice once
emailLogSchema.index(
  { alertId: 1, practiceId: 1, appointmentUrl: 1 },
  { unique: true }
);

// Helpful analytics index
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
