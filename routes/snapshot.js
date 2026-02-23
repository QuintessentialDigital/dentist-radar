const express = require("express");
const PracticeStatusLatest = require("../models/PracticeStatusLatest");

const router = express.Router();

router.get("/snapshot", async (req, res) => {
  const total = await PracticeStatusLatest.countDocuments({});
  const accepting = await PracticeStatusLatest.countDocuments({ status: "accepting" });
  const notAccepting = await PracticeStatusLatest.countDocuments({ status: "not_accepting" });
  const unknown = await PracticeStatusLatest.countDocuments({ status: "unknown" });

  const latestCheck = await PracticeStatusLatest.findOne({}).sort({ checkedAt: -1 }).select({ checkedAt: 1 }).lean();

  res.json({
    asOf: latestCheck?.checkedAt || null,
    practiceCount: total,
    accepting,
    notAccepting,
    unknown,
    note:
      "Snapshot reflects NHS.uk public practice-page signals at the time each practice was checked. Unknown includes no explicit statement, unavailable pages, or errors.",
  });
});

router.get("/snapshot/regions", async (req, res) => {
  const pipeline = [
    {
      $group: {
        _id: "$region",
        practiceCount: { $sum: 1 },
        accepting: { $sum: { $cond: [{ $eq: ["$status", "accepting"] }, 1, 0] } },
        notAccepting: { $sum: { $cond: [{ $eq: ["$status", "not_accepting"] }, 1, 0] } },
        unknown: { $sum: { $cond: [{ $eq: ["$status", "unknown"] }, 1, 0] } },
        maxCheckedAt: { $max: "$checkedAt" },
      },
    },
    { $sort: { _id: 1 } },
  ];

  const rows = await PracticeStatusLatest.aggregate(pipeline);
  res.json(
    rows.map((r) => ({
      region: r._id || "Unknown",
      practiceCount: r.practiceCount,
      accepting: r.accepting,
      notAccepting: r.notAccepting,
      unknown: r.unknown,
      asOf: r.maxCheckedAt,
    }))
  );
});

module.exports = router;
