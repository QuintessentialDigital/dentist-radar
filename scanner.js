// cron.scan-all.js
// Entry point for Render (or any scheduler) to run the DentistRadar DB scan.
//
// Usage:
//   node cron.scan-all.js
//
// This will:
//   - connect to MongoDB
//   - invoke runAllScans() from scanner.js (DB mode: grouped by postcode+radius)
//   - log the summary and exit

import { connectMongo } from "./models.js";
import { runAllScans } from "./scanner.js";

async function main() {
  console.log("=== DentistRadar cron.scan-all.js starting ===");

  try {
    await connectMongo();
    console.log("[cron] Connected to MongoDB");

    const result = await runAllScans();

    console.log("[cron] runAllScans() result:", JSON.stringify(result, null, 2));
    console.log("=== DentistRadar cron.scan-all.js finished successfully ===");
  } catch (err) {
    console.error("=== DentistRadar cron.scan-all.js ERROR ===");
    console.error(err);
    process.exitCode = 1;
  }
}

main();
