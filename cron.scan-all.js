// cron.scan-all.js
// Entry point for Render (or any scheduler) to scan all watches.
//
// Run manually with:
//   node cron.scan-all.js

import { connectMongo, Watch } from "./models.js";
import { runAllScans } from "./scanner.js";

async function main() {
  console.log("=== cron.scan-all.js starting ===");

  try {
    await connectMongo();
    console.log("[cron] Connected to MongoDB");

    const count = await Watch.countDocuments({});
    console.log(`[cron] Watches in database: ${count}`);

    await runAllScans();

    console.log("=== cron.scan-all.js finished successfully ===");
  } catch (err) {
    console.error("=== cron.scan-all.js ERROR ===");
    console.error(err);
    process.exitCode = 1;
  } finally {
    // Allow Node to exit naturally.
  }
}

main();
