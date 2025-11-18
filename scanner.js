// scanner.js – DentistRadar scanner v2.5 (grouped, with single-watch mode)

import "dotenv/config";
import nodemailer from "nodemailer";
import { connectMongo, Watch, EmailLog } from "./models.js";

// If you're on Node 18+, global fetch exists.
// If not, install node-fetch and uncomment:
// import fetch from "node-fetch";

// ---------- Basic helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNhsSearchUrl(postcode, radiusMiles) {
  const encodedPostcode = encodeURIComponent(postcode.trim());
  const radius = Number(radiusMiles) || 5;
  return `https://www.nhs.uk/service-search/find-a-dentist/results?postcode=${encodedPostcode}&distance=${radius}`;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (DentistRadar scanner)",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

// Very simple link extractor from NHS search results
function extractPracticeLinks(searchHtml) {
  const links = new Set();

  const regex = /href="(\/services\/dentist\/[^\"]+)"/gi;
  let match;
  while ((match = regex.exec(searchHtml)) !== null) {
    const path = match[1];
    // Filter obviously wrong links if needed:
    if (path.includes("/services/dentist/")) {
      links.add(`https://www.nhs.uk${path}`);
    }
  }

  return Array.from(links);
}

function textBetween(html, startMarker, endMarker) {
  const lowerHtml = html.toLowerCase();
  const start = lowerHtml.indexOf(startMarker.toLowerCase());
  if (start === -1) return "";
  const end = lowerHtml.indexOf(endMarker.toLowerCase(), start + startMarker.length);
  const slice = end === -1 ? html.slice(start) : html.slice(start, end);
  // Strip tags very roughly:
  return slice.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Very simple get-name/address/phone – tweak as needed
function extractPracticeName(detailHtml) {
  // NHS pages usually have <h1>Practice Name</h1>
  const match = detailHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return match ? match[1].trim() : "Unknown practice";
}

function extractAddress(detailHtml) {
  // Grab block around "Address"
  const block = textBetween(detailHtml, "Address", "Get directions");
  return block || "Address not available";
}

// Simple UK phone extractor
function extractPhone(detailHtml) {
  const text = detailHtml.replace(/<[^>]+>/g, " ");
  const phoneMatch = text.match(/0\d{2,4}\s?\d{3,4}\s?\d{3,4}/);
  return phoneMatch ? phoneMatch[0].trim() : "Not available";
}

// ---------- Acceptance classification ----------

function classifyAcceptance(appointmentHtml = "") {
  if (!appointmentHtml) return "unknown";

  const text = appointmentHtml.toLowerCase();

  const acceptingPatterns = [
    "accepts new nhs patients",
    "currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "taking on new nhs patients",
    "is taking new nhs patients",
    "accepting new nhs patients",
    "accepting new adult nhs patients",
    "accepting new child nhs patients",
    "this dentist currently accepts new nhs patients",
  ];

  const notAcceptingPatterns = [
    "not accepting new nhs patients",
    "not taking on new nhs patients",
    "currently not accepting nhs patients",
    "not currently accepting new nhs patients",
    "this dentist is not taking on any new nhs patients",
  ];

  if (acceptingPatterns.some((p) => text.includes(p))) return "accepting";
  if (notAcceptingPatterns.some((p) => text.includes(p))) return "notAccepting";
  return "unknown";
}

function extractAppointmentsSection(detailHtml) {
  // Grab everything around the "Appointments" heading
  return textBetween(detailHtml, "Appointments", "Back to top");
}

// ---------- Core pure scanner (no DB, no email) ----------

export async function scanPostcode(postcode, radiusMiles) {
  const started = Date.now();
  const searchUrl = buildNhsSearchUrl(postcode, radiusMiles);
  console.log(`[SCAN] Searching NHS for ${postcode} (${radiusMiles} miles) – ${searchUrl}`);

  const searchHtml = await fetchText(searchUrl);
  const practiceLinks = extractPracticeLinks(searchHtml);

  console.log(`[SCAN] Found ${practiceLinks.length} practice link(s) in search results.`);

  const accepting = [];
  const notAccepting = [];
  const unknown = [];

  for (const practiceUrl of practiceLinks) {
    try {
      await sleep(400); // be gentle with NHS
      const detailHtml = await fetchText(practiceUrl);

      const appointmentHtml = extractAppointmentsSection(detailHtml);
      const status = classifyAcceptance(appointmentHtml);

      const practice = {
        name: extractPracticeName(detailHtml),
        address: extractAddress(detailHtml),
        phone: extractPhone(detailHtml),
        nhsUrl: practiceUrl,
        status,
      };

      if (status === "accepting") accepting.push(practice);
      else if (status === "notAccepting") notAccepting.push(practice);
      else unknown.push(practice);
    } catch (err) {
      console.error(`[SCAN] Error fetching practice ${practiceUrl}:`, err.message);
    }
  }

  const tookMs = Date.now() - started;

  const result = {
    postcode,
    radiusMiles: Number(radiusMiles) || 5,
    acceptingCount: accepting.length,
    notAcceptingCount: notAccepting.length,
    unknownCount: unknown.length,
    scanned: practiceLinks.length,
    accepting,
    notAccepting,
    unknown,
    tookMs,
  };

  console.log("[SCAN] Result:", {
    postcode: result.postcode,
    radiusMiles: result.radiusMiles,
    accepting: result.acceptingCount,
    notAccepting: result.notAcceptingCount,
    unknown: result.unknownCount,
    scanned: result.scanned,
    tookMs: result.tookMs,
  });

  return result;
}

// ---------- Email transporter + acceptance email ----------

function createTransporter() {
  // Use your existing SMTP env config
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function buildAcceptanceEmail({ to, postcode, radiusMiles, practices }) {
  const subject = `DentistRadar: ${practices.length} NHS dentist(s) accepting near ${postcode}`;

  const plainPractices = practices
    .map(
      (p, idx) =>
        `${idx + 1}. ${p.name}
   Address: ${p.address}
   Phone: ${p.phone}
   NHS page: ${p.nhsUrl}`
    )
    .join("\n\n");

  const text = `
Good news – NHS dentists are accepting new patients near you.

You are receiving this alert from DentistRadar because you registered for updates for postcode ${postcode} within ${radiusMiles} miles.

Based on the latest information from the NHS website, the following practices are currently shown as accepting new NHS patients (subject to change and availability):

${plainPractices}

Tip: NHS availability can change quickly. If you find a suitable practice, it’s best to contact them as soon as possible to confirm they are still accepting new patients and to check appointment availability.

This email is based on publicly available information from the NHS website at the time of scanning. DentistRadar does not guarantee availability and cannot book appointments on your behalf.

Best regards,
The DentistRadar Team
${process.env.SITE_URL || ""}`.trim();

  // Very simple HTML – you can replace with your nicer template if you want
  const htmlRows = practices
    .map(
      (p) => `
      <tr>
        <td style="border-bottom:1px solid #f0f0f0;"><strong>${p.name}</strong></td>
        <td style="border-bottom:1px solid #f0f0f0;">${p.address}</td>
        <td style="border-bottom:1px solid #f0f0f0;">${p.phone}</td>
        <td style="border-bottom:1px solid #f0f0f0;"><a href="${p.nhsUrl}">View on NHS</a></td>
      </tr>`
    )
    .join("");

  const html = `
<!DOCTYPE html>
<html>
  <body style="font-family: Arial, sans-serif;">
    <h2>Good news – NHS dentists are accepting new patients near you</h2>
    <p>You are receiving this alert from <strong>DentistRadar</strong> because you registered for updates for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>.</p>
    <p>Based on the latest information from the NHS website, the following practices are currently shown as <strong>accepting new NHS patients</strong> (subject to change and availability):</p>
    <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse; font-size:14px;">
      <thead>
        <tr style="background:#f0f4ff;">
          <th align="left">Practice</th>
          <th align="left">Address</th>
          <th align="left">Phone</th>
          <th align="left">NHS link</th>
        </tr>
      </thead>
      <tbody>
        ${htmlRows}
      </tbody>
    </table>
    <p style="margin-top:16px;"><strong>Tip:</strong> NHS availability can change quickly. If you find a suitable practice, contact them as soon as possible to confirm they are still accepting new patients and to check appointment availability.</p>
    <p style="margin-top:16px; font-size:12px; color:#777;">
      This email is based on publicly available information from the NHS website at the time of scanning. DentistRadar does not guarantee availability and cannot book appointments on your behalf.
    </p>
    <p>Best regards,<br />The DentistRadar Team</p>
  </body>
</html>
`.trim();

  return { subject, text, html };
}

// ---------- Single-watch scan (for signup / manual use) ----------

export async function runSingleWatchScan(watch) {
  await connectMongo();

  const postcode = watch.postcode;
  const radiusMiles = watch.radiusMiles || watch.radius || 5;
  const email = watch.email;

  console.log(`[WATCH] Running single scan for ${email} – ${postcode} (${radiusMiles}mi)`);

  const scanResult = await scanPostcode(postcode, radiusMiles);

  if (scanResult.acceptingCount === 0) {
    console.log(`[WATCH] No accepting practices for ${postcode} (${radiusMiles}mi)`);
    return { scanResult, sent: false, newPractices: [] };
  }

  // Filter practices this user has NOT been emailed about
  const newPractices = [];
  for (const practice of scanResult.accepting) {
    const already = await EmailLog.findOne({
      email,
      postcode,
      radiusMiles,
      practiceUrl: practice.nhsUrl,
    });
    if (!already) {
      newPractices.push(practice);
    }
  }

  if (newPractices.length === 0) {
    console.log(`[WATCH] No NEW accepting practices for ${email} at ${postcode}`);
    return { scanResult, sent: false, newPractices: [] };
  }

  // Send email
  const transporter = createTransporter();
  const { subject, text, html } = buildAcceptanceEmail({
    to: email,
    postcode,
    radiusMiles,
    practices: newPractices,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject,
    text,
    html,
  });

  console.log(
    `[WATCH] Sent acceptance email to ${email} with ${newPractices.length} new practice(s).`
  );

  // Log in EmailLog
  const docs = newPractices.map((p) => ({
    email,
    postcode,
    radiusMiles,
    practiceUrl: p.nhsUrl,
    sentAt: new Date(),
    type: "accepting",
  }));
  await EmailLog.insertMany(docs);

  return { scanResult, sent: true, newPractices };
}

// ---------- Grouped scan (for cron – later) ----------

export async function runAllGroupedScans() {
  await connectMongo();

  const watches = await Watch.find({ unsubscribed: { $ne: true } });
  console.log(`[CRON] Loaded ${watches.length} active watches from DB`);

  // Group by postcode+radius
  const groups = {};
  for (const w of watches) {
    const radiusMiles = w.radiusMiles || w.radius || 5;
    const key = `${w.postcode}::${radiusMiles}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(w);
  }

  for (const [key, group] of Object.entries(groups)) {
    const [postcode, radiusStr] = key.split("::");
    const radiusMiles = Number(radiusStr) || 5;
    console.log(
      `[CRON] Group ${postcode} (${radiusMiles}mi) – ${group.length} watch(es)`
    );

    const scanResult = await scanPostcode(postcode, radiusMiles);

    if (scanResult.acceptingCount === 0) {
      console.log(`[CRON] No accepting practices for group ${key}`);
      continue;
    }

    for (const watch of group) {
      await runSingleWatchScan(watch); // reuses same logic
    }
  }

  console.log("[CRON] Grouped scan complete.");
}
