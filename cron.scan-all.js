// cron.scan-all.js
// Simple cron runner for DentistRadar scanner.
// Usage on Render: `node cron.scan-all.js`

import "dotenv/config";
import { runAllScans } from "./scanner.js";

async function main() {
  const start = Date.now();

  const postcodeMode = process.env.POSTCODE || "ALL";
  const nodeEnv = process.env.NODE_ENV || "development";

  console.log(`🕒 Cron start ${new Date().toISOString()}`);
  console.log(
    `⚙️  Env: NODE_ENV=${nodeEnv} | POSTCODE=${postcodeMode} | Mode=DIRECT`
  );
  console.log(
    `🗄️  Direct: MONGO_URI=${process.env.MONGO_URI ? "set" : "missing"} | EMAIL_FROM=${process.env.EMAIL_FROM || process.env.FROM_EMAIL || "missing"} | POSTMARK=${process.env.POSTMARK_API_TOKEN ? "set" : "missing"}`
  );
  console.log(
    "🦷 DentistRadar scanner — direct HTML, timeout=60000ms retries=3"
  );

  let results = [];
  try {
    results = await runAllScans();
  } catch (err) {
    console.error("❌ Cron error while running scans:", err.message);
    process.exit(1);
  }

  // Aggregate stats from scanner results
  let jobs = results.length;
  let totalScanned = 0;
  let totalEmails = 0;

  for (const r of results) {
    totalScanned += r.scanned || 0;
    totalEmails += r.newAccepting || 0; // count "newAccepting" as email-worthy hits
  }

  const ms = Date.now() - start;
  const seconds = (ms / 1000).toFixed(1);

  console.log(
    `✅ Cron finished (direct) in ${seconds}s — jobs:${jobs} scanned:${totalScanned} emails:${totalEmails}`
  );

  // Optional: log full result JSON for debugging
  // console.log(JSON.stringify(results, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Cron fatal error:", err);
  process.exit(1);
});
