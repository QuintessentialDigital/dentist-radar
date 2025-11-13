// scanner.js
// Scans active Watches, checks NHS for accepting dentists,
// sends emails, and logs per-USER alert deliveries in EmailLog
//
// Run either as:
//   node scanner.js
// or import { runAllScans } in your server/cron code.

import "dotenv/config";
import nodemailer from "nodemailer";
import { connectMongo, Watch, EmailLog } from "./models.js";

// If you're on Node 18+, global fetch exists.
// If not, install node-fetch and uncomment:
// import fetch from "node-fetch";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------- NHS helpers -----------

function buildSearchUrl(postcode, radiusMiles) {
  const base = "https://www.nhs.uk/service-search/find-a-dentist/results";
  const params = new URLSearchParams({
    postcode,
    distance: String(radiusMiles),
  });
  return `${base}?${params.toString()}`;
}

function buildAppointmentsUrl(detailUrl) {
  // Standard NHS pattern:
  //  https://www.nhs.uk/services/dentist/<name>/<id>
  //  appointments page:
  //  https://www.nhs.uk/services/dentist/<name>/<id>/appointments-and-opening-times
  if (!detailUrl) return null;
  let url = detailUrl.split("?")[0];
  if (url.endsWith("/")) url = url.slice(0, -1);
  return `${url}/appointments-and-opening-times`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; DentistRadarBot/1.0; +https://dentistradar.com)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

/**
 * Very lightweight parser to pull practice detail URLs from the search HTML.
 * We avoid extra dependencies: do simple regex on <a href="..."> inside result cards.
 */
function extractPracticesFromSearch(html) {
  const results = [];

  // This is crude but works: we look for NHS service links that contain "/services/dentist/"
  const regex = /href="([^"]+\/services\/dentist\/[^"]+)"/g;
  let match;
  const seen = new Set();

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    if (seen.has(href)) continue;
    seen.add(href);

    // NHS hrefs may be relative; normalise:
    const url = href.startsWith("http")
      ? href
      : `https://www.nhs.uk${href}`;

    // Simple practiceId: last segment
    const parts = url.split("/");
    const practiceId = parts[parts.length - 1] || parts[parts.length - 2];

    results.push({
      detailUrl: url,
      practiceId,
    });
  }

  return results;
}

/**
 * Determine whether appointments page indicates accepting / not accepting.
 * We just look at the plain text with a handful of known patterns.
 */
function parseAcceptanceFromAppointments(html) {
  const lower = html.toLowerCase();

  // Strong positive signals
  const positivePatterns = [
    "this dentist currently accepts new nhs patients",
    "this dentist currently accepts new nhs adult patients",
    "this dentist currently accepts new nhs child patients",
    "accepting new nhs patients",
    "is accepting new nhs patients",
  ];

  // Strong negative signals
  const negativePatterns = [
    "this dentist is not accepting new nhs patients",
    "this dentist currently does not accept new nhs patients",
    "not accepting new nhs patients",
    "is not accepting new nhs patients",
  ];

  const positiveHit = positivePatterns.some((p) => lower.includes(p));
  const negativeHit = negativePatterns.some((p) => lower.includes(p));

  if (positiveHit && !negativeHit) {
    return "accepting";
  }
  if (negativeHit && !positiveHit) {
    return "not_accepting";
  }

  // Unknown / mixed / not sure -> treat as not-accepting for alerts
  return "unknown";
}

// ----------- Mailer -----------

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error("SMTP_HOST, SMTP_USER, SMTP_PASS are required");
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendAcceptingEmail({ to, postcode, radiusMiles, practices }) {
  if (!practices.length) return;

  const transport = createTransport();

  const from = process.env.FROM_EMAIL || "alerts@dentistradar.com";
  const subject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

  const listHtml = practices
    .map(
      (p) =>
        `<li><strong>${p.name || p.practiceId}</strong><br/><a href="${p.appointmentUrl}" target="_blank">${p.appointmentUrl}</a></li>`
    )
    .join("");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #333;">
      <h2 style="color:#0b5cff; margin-bottom: 16px;">Good news! We found NHS dentists accepting patients</h2>
      <p>Based on your alert for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>, we found the following practices currently accepting NHS patients:</p>
      <ul>${listHtml}</ul>
      <p style="margin-top:16px;">Appointments availability can change quickly, so we recommend booking as soon as possible.</p>
      <p style="font-size:12px;color:#777;margin-top:24px;">
        You are receiving this email because you created an alert on DentistRadar.
        If this wasn’t you or you no longer wish to receive alerts, please contact support.
      </p>
    </div>
  ";

  const text =
    `Good news! We found NHS dentists accepting patients near ${postcode}.\n\n` +
    practices
      .map(
        (p) =>
          `- ${p.name || p.practiceId}\n  Appointments: ${p.appointmentUrl}\n`
      )
      .join("\n");

  await transport.sendMail({
    from,
    to,
    subject,
    html,
    text,
  });
}

// ----------- Core per-Watch scan -----------

async function scanWatch(watch) {
  const { _id: alertId, email, postcode, radiusMiles } = watch;

  const searchUrl = buildSearchUrl(postcode, radiusMiles);
  const t0 = Date.now();

  let searchHtml;
  try {
    searchHtml = await fetchHtml(searchUrl);
  } catch (err) {
    console.error("Search fetch failed", { postcode, radiusMiles, err: err.message });
    return {
      alertId,
      email,
      postcode,
      radiusMiles,
      error: `Search fetch failed: ${err.message}`,
    };
  }

  const practices = extractPracticesFromSearch(searchHtml);

  let scanned = 0;
  let totalAccepting = 0;
  let totalNotAccepting = 0;

  const newAccepting = [];

  for (const practice of practices) {
    scanned++;

    const appointmentUrl = buildAppointmentsUrl(practice.detailUrl);
    if (!appointmentUrl) continue;

    let appointmentsHtml;
    try {
      appointmentsHtml = await fetchHtml(appointmentUrl);
    } catch (err) {
      console.warn("Appointments fetch failed", {
        appointmentUrl,
        err: err.message,
      });
      continue;
    }

    const status = parseAcceptanceFromAppointments(appointmentsHtml);

    if (status === "accepting") {
      totalAccepting++;

      // ✅ KEY FIX:
      // De-dup per ALERT (watch) + practice, not globally.
      const alreadySent = await EmailLog.findOne({
        alertId,
        practiceId: practice.practiceId,
        appointmentUrl,
      }).lean();

      if (!alreadySent) {
        newAccepting.push({
          ...practice,
          appointmentUrl,
        });
      }
    } else if (status === "not_accepting") {
      totalNotAccepting++;
    }

    // Be kind to NHS servers
    await sleep(400);
  }

  // If we have new accepting practices, send email + log them
  if (newAccepting.length) {
    try {
      await sendAcceptingEmail({
        to: email,
        postcode,
        radiusMiles,
        practices: newAccepting,
      });

      // Insert logs; ignore duplicates just in case of race conditions
      const bulk = EmailLog.collection.initializeUnorderedBulkOp();
      newAccepting.forEach((p) => {
        bulk.find({
          alertId,
          practiceId: p.practiceId,
          appointmentUrl: p.appointmentUrl,
        }).upsert().updateOne({
          $setOnInsert: {
            alertId,
            email,
            postcode,
            radiusMiles,
            practiceId: p.practiceId,
            appointmentUrl: p.appointmentUrl,
            sentAt: new Date(),
          },
        });
      });
      await bulk.execute();
    } catch (err) {
      console.error("Failed to send or log accepting email", {
        alertId,
        email,
        err: err.message,
      });
    }
  }

  const tookMs = Date.now() - t0;

  return {
    alertId,
    email,
    postcode,
    radiusMiles,
    scanned,
    totalAccepting,
    totalNotAccepting,
    newAccepting: newAccepting.length,
    tookMs,
  };
}

// ----------- Orchestrator -----------

export async function runAllScans() {
  await connectMongo();

  const activeWatches = await Watch.find({ active: true }).lean();

  console.log(
    `Starting scan for ${activeWatches.length} active alert(s) at ${new Date().toISOString()}`
  );

  const results = [];

  for (const watch of activeWatches) {
    console.log(
      `Scanning alert ${watch._id} for ${watch.email} – ${watch.postcode} / ${watch.radiusMiles} miles`
    );

    const result = await scanWatch(watch);
    results.push(result);

    // Update lastRunAt
    await Watch.updateOne(
      { _id: watch._id },
      { $set: { lastRunAt: new Date() } }
    );

    console.log(
      `Result for ${watch.postcode}: totalAccepting=${result.totalAccepting}, newAccepting=${result.newAccepting}, scanned=${result.scanned}, tookMs=${result.tookMs}`
    );
  }

  return results;
}

// Allow running directly: `node scanner.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllScans()
    .then((res) => {
      console.log("Scan complete");
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Scan error", err);
      process.exit(1);
    });
}
