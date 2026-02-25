const mongoose = require("mongoose");

const PracticeVcodeSchema = new mongoose.Schema(
  {
    vcode: { type: String, required: true, unique: true, index: true }, // V123456
    name: { type: String, default: "" },
    address: { type: String, default: "" },

    // --- Canonical NHS URL (base; without /appointments)
    nhsUrl: { type: String, default: "" },

    // --- Discovery metadata
    postcodeGuess: { type: String, default: "" }, // from discovery seeds (optional)
    sources: {
      postcodes: { type: [String], default: [] },
      count: { type: Number, default: 0 },
    },
    lastSeenAt: { type: Date, default: null },

    // --- Enrichment (you already populated these)
    postcode: { type: String, default: "" }, // store normalized or formatted consistently
    outwardCode: { type: String, default: "" }, // e.g., RG1
    region: { type: String, default: "Unknown" },

    regionSource: {
      type: String,
      default: "unknown",
      enum: ["postcode_exact", "outward_majority", "unknown", "fetch_failed"],
    },
    regionConfidence: { type: Number, default: 0.0 },
    regionEnrichedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PracticeVcode", PracticeVcodeSchema);
