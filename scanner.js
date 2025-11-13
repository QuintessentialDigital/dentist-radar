// scanner.js
// Scans active Watches, checks NHS for accepting dentists directly from
// the search results page, sends emails (if SMTP is configured),
// and logs per-USER alert deliveries in EmailLog.
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

// Very simple UK phone extractor from a text block
function extractPhone(block) {
  // Look for something that looks like a UK landline: 0XXXXXXXXXX with spaces
  const phoneMatch =
    block.match(/\b0\d{2,4}[\s-]?\d{3}[\s-]?\d{3,4}\b/) ||
    block.match(/\b0\d{9,10}\b/);
  return phoneMatch ? phoneMatch[0].trim() : null;
}

// Build a Google Maps search link
function buildMapsUrl(name, postcode) {
  const q = `${name || ""} ${postcode || ""}`.trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    q
  )}`;
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

// Extract practice data (name, id, acceptance, distance, phone, adult/child)
// from search HTML ONLY
function extractPracticesFromSearch(html, searchPostcode) {
  const results = [];

  // Each block looks like (in the accessible text version):
  //
  //   Result for   Winnersh Dental Practice
  //   V006578
  //   ...
  //   1.2 miles away
  //   ...
  //   When availability allows, this dentist accepts new NHS patients if they are:
  //     adults aged 18 or over
  //     children aged 17 or under
  //   ...
  //   End of result for   Winnersh Dental Practice
  //
  const regex =
    /Result for\s+(.+?)\r?\n([\s\S]*?)(?:End of result for\s+.+?\r?\n)/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const block = match[2];
    const lower = block.toLowerCase();

    // Practice ID: lines like "V003718"
    const idMatch = block.match(/\bV[0-9A-Z]{6}\b/);
    const practiceId = idMatch ? idMatch[0] : null;

    // Distance text: e.g. "1.2 miles away"
    let distanceText = null;
    let distanceMiles = null;
    const distMatch = block.match(/([\d.]+)\s*miles?\s+away/i);
    if (distMatch) {
      distanceText = `${distMatch[1]} miles away`;
      distanceMiles = Number(distMatch[1]);
    }

    // Phone number (best effort)
    const phone = extractPhone(block);

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

    // Adult / child tagging
    const acceptsAdults =
      lower.includes("adults aged 18 or over") ||
      lower.includes("adults aged 18 and over") ||
      lower.includes("adult patients");

    const acceptsChildren =
      lower.includes("children aged 17 or under") ||
      lower.includes("children aged under 18") ||
      lower.includes("child patients");

    let patientType = "Not specified";
    if (acceptsAdults && acceptsChildren) {
      patientType = "Adults & Children";
    } else if (acceptsAdults) {
      patientType = "Adults only";
    } else if (acceptsChildren) {
      patientType = "Children only";
    }

    const profileUrl = buildProfileUrl(name, practiceId);
    const mapsUrl = buildMapsUrl(name, searchPostcode);

    results.push({
      name,
      practiceId: practiceId || name,
      acceptance,
      profileUrl,
      mapsUrl,
      distanceText,
      distanceMiles,
      phone,
      acceptsAdults,
      acceptsChildren,
      patientType,
    });
  }

  return results;
}

// ---------------- Unsubscribe URL helper ----------------

function buildUnsubscribeUrl(alertId, email) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    "https://dentistradar.co.uk";

  // MVP: simple alert + email link; your server should implement /unsubscribe
  // to set Watch.active = false for this alertId & email.
  const params = new URLSearchParams({
    alert: String(alertId),
    email: email || "",
  });

  return `${base.replace(/\/$/, "")}/unsubscribe?${params.toString()}`;
}

// ---------------- Mailer ----------------

// NOTE: now *never throws* – returns null if SMTP not configured
function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn(
      "[DentistRadar] SMTP not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS). " +
        "Skipping email send but continuing scanner/logging."
    );
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

async function sendAcceptingEmail({
  alertId,
  to,
  postcode,
  radiusMiles,
  practices,
}) {
  if (!practices.length) return;

  const transport = createTransport();
  if (!transport) return;

  const from = process.env.FROM_EMAIL || "alerts@dentistradar.co.uk";
  const subject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

  const unsubscribeUrl = buildUnsubscribeUrl(alertId, to);

  // Professional tabular HTML email
  const rowsHtml = practices
    .map((p) => {
      const profileLink = p.profileUrl || p.appointmentUrl || "#";
      const mapsLink = p.mapsUrl || profileLink;
      const distance = p.distanceText || "";
      const phone = p.phone || "";
      const patientType = p.patientType || "Not specified";

      return `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;">
            <strong>${p.name || p.practiceId}</strong>
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${patientType}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${distance}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${phone}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            <a href="${profileLink}" target="_blank">NHS Profile</a>
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            <a href="${mapsLink}" target="_blank">View on map</a>
          </td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #333;">
      <h2 style="color:#0b5cff; margin-bottom: 16px;">Good news – NHS dentists are accepting new patients near you</h2>
      <p>
        You are receiving this alert from <strong>DentistRadar</strong> because you registered for updates
        for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>.
      </p>
      <p>
        Based on the latest information from the NHS website, the following practices are currently shown
        as accepting new NHS patients (subject to change and availability):
      </p>

      <table style="border-collapse:collapse;width:100%;margin-top:16px;font-size:14px;">
        <thead>
          <tr style="background:#f5f7fb;">
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:left;">Practice</th>
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">Patient type</th>
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">Distance</th>
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">Phone</th>
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">NHS Page</th>
            <th style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">Map</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <p style="margin-top:16px;">
        <strong>Tip:</strong> NHS availability can change quickly. If you find a suitable practice,
        it’s best to contact them as soon as possible to confirm they are still accepting new patients.
      </p>

      <p style="font-size:12px;color:#777;margin-top:24px;">
        This email is based on publicly available information from the NHS website at the time of scanning.
        DentistRadar does not guarantee availability and cannot book appointments on your behalf.
      </p>
      <p style="font-size:12px;color:#777;margin-top:8px;">
        If you no longer wish to receive alerts for this postcode, you can
        <a href="${unsubscribeUrl}" target="_blank">unsubscribe from this alert here</a>.
      </p>
      <p style="font-size:12px;color:#777;margin-top:4px;">
        If you did not register for this alert, please ignore this email or contact DentistRadar support.
      </p>
    </div>
  `;

  const text =
    `Good news – NHS dentists accepting new patients near ${postcode} (within ${radiusMiles} miles):\n\n` +
    practices
      .map((p) => {
        const distance = p.distanceText ? ` (${p.distanceText})` : "";
        const phone = p.phone ? ` | Phone: ${p.phone}` : "";
        const profile =
          p.profileUrl || p.appointmentUrl || "(see NHS website for details)";
        const maps = p.mapsUrl || profile;
        const patientType = p.patientType || "Not specified";
        return `- ${p.name || p.practiceId} [${patientType}]${distance}${phone}\n  NHS: ${profile}\n  Map: ${maps}\n`;
      })
      .join("\n") +
    `\n\nTo unsubscribe from this alert, visit: ${unsubscribeUrl}\n`;

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

  const practices = extractPracticesFromSearch(searchHtml, postcode);

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

  // Send & log — logging happens even if email fails / is skipped
  if (newAccepting.length) {
    try {
      await sendAcceptingEmail({
        alertId,
        to: email,
        postcode,
        radiusMiles,
        practices: newAccepting,
      });
    } catch (err) {
      console.error("Email send error (non-fatal):", err.message);
    }

    try {
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
      console.error("Log write error (non-fatal):", err.message);
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
