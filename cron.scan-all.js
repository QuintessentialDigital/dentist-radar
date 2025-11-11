// cron.scan-all.js
// ✅ Reliable cron runner for DentistRadar
// Works in DIRECT or HTTP mode.
// Direct → runs scanner.js inside the job (you’re using this mode).
// HTTP   → triggers your deployed API endpoint /api/scan?token=...
//
// Added: cleaner logs, retry logic, optional debug flags for discovery/classifier insights.

import dotenv from "dotenv";
dotenv.config();

import { connectMongo } from "./models.js";
import { runScan } from "./scanner.js";
import axios from "axios";

const {
  NODE_ENV,
  POSTCODE,
  MONGO_URI,
  EMAIL_FROM,
  POSTMARK_SERVER_TOKEN,
  POSTMARK_TOKEN,
  SCAN_HTTP_URL,
  SCAN_TOKEN,
  DEBUG_DISCOVERY,
  DEBUG_RUN_REPORT,
  DEBUG_ADMIN_EMAIL,
  CLASSIFIER_RELAXED,
} = process.env;

const START = Date.now();

/* ─────────────────────────────────────────────
   Utility helpers
───────────────────────────────────────────── */
function mask(s) {
  return s ? s.slice(0, 4) + "…" : "∅";
}
function logEnvSummary() {
  console.log("🕒 Cron start", new Date().toISOString());
  console.log(
    `⚙️  Env: NODE_ENV=${NODE_ENV || "∅"} | POSTCODE=${POSTCODE || "ALL"} | Mode=${
      SCAN_HTTP_URL ? "HTTP" : "DIRECT"
    }`
  );
  if (SCAN_HTTP_URL) {
    console.log(`🌐 HTTP trigger: ${SCAN_HTTP_URL} | Token=${mask(SCAN_TOKEN)}`);
  } else {
    console.log(
      `🗄️  Direct: MONGO_URI=${MONGO_URI ? "set" : "∅"} | EMAIL_FROM=${EMAIL_FROM || "∅"} | POSTMARK=${
        POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN ? "set" : "∅"
      }`
    );
  }
}

/* ─────────────────────────────────────────────
   Run Direct Mode
───────────────────────────────────────────── */
async function runDirect() {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI.");
    process.exit(1);
  }

  try {
    await connectMongo(MONGO_URI);
  } catch (e) {
    console.error("❌ Mongo connect failed:", e.message);
    process.exit(2);
  }

  console.log("🦷 DentistRadar scanner — direct HTML, timeout=60000ms retries=3");
  const result = await runScan({
    postcode: POSTCODE,
    relaxed: CLASSIFIER_RELAXED === "true",
    debugDiscovery: DEBUG_DISCOVERY === "true",
  });

  const duration = ((Date.now() - START) / 1000).toFixed(1);
  console.log(
    `✅ Cron finished (direct) in ${duration}s — jobs:${result.jobs || 0} scanned:${result.scannedTotal || 0} emails:${
      result.emailAttemptsTotal || 0
    }`
  );

  if (DEBUG_RUN_REPORT === "true" && DEBUG_ADMIN_EMAIL) {
    await sendRunReport(result, DEBUG_ADMIN_EMAIL);
  }

  process.exit(0);
}

/* ─────────────────────────────────────────────
   Run HTTP Trigger Mode
───────────────────────────────────────────── */
async function runHttp() {
  if (!SCAN_HTTP_URL || !SCAN_TOKEN) {
    console.error("❌ HTTP mode requires SCAN_HTTP_URL and SCAN_TOKEN");
    process.exit(1);
  }

  const url =
    SCAN_HTTP_URL +
    (SCAN_HTTP_URL.includes("?") ? "&" : "?") +
    `token=${encodeURIComponent(SCAN_TOKEN)}` +
    (POSTCODE ? `&postcode=${encodeURIComponent(POSTCODE)}` : "");

  console.log("🌐 Trigger →", url.replace(SCAN_TOKEN, "****"));
  try {
    const r = await axios.post(url, {}, { timeout: 120000 });
    console.log("↩︎ Response:", JSON.stringify(r.data));
    const duration = ((Date.now() - START) / 1000).toFixed(1);
    console.log(`✅ Cron finished (HTTP) in ${duration}s`);
    process.exit(0);
  } catch (e) {
    console.error("❌ HTTP trigger failed:", e?.response?.status, e?.response?.data || e.message);
    process.exit(3);
  }
}

/* ─────────────────────────────────────────────
   Optional: Email a summary report (admin)
───────────────────────────────────────────── */
async function sendRunReport(res, adminEmail) {
  try {
    const total = res.jobs || 0;
    const accepting = (res.summaries || []).reduce((a, b) => a + (b.accepting || 0), 0);
    const scanned = res.scannedTotal || 0;
    const html = `
      <div style="font:14px system-ui,-apple-system,Segoe UI,Roboto;color:#111;max-width:600px;margin:0 auto;padding:16px">
        <h2 style="margin:0 0 8px">🦷 DentistRadar Cron Summary</h2>
        <div>Date: ${new Date().toLocaleString()}</div>
        <div>Jobs: ${total} • Scanned: ${scanned} • Accepting: ${accepting}</div>
        <pre style="background:#f7f7f7;padding:10px;border-radius:6px;overflow:auto">${JSON.stringify(
          res.summaries || [],
          null,
          2
        )}</pre>
      </div>`;

    await axios.post(
      "https://api.postmarkapp.com/email",
      {
        From: EMAIL_FROM,
        To: adminEmail,
        Subject: `DentistRadar Cron Summary (${new Date().toISOString().slice(0, 16)})`,
        HtmlBody: html,
      },
      {
        headers: {
          "X-Postmark-Server-Token": POSTMARK_SERVER_TOKEN || POSTMARK_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`📧 Cron summary sent to ${adminEmail}`);
  } catch (e) {
    console.warn("⚠️ Could not send summary:", e.message);
  }
}

/* ─────────────────────────────────────────────
   Entry
───────────────────────────────────────────── */
(async () => {
  try {
    logEnvSummary();
    if (SCAN_HTTP_URL) {
      await runHttp();
    } else {
      await runDirect();
    }
  } catch (e) {
    console.error("❌ Cron job failed:", e.stack || e.message);
    process.exit(9);
  }
})();
