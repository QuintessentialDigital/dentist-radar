// scanner.js
// Scans active Watches, checks NHS for accepting dentists directly from
// the search results page, sends emails, and logs per-USER alert deliveries
// in EmailLog.
//
// Usage:
//   - Run manually: node scanner.js
//   - From server.js: import { runScan } from "./scanner.js";

import "dotenv/config";
import nodemailer from "nodemailer";
import { connectMongo, Watch, EmailLog } from "./models.js";

// If you're on Node 18+, global fetch exists.
// If not, install node-fetch and uncomment this:
// import fetch from "node-fetch";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- Small helpers ----------------

function slugifyName(name) {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------- NHS helpers ----------------

// NHS search results URL
function buildSearchUrl(postcode, radiusMiles) {
  const encPostcode = encodeURIComponent(postcode.trim());
  // radiusMiles is kept for reporting, not sent to NHS
  return `https://www.nhs.uk/service-search/find-a-dentist/results/${encPostcode}`;
}

// Build an NHS profile URL from name + ID
function buildProfileUrl(name, practiceId) {
  const slug = slugifyName(name || "");
  if (!slug || !practiceId) return null;
  return `https://www.nhs.uk/services/dentist/${slug}/${practiceId}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; DentistRadarBot/1.0; +https://dentistradar.co.uk)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  return await res.text();
}

// Extract practice data (name, id, acceptance) from search HTML ONLY
function extractPracticesFromSearch(html) {
  const results = [];

  // Each block looks like:
  //   N.   Result for   <Name>
  //   V012345
  //   DEN
  //   ...
  //   When availability allows, this dentist accepts new NHS patients ...
  //   End of result for   <Name>
  //
  // We'll capture "Result for <Name> ... End of result for"
  const regex =
    /Result for\s+(.+?)\r?\n([\s\S]*?)(?:End of result for\s+.+?\r?\n)/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const block = match[2];

    // Practice ID: lines like "V003718"
    const idMatch = block.match(/\bV[0-9A-Z]{6}\b/);
    const practiceId = idMatch ? idMatch[0] : null;

    const lower = block.toLowerCase();

    // Determine acceptance from the text in THIS block
    const positivePatterns = [
      "when availability allows, this dentist accepts new nhs patients if they are:",
      "this dentist currently accepts new nhs patients for routine dental care",
      "this dentist currently accepts new nhs patients",
      "accepting new nhs patients",
      "is accepting new nhs patients",
    ];

    const negativePatterns = [
      "not accepting new nhs patients",
      "this dentist does not currently accept new nhs patients for routine dental care",
      "this dentist currently does not accept new nhs patients",
    ];

    const unknownPatterns = [
      "this dentist surgery has not given a recent update on whether they're taking new nhs patients",
      "this dentist has not confirmed if they currently accept new nhs patients for routine dental care",
    ];

    const pos = positivePatterns.some((p) => lower.includes(p));
    const neg = negativePatterns.some((p) => lower.includes(p));
    const unk = unknownPatterns.some((p) => lower.includes(p));

    let acceptance = "unknown";
    if (pos && !neg) acceptance = "accepting";
    else if (neg && !pos) acceptance = "not_accepting";
    else if (unk && !pos && !neg) acceptance = "unknown";

    const profileUrl = buildProfileUrl(name, practiceId);

    results.push({
      name,
      practiceId: practiceId || name,
      acceptance,
      profileUrl,
    });
  }

  return results;
}

// ---------------- Mailer ----------------

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

  const from = process.env.FROM_EMAIL || "alerts@dentistradar.co.uk";
  const subject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

  const listHtml = practices
    .map((p) => {
      const link = p.profileUrl || "NHS profile page";
      return `<li><strong>${p.name || p.practiceId}</strong><br/><a href="${link}" target="_blank">${link}</a></li>`;
    })
    .join("");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #333;">
      <h2 style="color:#0b5cff; margin-bottom: 16px;">Good news! NHS dentists are accepting new patients</h2>
      <p>Based on your alert for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>, we found the following practices currently accepting new NHS patients:</p>
      <ul>${listHtml}</ul>
      <p style="margin-top:16px;">Appointments availability can change quickly, so we recommend contacting these practices as soon as possible.</p>
      <p style="font-size:12px;color:#777;margin-top:24px;">
        You received this email because you created an alert on DentistRadar.
        If this wasn’t you or you want to stop receiving alerts, please contact support.
      </p>
    </div>
  `;

  const text =
    `Good news! NHS dentists accepting patients near ${postcode}:\n\n` +
    practices
      .map((p) => {
        const link = p.profileUrl || "(NHS profile page)";
        return `- ${p.name || p.practiceId}\n  NHS profile: ${link}\n`;
      })
      .join("\n");

  await transport.sendMail({
    from,
    to,
    subject,
    html,
    text,
  });
}

// ---------------- Core per-Watch scan ----------------

async function scanWatch(watch) {
  const { _id: alertId, email, postcode } = watch;

  // Support both radiusMiles and radius, with a default
  const radiusMiles = watch.radiusMiles ?? watch.radius ?? 25;

  const searchUrl = buildSearchUrl(postcode, radiusMiles);
  const t0 = Date.now();

  let searchHtml;
  try {
    searchHtml = await fetchHtml(searchUrl);
  } catch (err) {
    console.error("Search fetch failed:", err.message);
    return {
      alertId,
      email,
      postcode,
      radiusMiles,
      scanned: 0,
      totalAccepting: 0,
      totalNotAccepting: 0,
      newAccepting: 0,
      error: `Search fetch failed: ${err.message}`,
      tookMs: Date.now() - t0,
    };
  }

  const practices = extractPracticesFromSearch(searchHtml);

  let scanned = 0;
  let totalAccepting = 0;
  let totalNotAccepting = 0;
  const newAccepting = [];

  for (const practice of practices) {
    scanned++;

    if (practice.acceptance === "accepting") {
      totalAccepting++;

      const appointmentUrl = practice.profileUrl || null;

      // Per-alert (per-user) de-duplication
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
    } else if (practice.acceptance === "not_accepting") {
      totalNotAccepting++;
    }

    // be nice to NHS
    await sleep(200);
  }

  // Send & log
  if (newAccepting.length) {
    try {
      await sendAcceptingEmail({
        to: email,
        postcode,
        radiusMiles,
        practices: newAccepting,
      });

      const bulk = EmailLog.collection.initializeUnorderedBulkOp();

      newAccepting.forEach((p) => {
        bulk
          .find({
            alertId,
            practiceId: p.practiceId,
            appointmentUrl: p.appointmentUrl,
          })
          .upsert()
          .updateOne({
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
      console.error("Email/log error:", err.message);
    }
  }

  return {
    alertId,
    email,
    postcode,
    radiusMiles,
    scanned,
    totalAccepting,
    totalNotAccepting,
    newAccepting: newAccepting.length,
    tookMs: Date.now() - t0,
  };
}

// ---------------- Orchestrators ----------------

export async function runAllScans() {
  await connectMongo();

  const activeWatches = await Watch.find({ active: true }).lean();

  console.log(
    `Starting scan for ${activeWatches.length} active alert(s) at ${new Date().toISOString()}`
  );

  const results = [];

  for (const watch of activeWatches) {
    const result = await scanWatch(watch);
    results.push(result);

    await Watch.updateOne(
      { _id: watch._id },
      { $set: { lastRunAt: new Date() } }
    );
  }

  return results;
}

// Alias expected by server.js
export async function runScan() {
  return runAllScans();
}

// Allow running directly: node scanner.js
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
