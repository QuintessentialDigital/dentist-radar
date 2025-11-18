// cron.scan-all.js
// Lightweight cron runner that calls the server's admin endpoint.
//
// Usage (Render worker command):
//   node cron.scan-all.js
//
// Env:
//   ADMIN_TOKEN    – must match process.env.ADMIN_TOKEN in server
//   PUBLIC_ORIGIN  – e.g. "https://www.dentistradar.co.uk"
//   CRON_DRY_RUN   – "true" or "false" (optional, default false)

import "dotenv/config";
import axios from "axios";

async function main() {
  const token = process.env.ADMIN_TOKEN;
  const origin =
    process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";
  const dryRun =
    String(process.env.CRON_DRY_RUN || "false").toLowerCase() === "true";

  if (!token) {
    console.error(
      "❌ ADMIN_TOKEN is not set in environment – cannot call admin scan endpoint."
    );
    process.exit(1);
  }

  const url = `${origin}/api/admin/run-all-scans?token=${encodeURIComponent(
    token
  )}&dryRun=${dryRun ? "true" : "false"}`;

  console.log(
    `⏱  cron.scan-all.js calling: ${url} (dryRun=${dryRun})`
  );

  try {
    const res = await axios.post(url, {});
    console.log("✅ Admin run-all-scans response:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(
      "❌ Error calling admin run-all-scans:",
      err?.response?.status,
      err?.response?.data || err?.message || err
    );
    process.exit(1);
  }
}

main();
