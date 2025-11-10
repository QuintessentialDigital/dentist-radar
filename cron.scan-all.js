// cron.scan-all.js
// DentistRadar hourly scanner + mailer (no changes to server.js)
// Usage:
//   DR_DRY_RUN=1 node cron.scan-all.js            # dry run (no emails)
//   node cron.scan-all.js                          # live run (emails sent)
//   SCAN_ONLY="RG41 4UW|RG1 1AA" node cron.scan-all.js   # limit postcodes in dev

import dotenv from "dotenv";
dotenv.config();

import { connectMongo, Watch, EmailLog, User } from "./models.js";
import { runScan } from "./scanner.js";

// --- Config ---
const MONGO_URI = process.env.MONGO_URI || "";
const POSTMARK_TOKEN = process.env.POSTMARK_SERVER_TOKEN || ""; // if empty → emails are skipped
const ORIGIN = process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk";
const DRY_RUN = /^1|true$/i.test(process.env.DR_DRY_RUN || "0");
const ALERT_COOLDOWN_HOURS = parseInt(process.env.DR_ALERT_COOLDOWN_HOURS || "12", 10); // per (email, postcode)
const INCLUDE_CHILD_ONLY = /^1|true$/i.test(process.env.DR_INCLUDE_CHILD_ONLY || "1");  // include child-only in found?
const MAX_SCAN_CONCURRENCY = parseInt(process.env.DR_MAX_BATCH_CONCURRENCY || "4", 10);

// Optional dev filter: comma or | separated list of postcodes to scan only
const LIMIT_TO = (process.env.SCAN_ONLY || "")
  .split(/[,\|]/).map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase());

// --- Utilities ---
function normalizePostcode(raw = "") {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length < 5) return raw.toUpperCase().trim();
  return `${t.slice(0, t.length - 3)} ${t.slice(-3)}`.trim();
}
function nowIso() { return new Date().toISOString(); }

async function sendEmailPostmark(to, subject, text, tag = "alert", meta = {}) {
  if (!POSTMARK_TOKEN) {
    console.log(`ℹ️  [MAIL] Skipped (no POSTMARK_SERVER_TOKEN). To=${to} Subj="${subject}"`);
    return { ok: false, skipped: true };
  }
  if (DRY_RUN) {
    console.log(`✉️  [MAIL] DRY-RUN → To=${to} Subj="${subject}"`);
    return { ok: true, dryRun: true };
  }
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": POSTMARK_TOKEN
    },
    body: JSON.stringify({
      From: process.env.MAIL_FROM || process.env.EMAIL_FROM || "alerts@dentistradar.co.uk",
      To: to,
      Subject: subject,
      TextBody: text,
      MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound",
      Tag: tag
    })
  });
  const body = await r.json().catch(() => ({}));
  const ok = r.ok;
  if (ok) {
    try {
      await EmailLog.create({
        to,
        subject,
        type: tag,
        provider: "postmark",
        providerId: body.MessageID,
        meta,
        sentAt: new Date()
      });
    } catch (e) {
      console.error("⚠️ EmailLog save error:", e?.message || e);
    }
  } else {
    console.error("❌ Postmark error:", body);
  }
  return { ok, status: r.status, body };
}

function buildEmailBody(postcode, radiusMiles, acceptingList) {
  const lines = [];
  lines.push(`Good news — NHS dentists within ${radiusMiles} miles of ${postcode} are accepting patients:\n`);
  for (const p of acceptingList) {
    lines.push(`• ${p.title || "Dental practice"}\n  ${p.url}`);
  }
  lines.push(`\nTip: Call ahead to confirm before travelling.\n`);
  lines.push(`Manage alerts: ${ORIGIN}/`);
  lines.push(`\n— Dentist Radar\n`);
  return lines.join("\n");
}

async function recentlyAlerted(email, postcode) {
  const since = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000);
  const found = await EmailLog.findOne({
    to: (email || "").toLowerCase(),
    "meta.postcode": postcode,
    type: "alert",
    sentAt: { $gte: since }
  }).lean();
  return !!found;
}

async function groupWatches() {
  const all = await Watch.find().lean();
  const byKey = new Map(); // key = `${postcode}::${radius}`
  for (const w of all) {
    const pc = normalizePostcode(w.postcode || "");
    if (!pc) continue;
    if (LIMIT_TO.length && !LIMIT_TO.includes(pc)) continue;
    const radius = Math.max(1, Math.min(100, parseInt(w.radius || 25, 10) || 25));
    const key = `${pc}::${radius}`;
    if (!byKey.has(key)) byKey.set(key, { postcode: pc, radiusMiles: radius, recipients: new Set() });
    byKey.get(key).recipients.add((w.email || "").trim().toLowerCase());
  }
  // Convert sets to arrays
  return Array.from(byKey.values()).map(g => ({ ...g, recipients: Array.from(g.recipients) }));
}

async function mapLimit(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++; if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- Main workflow ---
(async () => {
  const FIXED_URI = (function forceDentistRadarDb(uri = "") {
    if (!uri) return "";
    if (/\/dentistradar(\?|$)/i.test(uri)) return uri;
    if (/\/[^/?]+(\?|$)/.test(uri)) return uri.replace(/\/[^/?]+(\?|$)/, "/dentistradar$1");
    return uri.replace(/(\.net)(\/)?/, "$1/dentistradar");
  })(MONGO_URI);

  await connectMongo(FIXED_URI);
  console.log(`✅ MongoDB connected (${nowIso()})`);

  const groups = await groupWatches();
  if (!groups.length) {
    console.log("ℹ️  No watches found.");
    process.exit(0);
  }
  console.log(`🗂  Groups to scan: ${groups.length}`);

  let totalAccepting = 0, totalEmails = 0, totalScanned = 0;
  const started = Date.now();

  await mapLimit(groups, MAX_SCAN_CONCURRENCY, async (g) => {
    console.log(`\n🔎 Scan ${g.postcode} (${g.radiusMiles} miles) → recipients: ${g.recipients.length}`);
    const result = await runScan({ postcode: g.postcode, radius: g.radiusMiles, includeChildOnly: INCLUDE_CHILD_ONLY });

    const accList = result.accepting || [];
    const foundCount = accList.length + (INCLUDE_CHILD_ONLY ? (result.childOnly || []).length : 0);
    totalAccepting += accList.length;
    totalScanned   += (result.summary?.scanned || 0);

    if (!foundCount) {
      console.log(`  • No accepting practices this round (unknown: ${result.summary?.unknown ?? 0})`);
      return;
    }

    // Email every recipient, respecting cooldown
    const subject = `NHS dentist openings near ${g.postcode} (${foundCount})`;
    const text = buildEmailBody(g.postcode, g.radiusMiles, accList);

    for (const email of g.recipients) {
      const cooldown = await recentlyAlerted(email, g.postcode);
      if (cooldown) {
        console.log(`  ↷ Skip (cooldown) ${email}`);
        continue;
      }
      const meta = { postcode: g.postcode, radius: g.radiusMiles, accepting: accList.length, when: new Date() };
      const sendRes = await sendEmailPostmark(email, subject, text, "alert", meta);
      if (sendRes.ok || sendRes.dryRun) totalEmails++;
    }
  });

  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n✅ Done in ${secs}s — accepting found: ${totalAccepting}, Email attempts: ${totalEmails}, Total practices scanned: ${totalScanned}\n`);
  process.exit(0);
})().catch(e => {
  console.error("❌ Worker error:", e?.message || e);
  process.exit(1);
});
