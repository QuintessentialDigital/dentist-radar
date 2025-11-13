// scanner.js
// Scans active Watches, checks NHS for accepting dentists,
// sends emails, and logs per-USER alert deliveries in EmailLog
//
// Run either as:
//   node scanner.js
// or import { runScan } from "./scanner.js" in server.js

import "dotenv/config";
import nodemailer from "nodemailer";
import { connectMongo, Watch, EmailLog } from "./models.js";

// If you're on Node 18+, global fetch exists.
// If not, install node-fetch and uncomment this:
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

// Extract practice URLs from NHS search results
function extractPracticesFromSearch(html) {
  const results = [];
  const regex = /href="([^"]+\/services\/dentist\/[^"]+)"/g;

  const seen = new Set();
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];

    if (seen.has(href)) continue;
    seen.add(href);

    const url = href.startsWith("http")
      ? href
      : `https://www.nhs.uk${href}`;

    const parts = url.split("/");
    const practiceId = parts[parts.length - 1] || parts[parts.length - 2];

    results.push({
      detailUrl: url,
      practiceId,
    });
  }

  return results;
}

// Parse appointments page for accepting patterns
function parseAcceptanceFromAppointments(html) {
  const lower = html.toLowerCase();

  const positivePatterns = [
    "this dentist currently accepts new nhs patients",
    "this dentist currently accepts new nhs adult patients",
    "this dentist currently accepts new nhs child patients",
    "accepting new nhs patients",
    "is accepting new nhs patients",
  ];

  const negativePatterns = [
    "this dentist is not accepting new nhs patients",
    "this dentist currently does not accept new nhs patients",
    "not accepting new nhs patients",
    "is not accepting new nhs patients",
  ];

  const positiveHit = positivePatterns.some((p) => lower.includes(p));
  const negativeHit = negativePatterns.some((p) => lower.includes(p));

  if (positiveHit && !negativeHit) return "accepting";
  if (negativeHit && !positiveHit) return "not_accepting";

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
      <h2 style="color:#0b5cff; margin-bottom: 16px;">Good news! NHS dentists are accepting new patients</h2>
      <p>Based on your alert for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>, we found the following practices currently accepting NHS patients:</p>
      <ul>${listHtml}</ul>
      <p style="margin-top:16px;">Appointments availability can change quickly, so we recommend booking as soon as possible.</p>
      <p style="font-size:12px;color:#777;margin-top:24px;">
        You received this email because you created an alert on DentistRadar.
        If this wasn’t you or you want to stop receiving alerts, please contact support.
      </p>
    </div>
  `;

  const text =
    `Good news! NHS dentists accepting patients near ${postcode}:\n\n` +
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
  const { _id: alertId, email, postcode } = watch;

  // 👇 Key: support both radiusMiles and radius, with a sensible default
  const radiusMiles = watch.radiusMiles ?? watch.radius ?? 25;

  const searchUrl = buildSearchUrl(postcode, radiusMiles);
  const t0 = Date.now();

  let searchHtml;
  try {
    searchHtml = await fetchHtml(searchUrl);
  } catch (err) {
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
    } catch {
      continue;
    }

    const status = parseAcceptanceFromAppointments(appointmentsHtml);

    if (status === "accepting") {
      totalAccepting++;

      // ✔ Per-user de-duplication
      const alreadySent = await EmailLog.findOne({
        alertId,
