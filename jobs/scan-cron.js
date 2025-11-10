/**
 * DentistRadar – DB-driven scan worker (production-safe)
 * - No changes to server.js required
 * - Reads active watches from Mongo
 * - Calls runScan() from scanner.js
 * - Emails subscribers via Postmark (same env as server.js)
 * - Logs to EmailLog collection to avoid spam
 *
 * Run:
 *   node jobs/scan-cron.js
 *
 * Env required:
 *   MONGO_URI
 *   POSTMARK_SERVER_TOKEN
 *   MAIL_FROM (or EMAIL_FROM)
 *   (optional) SCAN_RADIUS, RESEND_COOLDOWN_HOURS (default 72)
 */

import dotenv from "dotenv";
dotenv.config();

import { connectMongo, Watch, EmailLog, User } from "../models.js";
import { runScan } from "../scanner.js";

// --------- Config ---------
const DEFAULT_RADIUS = parseInt(process.env.SCAN_RADIUS || "25", 10);
const RESEND_COOLDOWN_HOURS = parseInt(process.env.RESEND_COOLDOWN_HOURS || "72", 10);
const COOLDOWN_MS = RESEND_COOLDOWN_HOURS * 60 * 60 * 1000;

function forceDentistRadarDb(uri = "") {
  if (!uri) return "";
  if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
  if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
  return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
}

const RAW_URI = process.env.MONGO_URI || "";
const FIXED_URI = forceDentistRadarDb(RAW_URI);

// --------- Postmark email helper (same provider as server.js) ---------
async function sendEmail(to, subject, text, meta = {}) {
  const key = process.env.POSTMARK_SERVER_TOKEN;
  if (!key) {
    console.log("ℹ️ No POSTMARK_SERVER_TOKEN – skipping email send.");
    return { ok: false, skipped: true };
  }
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || "alerts@dentistradar.co.uk";
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": key,
    },
    body: JSON.stringify({
      From: from,
      To: to,
      Subject: subject,
      TextBody: text,
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
      Tag: "scan_alert",
    }),
  });
  const body = await r.json().catch(() => ({}));
  const ok = r.ok;

  if (ok) {
    try {
      await EmailLog.create({
        to,
        subject,
        type: "scan_alert",
        provider: "postmark",
        providerId: body.MessageID,
        meta,
        sentAt: new Date(),
      });
    } catch (e) {
      console.error("⚠️ EmailLog save error:", e?.message || e);
    }
  } else {
    console.error("❌ Postmark error:", body);
  }
  return { ok, status: r.status, body };
}

// --------- Helpers ---------
const normEmail = (s) => String(s || "").trim().toLowerCase();

async function planLimitFor(email) {
  // Matches your server.js plan logic, so we can optionally enforce per-user limits here if needed.
  try {
    const u = await User.findOne({ email: normEmail(email) }).lean();
    if (!u || u.status !== "active") return 1;
    if (u.plan === "family") return u.postcode_limit || 10;
    if (u.plan === "pro") return u.postcode_limit || 5;
    return 1;
  } catch {
    return 1;
  }
}

function buildEmailText({ postcode, radius, accepting }) {
  const lines = [
    `Good news! We found ${accepting.length} NHS practice(s) accepting new patients within ${radius} miles of ${postcode}.`,
    "",
    ...accepting.slice(0, 25).map((p, i) => `${i + 1}. ${p.title || "Practice"}\n   ${p.url}`),
    "",
    "Please call the practice to confirm before travelling.",
    "",
    "— Dentist Radar",
  ];
  return lines.join("\n");
}

// --------- Main job ---------
async function main() {
  if (!FIXED_URI) throw new Error("MONGO_URI not set");
  await connectMongo(FIXED_URI);
  console.log("✅ Worker connected to Mongo:", FIXED_URI.replace(/:[^@]+@/, ":***@"));

  // 1) Load active watches
  const watches = await Watch.find({}).lean(); // if you store active flag, filter: { active: true }
  if (!watches.length) {
    console.log("No watches found; exiting.");
    process.exit(0);
  }

  // 2) Group by postcode to avoid duplicate scans
  const byPostcode = new Map();
  for (const w of watches) {
    const pc = (w.postcode || "").toUpperCase().trim();
    if (!pc) continue;
    const arr = byPostcode.get(pc) || [];
    arr.push(w);
    byPostcode.set(pc, arr);
  }

  let totalScanned = 0;
  let totalEmails  = 0;

  // 3) Scan each postcode once
  for (const [postcode, watchers] of byPostcode.entries()) {
    const radius = watchers[0]?.radius || DEFAULT_RADIUS;

    console.log(`\n🔎 Scanning ${postcode} (${radius} miles) for ${watchers.length} watcher(s)…`);

    const scan = await runScan({ postcode, radius, includeChildOnly: false });
    const accepting = (scan?.accepting || []).filter(Boolean);

    console.log(`   → accepting=${accepting.length}; errors=${(scan?.errors || []).length}`);

    totalScanned++;

    if (!accepting.length) continue;

    // 4) Email watchers for this postcode (with cooldown)
    for (const w of watchers) {
      // optional: enforce plan limit (usually enforced on create)
      await planLimitFor(w.email); // not used to block here; included to show symmetry with server

      // dedupe: skip if we emailed the same recipient for this postcode very recently
      const since = new Date(Date.now() - COOLDOWN_MS);
      const recent = await EmailLog.find({
        to: normEmail(w.email),
        "meta.postcode": postcode,
        sentAt: { $gte: since },
      })
        .sort({ sentAt: -1 })
        .limit(1)
        .lean();

      if (recent.length) {
        // still send only if there is at least one *new* practice URL the user hasn’t seen recently
        const recentUrls = new Set(
          (await EmailLog.find({
            to: normEmail(w.email),
            sentAt: { $gte: since },
          })
            .select({ "meta.acceptingUrls": 1 })
            .limit(10)
            .lean()
          ).flatMap(r => r?.meta?.acceptingUrls || [])
        );

        const fresh = accepting.filter(p => !recentUrls.has(p.url));
        if (!fresh.length) {
          console.log(`   ↳ skip ${w.email} (cooldown & no new practices)`);
          continue;
        }
      }

      const text = buildEmailText({ postcode, radius, accepting });
      const meta = {
        postcode,
        radius,
        acceptingCount: accepting.length,
        // store URLs to help cooldown's "new practice" check next time
        acceptingUrls: accepting.map(p => p.url).slice(0, 100),
      };

      const resp = await sendEmail(w.email, `Dentist Radar — ${accepting.length} accepting near ${postcode}`, text, meta);
      if (resp.ok) {
        totalEmails++;
        console.log(`   ✉ sent → ${w.email}`);
      } else {
        console.log(`   ✉ failed → ${w.email} (${resp.status || "no-status"})`);
      }
    }
  }

  console.log(`\n✅ Job finished. postcodes scanned=${totalScanned}, emails sent=${totalEmails}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Worker failed:", e?.message || e);
  process.exit(1);
});
