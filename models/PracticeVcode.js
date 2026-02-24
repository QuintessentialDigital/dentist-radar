const mongoose = require("mongoose");

const PracticeVcodeSchema = new mongoose.Schema(
  {
    vcode: { type: String, required: true, unique: true, index: true }, // V123456
    name: { type: String, default: "" },
    address: { type: String, default: "" },
    postcodeGuess: { type: String, default: "" }, // not always available
    nhsUrl: { type: String, default: "" },         // base URL (without /appointments)
    lastSeenAt: { type: Date, default: null },
    sources: {
      postcodes: { type: [String], default: [] }, // which seed postcodes found it
      count: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("PracticeVcode", PracticeVcodeSchema);
