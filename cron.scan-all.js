// cron.scan-all.js
// DentistRadar – Cron entrypoint for DB-mode scanning
//
// Usage (Render cron / manual):
//   node cron.scan-all.js
//
// Behaviour:
//   - Connects to Mongo using MONGO_URI
//   - Calls runScan() from scanner.js with no args → DB mode
//   - Logs summary and exits

import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectMongo } from "./models.js";
import { runScan } from "./scanner.js";

dotenv.config();

async function main() {
  const startedAt = new Date();
  console.log("🕒 Cron start", startedAt.toISOString());
  console.log(
    `⚙️  Env: NODE_ENV=${process.env.NODE_ENV || "unknown"} | POSTCODE=${
      process.env.POSTCODE || "ALL"
    }`
  );

  const rawUri = process.env.MONGO_URI || "";
  if (!rawUri) {
    console.error("❌ MONGO_URI is not set. Exiting.");
    process.exit(1);
  }

  try {
    const conn = await connectMongo(rawUri);
    console.log("🗄️  Mongo connected →", conn?.name || mongoose.connection?.name);
  } catch (err) {
    console.error("❌ Mongo connection error:", err?.message || err);
    process.exit(1);
  }

  try {
    // No options → DB mode (grouped by postcode+radius, sends emails)
    const result = await runScan();
    console.log("[cron] runScan() result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("❌ Cron scan error:", err?.message || err);
  } finally {
    await mongoose.connection.close().catch(() => {});
    const finishedAt = new Date();
    console.log(
      "=== DentistRadar cron.scan-all.js finished ===",
      finishedAt.toISOString()
    );
  }
}

main().catch((err) => {
  console.error("❌ Cron top-level error:", err?.message || err);
  process.exit(1);
});
