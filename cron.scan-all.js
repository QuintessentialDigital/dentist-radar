// cron.scan-all.js
// Robust cron entrypoint for Render (or any scheduler)
//
// Modes:
//  A) Direct mode (default):   node cron.scan-all.js         -> runScan()
//     - needs MONGO_URI, EMAIL_FROM, POSTMARK_*
//     - optional POSTCODE to test a single postcode
//
//  B) HTTP trigger mode:       SCAN_HTTP_URL + SCAN_TOKEN    -> calls your /api/scan endpoint
//     - Example: SCAN_HTTP_URL=https://your-app.onrender.com/api/scan
//                SCAN_TOKEN=supersecrettoken
//
// Exit codes:
//  0 = success, 1 = config error, 2 = runtime error, 3 = HTTP trigger error

import dotenv from "dotenv";
dotenv.config();

const {
  // Common
  POSTCODE,
  NODE_ENV,
  // Direct mode
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  // HTTP mode
  SCAN_HTTP_URL,
  SCAN_TOKEN,
} = process.env;

const START = Date.now();

function logEnvSummary() {
  const mask = (s) => (s ? s.slice(0, 4) + "…" : "∅");
  console.log("🕒 Cron start", new Date().toISOString());
  console.log(
    `⚙️  Env: NODE_ENV=${NODE_ENV || "∅"} | POSTCODE=${POSTCODE || "ALL"} | Mode=${
      SCAN_HTTP_URL ? "HTTP" : "DIRECT"
    }`
  );
  if (SCAN_HTTP_URL) {
    console.log(`🌐 HTTP: SCAN_HTTP_URL=${SCAN_HTTP_URL} | SCAN_TOKEN=${mask(SCAN_TOKEN)}`);
  } else {
    console.log(
      `🗄️  Direct: MONGO_URI=${MONGO_URI ? "set" : "∅"} | EMAIL_FROM=${EMAIL_FROM || "∅"} | POSTMARK=${
        POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN ? "set" : "∅"
      }`
    );
  }
}

async function runDirect() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI for direct mode.");
    process.exit(1);
  }
  // email can be optional for discovery-only runs; we warn instead of blocking
  if (!EMAIL_FROM) console.warn("⚠️ EMAIL_FROM not set (emails will fail).");
  if (!POSTMARK_SERVER_TOKEN && !POSTMARK_TOKEN) {
    console.warn("⚠️ POSTMARK token not set (emails will be skipped).");
  }

  const { runScan } = await import("./scanner.js");
  const res = await runScan(POSTCODE ? { postcode: POSTCODE } : {});
  const dt = ((Date.now() - START) / 1000).toFixed(1);
  console.log(
    `✅ Cron finished (direct) in ${dt}s — jobs:${res.jobs} scanned:${res.scannedTotal} emails:${res.emailAttemptsTotal}`
  );
  process.exit(0);
}

async function runHttp() {
  if (!SCAN_HTTP_URL || !SCAN_TOKEN) {
    console.error("❌ HTTP mode needs SCAN_HTTP_URL and SCAN_TOKEN.");
    process.exit(1);
  }
  const url =
    SCAN_HTTP_URL +
    (SCAN_HTTP_URL.includes("?") ? "&" : "?") +
    `token=${encodeURIComponent(SCAN_TOKEN)}` +
    (POSTCODE ? `&postcode=${encodeURIComponent(POSTCODE)}` : "");

  const { default: axios } = await import("axios");
  try {
    console.log("🌐 Trigger →", url.replace(SCAN_TOKEN, "****"));
    const r = await axios.post(url, {}, { timeout: 120000 });
    console.log("↩︎ Response:", JSON.stringify(r.data));
    const dt = ((Date.now() - START) / 1000).toFixed(1);
    console.log(`✅ Cron finished (HTTP) in ${dt}s`);
    process.exit(0);
  } catch (e) {
    console.error("❌ HTTP trigger failed:", e?.response?.status, e?.response?.data || e?.message);
    process.exit(3);
  }
}

(async () => {
  try {
    logEnvSummary();
    if (SCAN_HTTP_URL) {
      await runHttp();
    } else {
      await runDirect();
    }
  } catch (e) {
    console.error("❌ Cron error:", e?.stack || e?.message || e);
    process.exit(2);
  }
})();
