// cron.scan-all.js
// Purpose: run the NHS scanner on a schedule (Render Cron / any scheduler)
// Notes:
// - Respects optional POSTCODE env to scan a single postcode for testing.
// - Clean exit codes for scheduler visibility.

import dotenv from "dotenv";
dotenv.config();

import { runScan } from "./scanner.js";

async function main() {
  const postcode = process.env.POSTCODE?.trim();
  const t0 = Date.now();
  console.log("🕒 Cron start", new Date().toISOString(), postcode ? `(single: ${postcode})` : "(all groups)");
  try {
    const res = await runScan(postcode ? { postcode } : {});
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `✅ Cron finished in ${dt}s — jobs: ${res.jobs}, scanned: ${res.scannedTotal}, emails: ${res.emailAttemptsTotal}`
    );
    process.exit(0);
  } catch (e) {
    console.error("❌ Cron error:", e?.stack || e?.message || e);
    process.exit(1);
  }
}

main();
