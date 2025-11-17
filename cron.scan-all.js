// cron.scan-all.js
// DentistRadar – Cron entrypoint for DB-mode scanning
//
// Usage (Render cron / manual):
//   node cron.scan-all.js
//
// Behaviour:
//   - Ensures MONGO_URI is set
//   - Calls runAllScans() from scanner.js → DB mode (grouped by postcode+radius)
//   - scanner.js itself handles Mongo connection via connectMongo()

import "dotenv/config";
import { runAllScans } from "./scanner.js";

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
    // DB mode (scanner.js will call connectMongo() and do all grouping + emailing)
    await runAllScans();
    console.log("[cron] runAllScans() completed successfully.");
  } catch (err) {
    console.error("❌ Cron scan error:", err?.message || err);
  } finally {
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
