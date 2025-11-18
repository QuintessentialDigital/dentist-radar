// scanner.js
// DentistRadar scanner (v3.3 – grouped, appointments-first, with distance + phone)
//
// Modes:
//   1) DB mode (cron or /api/scan with no postcode):
//        - Reads active watches from Mongo (excluding unsubscribed)
//        - Groups by (postcode, radiusMiles)
//        - Scans each unique NHS search ONCE
//        - Sends acceptance emails via SMTP (if configured)
//        - Logs per-watch deliveries in EmailLog
//
//   2) Direct mode (for debugging):
//        - node scanner.js RG41 4UW 25
//
// NHS flow:
//   - Build search URL: /service-search/find-a-dentist/results/<POSTCODE>
//   - From that page, extract dentist entries:
//       - detail URL
//       - (list) name
//       - distance text (e.g. "0.6 miles")
//       - phone number
//   - For each, construct /appointments URL, e.g.:
//       https://www.nhs.uk/services/dentist/covent-garden-dental-clinic/XV003761/appointments
//   - Classify each appointments page as accepting / not accepting / child-only / unknown
//   - Email users for groups where at least one practice is accepting / child-only

import "dotenv/config";
import nodemailer from "nodemailer";
import * as cheerio from "cheerio";
import { connectMongo, Watch, EmailLog } from "./models.js";

// ---------------- Config ----------------

const NHS_BASE = "https://www.nhs.uk";

const SCAN_CONFIG = {
  maxPracticesPerSearch: 80,    // safety cap per postcode/radius
  appointmentDelayMs: 800,      // delay between appointments fetches (avoid 403)
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const SMTP_CONFIG = {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
  secure: process.env.SMTP_SECURE === "true",
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  fromEmail: process.env.FROM_EMAIL || "alerts@dentistradar.com",
};

// ---------------- Small helpers ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalisePostcode(pc) {
  return (pc || "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function safeRadius(radiusMiles) {
  const n = Number(radiusMiles);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(n, 100);
}

// NHS now expects the location (postcode or town) in the path segment.
// Example: https://www.nhs.uk/service-search/find-a-dentist/results/TW1%203SD
function buildSearchUrl(postcode, radiusMiles) {
  const pc = encodeURIComponent(normalisePostcode(postcode));
  // Radius not in URL, but we keep it for summary/grouping semantics.
  safeRadius(radiusMiles); // keep call for future use / clarity
  return `${NHS_BASE}/service-search/find-a-dentist/results/${pc}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": SCAN_CONFIG.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
  });

  if (!res.ok) {
    console.warn(`⚠️  fetchHtml: Non-200 for ${url}: ${res.status}`);
    return null;
  }

  return await res.text();
}

// ---------------- NHS parsing ----------------

/**
 * Extract practice entries (detail URL + distance + phone + nameFromList)
 * from the NHS search results page.
 *
 * We:
 *   - find all <a href> that contain "/services/dentist/"
 *   - for each, look at the closest "block" element (li/article/div)
 *   - from that block's text, regex out:
 *       - "This organisation is X miles away"
 *       - "Phone: Phone number for this organisation is <number>"
 */
function extractPracticeEntries(searchHtml) {
  const $ = cheerio.load(searchHtml);
  const entries = [];

  $("a[href*='/services/dentist/']").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;

    href = href.trim();
    // strip query/fragment
    href = href.split("#")[0].split("?")[0];

    // Find a reasonable container for the "result block"
    let container = $(el).closest("li");
    if (!container.length) {
      container = $(el).closest("article");
    }
    if (!container.length) {
      container = $(el).parent();
    }

    const blockText = container.text().replace(/\s+/g, " ");

    // Distance: "This organisation is 0.6 miles away"
    const distanceMatch = blockText.match(
      /This organisation is\s+([0-9.,]+)\s+miles away/i
    );
    const distanceText = distanceMatch ? `${distanceMatch[1]} miles` : null;

    // Phone: "Phone: Phone number for this organisation is 01908 505984"
    const phoneMatch = blockText.match(
      /Phone:\s*Phone number for this organisation is\s+([0-9()+\/\s-]+)/i
    );
    const phone = phoneMatch ? phoneMatch[1].trim() : null;

    // Link text usually says "navigates to more detail for X", but we still grab it
    const rawLinkText = $(el).text().trim() || null;

    entries.push({
      href,
      nameFromList: rawLinkText,
      distanceText,
      phone,
    });
  });

  // De-duplicate by href – keep the first instance
  const byHref = new Map();
  for (const e of entries) {
    if (!byHref.has(e.href)) {
      byHref.set(e.href, e);
    }
  }
  return Array.from(byHref.values());
}

// Given a detail URL, build the corresponding appointments URL
function toAppointmentsUrl(detailHrefOrUrl) {
  // Examples input:
  //   /services/dentist/covent-garden-dental-clinic/XV003761
  //   /services/dentist/covent-garden-dental-clinic/XV003761/appointments
  //   https://www.nhs.uk/services/dentist/.../appointments
  let full = detailHrefOrUrl.startsWith("http")
    ? detailHrefOrUrl
    : `${NHS_BASE}${detailHrefOrUrl}`;

  // strip query/fragment
  full = full.split("#")[0].split("?")[0];

  if (!full.toLowerCase().includes("/appointments")) {
    full = full.replace(/\/+$/, ""); // remove trailing slash
    full = `${full}/appointments`;
  }

  return full;
}

// Classify an appointments page as accepting / not / child-only / unknown
function classifyAppointmentsPage(html) {
  const $ = cheerio.load(html);
  const bodyText = $("body").text().toLowerCase().replace(/\s+/g, " ");

  const acceptingPatterns = [
    "this dentist currently accepts new nhs patients",
    "currently accepting new nhs patients",
    "is accepting new nhs patients",
    "are accepting new nhs patients",
    "accepting new nhs adult patients",
    "accepting new nhs child patients",
    "this dentist is accepting nhs patients",
  ];

  const notAcceptingPatterns = [
    "is not accepting new nhs patients",
    "isn't accepting new nhs patients",
    "not currently accepting new nhs patients",
    "this dentist is not accepting new nhs patients",
    "this dentist is not currently accepting nhs patients",
    "no nhs appointments are available",
    "no nhs appointments available",
    "does not provide nhs dental services",
    "this service is not currently accepting nhs patients",
  ];

  const childOnlyPatterns = [
    "only accepts nhs patients under",
    "only accepting new nhs child patients",
    "only accepting nhs patients under",
  ];

  const hit = (patterns) => patterns.some((p) => bodyText.includes(p));

  if (hit(childOnlyPatterns) && hit(acceptingPatterns)) {
    return "childOnly";
  }
  if (hit(childOnlyPatterns)) {
    return "childOnly";
  }
  if (hit(acceptingPatterns) && !hit(notAcceptingPatterns)) {
    return "accepting";
  }
  if (hit(notAcceptingPatterns) && !hit(acceptingPatterns)) {
    return "notAccepting";
  }

  return "unknown";
}

// Scan a single postcode + radius against NHS, from the appointments pages
export async function scanPostcodeRadius(postcode, radiusMiles) {
  const start = Date.now();
  const searchUrl = buildSearchUrl(postcode, radiusMiles);

  console.log(
    `🔍 Scanning NHS for postcode="${normalisePostcode(
      postcode
    )}", radius=${safeRadius(radiusMiles)} – ${searchUrl}`
  );

  const searchHtml = await fetchHtml(searchUrl);
  if (!searchHtml) {
    console.log(
      `⚠️  No search HTML returned for postcode="${normalisePostcode(
        postcode
      )}". Treating as 0 practices.`
    );
    return {
      postcode: normalisePostcode(postcode),
      radiusMiles: safeRadius(radiusMiles),
      accepting: 0,
      childOnly: 0,
      notAccepting: 0,
      unknown: 0,
      scanned: 0,
      tookMs: Date.now() - start,
      practices: [],
    };
  }

  const practiceEntries = extractPracticeEntries(searchHtml).slice(
    0,
    SCAN_CONFIG.maxPracticesPerSearch
  );

  console.log(`📄 Found ${practiceEntries.length} potential practices in search results.`);

  const practices = [];
  let accepting = 0;
  let childOnly = 0;
  let notAccepting = 0;
  let unknown = 0;

  for (const entry of practiceEntries) {
    const { href, nameFromList, distanceText, phone } = entry;
    const appointmentsUrl = toAppointmentsUrl(href);
    console.log(`  → Fetching appointments: ${appointmentsUrl}`);

    const apptHtml = await fetchHtml(appointmentsUrl);
    await sleep(SCAN_CONFIG.appointmentDelayMs);

    if (!apptHtml) {
      unknown += 1;
      practices.push({
        appointmentsUrl,
        name: nameFromList || null,
        distanceText: distanceText || null,
        phone: phone || null,
        status: "unknown",
      });
      continue;
    }

    const $ = cheerio.load(apptHtml);
    const nameFromAppt =
      $("h1").first().text().trim() ||
      $("title").first().text().trim() ||
      null;

    const status = classifyAppointmentsPage(apptHtml);

    switch (status) {
      case "accepting":
        accepting += 1;
        break;
      case "childOnly":
        childOnly += 1;
        break;
      case "notAccepting":
        notAccepting += 1;
        break;
      default:
        unknown += 1;
    }

    practices.push({
      appointmentsUrl,
      name: nameFromAppt || nameFromList || null,
      distanceText: distanceText || null,
      phone: phone || null,
      status,
    });
  }

  const scanned = practices.length;
  const tookMs = Date.now() - start;

  const summary = {
    postcode: normalisePostcode(postcode),
    radiusMiles: safeRadius(radiusMiles),
    accepting,
    childOnly,
    notAccepting,
    unknown,
    scanned,
    tookMs,
    practices,
  };

  console.log(
    `✅ Scan complete for ${summary.postcode} (${summary.radiusMiles} miles): ` +
      `accepting=${accepting}, childOnly=${childOnly}, notAccepting=${notAccepting}, unknown=${unknown}, scanned=${scanned}, tookMs=${tookMs}`
  );

  return summary;
}

// ---------------- Email + logging ----------------

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!SMTP_CONFIG.host || !SMTP_CONFIG.user || !SMTP_CONFIG.pass) {
    console.warn("⚠️  SMTP not fully configured – emails will be skipped.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.secure,
    auth: {
      user: SMTP_CONFIG.user,
      pass: SMTP_CONFIG.pass,
    },
  });

  return transporter;
}

function buildAcceptanceEmail({ email, postcode, radiusMiles }, scanResult) {
  const acceptingPractices = scanResult.practices.filter(
    (p) => p.status === "accepting" || p.status === "childOnly"
  );

  const acceptingList = acceptingPractices
    .map((p) => {
      const bits = [];
      bits.push(p.name || "NHS Dentist");
      if (p.distanceText) bits.push(`~${p.distanceText} from you`);
      if (p.phone) bits.push(`Tel: ${p.phone}`);
      const lineMain = "• " + bits.join(" – ");
      const lineUrl = `   ${p.appointmentsUrl}`;
      return `${lineMain}\n${lineUrl}`;
    })
    .join("\n\n");

  const hasChildOnly = scanResult.childOnly > 0;

  const textLines = [
    `Good news – we’ve found NHS dentists accepting new patients near ${postcode}.`,
    "",
    `Search radius (you selected): ~${scanResult.radiusMiles} miles`,
    "",
    "The following practices are currently showing as accepting NHS patients:",
    "",
    acceptingList || "(No specific practice details could be extracted, please check the NHS links.)",
    "",
    hasChildOnly
      ? "Note: Some practices may be accepting only child NHS patients. Please check the NHS page for details."
      : "",
    "",
    "Availability can change quickly. If you’re interested, we recommend contacting these practices as soon as possible.",
    "",
    "You are receiving this alert because you registered on DentistRadar.",
    "If you no longer wish to receive alerts, you can unsubscribe from your dashboard.",
  ];

  const text = textLines.filter(Boolean).join("\n");

  const htmlList = acceptingPractices
    .map((p) => {
      const name = p.name || "NHS Dentist";
      const distanceHtml = p.distanceText
        ? ` <span style="color:#555;">(~${p.distanceText} from you)</span>`
        : "";
      const phoneHtml = p.phone
        ? `<br/><span style="color:#555;">Tel: ${p.phone}</span>`
        : "";
      return `
        <li style="margin-bottom:8px;">
          <strong>${name}</strong>${distanceHtml}${phoneHtml}<br/>
          <a href="${p.appointmentsUrl}" target="_blank" rel="noopener noreferrer">${p.appointmentsUrl}</a>
        </li>
      `;
    })
    .join("");

  const html = `
    <p>Good news &ndash; we’ve found NHS dentists accepting new patients near <strong>${postcode}</strong>.</p>
    <p><strong>Your search radius:</strong> ~${scanResult.radiusMiles} miles</p>
    <p>The following practices are currently showing as accepting NHS patients:</p>
    <ul>
      ${htmlList || "<li>No practice details could be extracted, please check the NHS links.</li>"}
    </ul>
    ${
      hasChildOnly
        ? "<p><em>Note: Some practices may only be accepting child NHS patients. Please check each NHS page for full details.</em></p>"
        : ""
    }
    <p>Availability can change quickly. If you’re interested, we recommend contacting these practices as soon as possible.</p>
    <hr/>
    <p>You are receiving this alert because you registered on <strong>DentistRadar</strong>.</p>
    <p>If you no longer wish to receive alerts, you can unsubscribe from your dashboard.</p>
  `;

  return {
    subject: `NHS dentist availability near ${postcode}`,
    text,
    html,
  };
}

async function sendAcceptanceEmail(watch, scanResult) {
  const tx = getTransporter();
  if (!tx) {
    console.log(`📭 (Email skipped – SMTP not configured) to=${watch.email}`);
    return;
  }

  const { subject, text, html } = buildAcceptanceEmail(watch, scanResult);

  const info = await tx.sendMail({
    from: SMTP_CONFIG.fromEmail,
    to: watch.email,
    subject,
    text,
    html,
  });

  console.log(`📧 Alert email sent to ${watch.email}: ${info.messageId}`);
}

// Avoid sending duplicate alerts if nothing changed for this watch
async function shouldSendAlertForWatch(watch, scanResult) {
  try {
    const lastLog = await EmailLog.findOne({ watchId: watch._id })
      .sort({ sentAt: -1 })
      .lean();

    const currentAcceptingUrls = scanResult.practices
      .filter((p) => p.status === "accepting" || p.status === "childOnly")
      .map((p) => p.appointmentsUrl)
      .sort();

    const currentSignature = currentAcceptingUrls.join("|");

    if (!lastLog) return { send: currentAcceptingUrls.length > 0, signature: currentSignature };

    if (lastLog.signature === currentSignature) {
      console.log(
        `🔁 No change in accepting practices for watch ${watch._id} (${watch.email}) – skipping email.`
      );
      return { send: false, signature: currentSignature };
    }

    return { send: currentAcceptingUrls.length > 0, signature: currentSignature };
  } catch (err) {
    console.error("Error checking EmailLog, defaulting to send:", err);
    // If in doubt, send (but you could choose false if you prefer)
    return { send: true, signature: null };
  }
}

async function logEmailSent(watch, scanResult, signature) {
  try {
    await EmailLog.create({
      watchId: watch._id,
      email: watch.email,
      postcode: watch.postcode,
      radiusMiles: watch.radiusMiles,
      acceptingCount: scanResult.accepting + scanResult.childOnly,
      signature: signature || null,
      sentAt: new Date(),
    });
  } catch (err) {
    console.error("Error logging EmailLog:", err);
  }
}

// ---------------- DB-mode: runAllScans ----------------

export async function runAllScans() {
  console.log("🚀 Starting DB-mode scan (runAllScans)");

  await connectMongo();

  const watches = await Watch.find({
    unsubscribed: { $ne: true },
  }).lean();

  if (!watches.length) {
    console.log("ℹ️  No active watches found. Exiting.");
    return;
  }

  console.log(`👀 Loaded ${watches.length} active watches from Mongo.`);

  // Group watches by (postcode, radiusMiles)
  const groups = new Map();
  for (const w of watches) {
    const pc = normalisePostcode(w.postcode);
    const r = safeRadius(w.radiusMiles);
    const key = `${pc}::${r}`;

    if (!groups.has(key)) groups.set(key, { postcode: pc, radiusMiles: r, watches: [] });
    groups.get(key).watches.push(w);
  }

  console.log(`📦 Grouped into ${groups.size} distinct postcode+radius combinations.`);

  for (const [key, group] of groups.entries()) {
    console.log(`\n===== Group ${key} – ${group.watches.length} watch(es) =====`);

    const scanResult = await scanPostcodeRadius(group.postcode, group.radiusMiles);

    if (scanResult.accepting + scanResult.childOnly === 0) {
      console.log("❌ No accepting practices found for this group – skipping emails.");
      continue;
    }

    for (const watch of group.watches) {
      const { send, signature } = await shouldSendAlertForWatch(watch, scanResult);
      if (!send) continue;

      try {
        await sendAcceptanceEmail(watch, scanResult);
        await logEmailSent(watch, scanResult, signature);
      } catch (err) {
        console.error(
          `Error sending/logging email for watch ${watch._id} (${watch.email}):`,
          err
        );
      }
    }
  }

  console.log("\n🏁 DB-mode scan complete.");
}

// ---------------- CLI entrypoint (for debugging) ----------------

if (process.argv[1] && process.argv[1].endsWith("scanner.js")) {
  // Example:
  //   node scanner.js                  -> runAllScans (DB mode)
  //   node scanner.js RG41 4UW 25     -> single postcode+radius scan only
  (async () => {
    const [, , argPostcode, argRadius] = process.argv;

    if (argPostcode) {
      const postcode = argPostcode;
      const radiusMiles = argRadius ? Number(argRadius) : 10;
      const result = await scanPostcodeRadius(postcode, radiusMiles);
      console.log("Result:", JSON.stringify(result, null, 2));
    } else {
      await runAllScans();
    }

    process.exit(0);
  })().catch((err) => {
    console.error("Unhandled error in scanner.js:", err);
    process.exit(1);
  });
}
