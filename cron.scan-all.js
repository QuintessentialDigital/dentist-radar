// cron.scan-all.js
//
// Small worker script to trigger the grouped NHS scans on the backend.
//
// Usage in Render cron:
//   Command: node cron.scan-all.js
//
// Config via environment variables:
//   ADMIN_TOKEN   - same as used for /api/admin/run-all-scans
//   CRON_BASE_URL - your backend origin (e.g. https://dentistradar.onrender.com)
//
// IMPORTANT: Use the Render service URL here, NOT https://www.dentistradar.co.uk
// to avoid Cloudflare 524 timeouts on long-running jobs.

import "dotenv/config";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BASE_URL =
  process.env.CRON_BASE_URL ||
  process.env.PUBLIC_ORIGIN || // fallback if you *really* want
  "https://www.dentistradar.co.uk"; // last resort

if (!ADMIN_TOKEN) {
  console.error("❌ ADMIN_TOKEN is not set in environment.");
  process.exit(1);
}

console.log("==> Running 'node cron.scan-all.js'");
console.log("   BASE_URL   :", BASE_URL);
console.log("   ADMIN_TOKEN:", ADMIN_TOKEN ? "[set]" : "[missing]");

async function run() {
  const dryRun = false;
  const url = `${BASE_URL}/api/admin/run-all-scans?token=${encodeURIComponent(
    ADMIN_TOKEN
  )}&dryRun=${dryRun ? "true" : "false"}`;

  console.log(
    `⏱  cron.scan-all.js calling: ${url} (dryRun=${dryRun})`
  );

  try {
    // Optional: add a timeout via AbortController (avoid hanging forever)
    const controller = new AbortController();
    const timeoutMs = 300000; // 5 minutes
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
    });

    clearTimeout(timeout);

    const status = res.status;
    const text = await res.text();

    if (status === 200) {
      // Expect JSON summary
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn(
          "⚠ Received 200 but response was not valid JSON. Raw body:",
          text.slice(0, 300)
        );
        process.exit(0);
      }

      console.log("✅ Cron run-all-scans completed.");
      console.log(
        "   Summary:",
        JSON.stringify(data.summary || data, null, 2)
      );
      process.exit(0);
    }

    // Cloudflare timeout / gateway-ish errors (if you ever point at CF)
    if (status === 524 || status === 522 || status === 504) {
      console.warn(
        `⚠ Received status ${status} (likely timeout at proxy).`
      );
      console.warn(
        "   The backend may still have continued processing and sending emails."
      );
      console.warn(
        "   Check admin stats and Postmark to confirm actual email volume."
      );
      console.warn(
        "   Raw body (first 300 chars):",
        text.slice(0, 300)
      );
      // Treat this as a *soft* success for cron purposes
      process.exit(0);
    }

    console.error(
      `❌ Error calling admin run-all-scans: ${status} ${text.slice(
        0,
        300
      )}`
    );
    process.exit(1);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(
        `❌ Request aborted after timeout. The server may still be working in the background.`
      );
      process.exit(1);
    }

    console.error("❌ Unexpected error in cron.scan-all.js:", err);
    process.exit(1);
  }
}

run();
