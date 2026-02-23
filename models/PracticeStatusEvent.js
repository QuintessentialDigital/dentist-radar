const mongoose = require("mongoose");

const PracticeStatusEventSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, index: true },
    status: { type: String, required: true, index: true }, // accepting | not_accepting | unknown
    checkedAt: { type: Date, required: true, index: true },
    nhsUrl: { type: String, default: "" },
    ok: { type: Boolean, default: true },
    error: { type: String, default: "" },

    // helpful for later aggregation without joins
    region: { type: String, default: "Unknown", index: true },
  },
  { timestamps: true }
);

PracticeStatusEventSchema.index({ code: 1, checkedAt: -1 });

module.exports = mongoose.model("PracticeStatusEvent", PracticeStatusEventSchema);
