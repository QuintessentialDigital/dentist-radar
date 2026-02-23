require("dotenv").config();
const mongoose = require("mongoose");
const { runOdsSync } = require("./ods-sync");
const { runNhsSnapshotBatch } = require("./nhs-snapshot");

async function main() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("Missing MONGO_URI (or MONGODB_URI).");

  await mongoose.connect(mongoUri);
  console.log("✅ Mongo connected");

  // Optional ODS sync
  const doOdsSync = (process.env.DO_ODS_SYNC || "0") === "1";
  if (doOdsSync) {
    console.log("🔄 Running ODS sync...");
    const res = await runOdsSync();
    console.log("✅ ODS sync done:", res);
  } else {
    console.log("ℹ️ Skipping ODS sync (set DO_ODS_SYNC=1 to enable)");
  }

  console.log("🕵️ Running NHS snapshot batch...");
  const snap = await runNhsSnapshotBatch();
  console.log("✅ Snapshot done:", snap);

  await mongoose.disconnect();
  console.log("✅ Mongo disconnected");
}

main().catch((err) => {
  console.error("❌ Cron failed:", err);
  process.exit(1);
});
