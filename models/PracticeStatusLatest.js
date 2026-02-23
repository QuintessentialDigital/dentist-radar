const mongoose = require("mongoose");

const PracticeStatusLatestSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, index: true }, // matches PracticeOds.code
    nhsUrl: { type: String, default: "" },

    // accepting | not_accepting | unknown
    status: { type: String, required: true, index: true },

    // store evidence snippet for audit credibility
    statusEvidence: { type: String, default: "" },

    checkedAt: { type: Date, required: true, index: true },
    ok: { type: Boolean, default: true },
    error: { type: String, default: "" },

    postcode: { type: String, default: "", index: true },
    region: { type: String, default: "Unknown", index: true },
    name: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PracticeStatusLatest", PracticeStatusLatestSchema);
