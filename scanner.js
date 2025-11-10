// scanner.v9.js — Email-upgraded variant (keeps v9 scanning flow intact)
//
// Exports runScan as before.
// Only the email-building section is changed to use renderEmail("availability").
//
// ENV you already use:
//   MONGO_URI, EMAIL_FROM, POSTMARK_SERVER_TOKEN (or POSTMARK_TOKEN), POSTMARK_MESSAGE_STREAM
//
// NOTE: This file assumes the rest of your v9 discovery & classification logic
// builds arrays `acceptingDetails` and `childOnlyDetails` objects with fields you already had.
// If you only had URLs, pass them as `detailUrl` or `appointmentUrl` and the template will still render.

import mongoose from "mongoose";
import axios from "axios";
import dayjs from "dayjs";
import pLimit from "p-limit";
import { renderEmail } from "./emailTemplates.js";

// ========= keep your existing imports & helpers here (discovery, classify, models, etc.) =========
// e.g. import { discoverDetailUrls, fetchAppointments, EmailLog, Watch, validEmail, etc. }
// I’m showing only the pieces around email sending to avoid changing behaviour.

// ---- Postmark sender (HTML) ----
async function sendEmailHTML(toList, subject, html) {
  const token = process.env.POSTMARK_SERVER_TOKEN || process.env.POSTMARK_TOKEN || "";
  if (!toList?.length) { console.log("✋ Email skipped: recipients empty."); return { ok:false, reason:"no_recipients" }; }
  if (!token) { console.log("✋ Email skipped: POSTMARK token missing."); return { ok:false, reason:"no_token" }; }
  try {
    const r = await axios.post("https://api.postmarkapp.com/email",
      {
        From: process.env.MAIL_FROM || process.env.EMAIL_FROM || "alerts@dentistradar.co.uk",
        To: toList.join(","),
        Subject: subject,
        HtmlBody: html,
        MessageStream: process.env.POSTMARK_MESSAGE_STREAM || "outbound"
      },
      {
        headers: {
          "X-Postmark-Server-Token": token,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        timeout: 15000,
        validateStatus: () => true
      }
    );
    if (r.status >= 200 && r.status < 300) {
      console.log(`📧 Postmark OK: ${r.status} id=${r.data?.MessageID || "n/a"}`);
      return { ok: true, id: r.data?.MessageID };
    } else {
      console.log("❌ Postmark error:", r.status, r.data);
      return { ok: false, status: r.status, body: r.data };
    }
  } catch (e) {
    console.log("❌ Postmark exception:", e?.message);
    return { ok: false, error: e?.message };
  }
}

// ========= your v9 runScan / scanJob remain the same except the SEND block =========

// Example shape for the end of your scan job (keep everything above as-is):
export async function runScan(opts = {}) {
  // ... your existing connection, buildJobs, discovery and classification logic ...

  // Example loop skeleton — keep your own logic
  const jobs = await buildJobs(opts.postcode); // your existing helper
  const INCLUDE_CHILD = String(process.env.INCLUDE_CHILD_ONLY || "false").toLowerCase() === "true";
  const CONCURRENCY = Math.max(1, Number(process.env.MAX_CONCURRENCY || 6));
  const limit = pLimit(CONCURRENCY);

  const summaries = [];

  for (const job of jobs) {
    const { postcode, radiusMiles, recipients } = job;

    // ... your discovery of detail URLs and classification ...
    // Expect two arrays by here (whatever your v9 already creates):
    // acceptingDetails, childOnlyDetails
    const acceptingDetails = [];  // <- fill by your v9 logic
    const childOnlyDetails = [];  // <- fill by your v9 logic

    // =======================
    // ONLY THIS SEND BLOCK CHANGED
    // =======================
    const shouldSend =
      acceptingDetails.length > 0 || (INCLUDE_CHILD && childOnlyDetails.length > 0);

    if (!shouldSend) {
      console.log("No accepting/eligible results or INCLUDE_CHILD=false; skipping email.");
    } else if (!recipients?.length) {
      console.log("Recipients empty for this postcode; skipping email.");
    } else {
      // Merge for one curated email (accepting first)
      const practices = [...acceptingDetails, ...childOnlyDetails].map(p => ({
        // The template is lenient; pass what you have, it hides missing fields.
        name: p.name,
        address: p.address,
        appointmentUrl: p.appointmentUrl || p.apptUrl || p.detailUrl,
        detailUrl: p.detailUrl,
        phone: p.phone,
        distanceMiles: p.distanceMiles,
        lat: p.lat,
        lon: p.lon,
        checkedAt: new Date()
      }));

      const { subject, html } = renderEmail("availability", {
        postcode,
        radius: radiusMiles,
        practices,
        includeChildOnly: INCLUDE_CHILD
      });

      const resp = await sendEmailHTML(recipients, subject, html);
      console.log("sendEmail result:", resp);
    }

    summaries.push({
      postcode,
      radiusMiles,
      accepting: acceptingDetails.length,
      childOnly: childOnlyDetails.length
    });
  }

  console.log("[DONE]", summaries);
  return { jobs: jobs.length, summaries };
}

export default { runScan };

// If you also had the CLI entry, keep it:
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}

// ======= helpers you already had in v9 (stubs to show intent) =======
// Ensure your original implementations remain; these are placeholders so this file is standalone.
async function buildJobs(filterPostcode) {
  // Use your original aggregation on Watch.
  // Placeholder to avoid breaking shape:
  return [];
}
