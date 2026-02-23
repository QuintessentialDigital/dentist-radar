const mongoose = require("mongoose");

const PracticeOdsSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true }, // e.g. V186502
    name: { type: String, default: "" },
    postcode: { type: String, default: "", index: true },
    address1: { type: String, default: "" },
    address2: { type: String, default: "" },
    town: { type: String, default: "" },
    county: { type: String, default: "" },

    // Optional - add later via postcode directory mapping
    region: { type: String, default: "Unknown", index: true },

    source: { type: String, default: "ODS General Dental Practices" },
    lastOdsSyncAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PracticeOds", PracticeOdsSchema);
