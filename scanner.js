// scanner.js
// DentistRadar scanner (v3.2 – grouped, appointments-first, updated NHS URL + link extraction)
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
//   - From that page, extract all /services/dentist/... links (relative OR absolute)
//   - For each, construct /appointments URL, e.g.:
//       https://www.nhs.uk/services/dentist/covent-garden-dental-clinic/XV003761/appointments
//   - Classify each appointments page as accepting / not accepting / child-only / unknown

import "dotenv/config";
import nodemailer from "nodemailer";
import * as cheerio from "cheerio";
import { connectMongo, Watch, EmailLog } from "./models.js";

// ---------------- Config ----------------

const NHS_BASE = "https://www.nhs.uk";

const SCAN_CONFIG = {
  maxPracticesPerSearch: 80, // safety cap per postcode/radius
  appointmentDelayMs: 800, // delay between appointments fetches (avoid 403)
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
  return (pc || "").toUpperCase().replace(/\s+/g, " ").trim();
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
  // Radius still used for grouping / your own semantics; NHS distance is handled their side.
  safeRadius(radiusMiles); // keep call for future extension
  return `${NHS_BASE}/service-search/find-a-dentist/results/${pc}`;
}

// ===== NEW: distance index from accessible text blocks =====
function buildDistanceIndexFromSearchHtml(searchHtml) {
  const distanceById = {};
  // Use the "Result for ... End of result for ..." accessible text blocks
  const regex =
    /Result for\s+(.+?)\r?\n([\s\S]*?)(?:End of result for\s+.+?\r?\n)/g;
  let match;
  while ((match = regex.exec(searchHtml)) !== null) {
    const block = match[2];
    const idMatch = block.match(/\bV[0-9A-Z]{6}\b/);
    if (!idMatch) continue;
    const practiceId = idMatch[0].toUpperCase();

    const distMatch = block.match(/([\d.]+)\s*miles?\s+away/i);
    if (!distMatch) continue;
    const milesNum = Number(distMatch[1]);
    const distanceText = `${distMatch[1]} miles away`;
    distanceById[practiceId] = { miles: milesNum, text: distanceText };
  }
  return distanceById;
}

// Extract NHS practice ID (Vxxxxxx) from a /services/dentist/... href
function extractPracticeIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/\/(V[0-9A-Z]{6})(?:_\d+)?(?:\/|$)/i);
  return m ? m[1].toUpperCase() : null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": SCAN_CONFIG.userAgent,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

// Extract all dentist detail URLs from the search results page
// FIX: handle both relative "/services/dentist/..." and absolute "https://www.nhs.uk/services/dentist/..."
function extractPracticeDetailUrls(searchHtml) {
  const $ = cheerio.load(searchHtml);
  const urls = new Set();

  $("a[href*='/services/dentist/']").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;

    href = href.trim();

    // strip query/fragment
    href = href.split("#")[0].split("?")[0];

    // At this point href can be:
    //   - "/services/dentist/.../XV001026"
    //   - "https://www.nhs.uk/services/dentist/.../XV001026"
    // Both are fine – toAppointmentsUrl can cope with either.
    urls.add(href);
  });

  return Array.from(urls);
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

  // NEW: build distance index keyed by practiceId (Vxxxxxx)
  const distanceIndex = buildDistanceIndexFromSearchHtml(searchHtml);

  const detailHrefs = extractPracticeDetailUrls(searchHtml).slice(
    0,
    SCAN_CONFIG.maxPracticesPerSearch
  );

  console.log(
    `📄 Found ${detailHrefs.length} potential practices in search results.`
  );

  const practices = [];
  let accepting = 0;
  let childOnly = 0;
  let notAccepting = 0;
  let unknown = 0;

  for (const href of detailHrefs) {
    const appointmentsUrl = toAppointmentsUrl(href);
    const practiceId = extractPracticeIdFromHref(href);

    console.log(`  → Fetching appointments: ${appointmentsUrl}`);

    const apptHtml = await fetchHtml(appointmentsUrl);
    await sleep(SCAN_CONFIG.appointmentDelayMs);

    if (!apptHtml) {
      unknown += 1;
      practices.push({
        appointmentsUrl,
        name: null,
        status: "unknown",
        practiceId,
      });
      continue;
    }

    const $ = cheerio.load(apptHtml);
    const name =
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

    // Extract phone if present
    let phone = null;
    const telHref = $("a[href^='tel:']").first().attr("href");
    if (telHref) {
      phone = telHref.replace(/^tel:/i, "").trim();
    }

    // Look up distance by practiceId (if we have one)
    let distanceText = null;
    if (practiceId && distanceIndex[practiceId]) {
      distanceText = distanceIndex[practiceId].text;
    }

    // Build a simple Google Maps search URL
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${name || "NHS Dentist"} ${normalisePostcode(postcode)}`
    )}`;

    practices.push({
      appointmentsUrl,
      name,
      status,
      practiceId,
      distanceText,
      phone,
      mapsUrl,
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

function buildAcceptanceEmail(watch, scanResult) {
  const acceptingPractices = scanResult.practices.filter(
    (p) => p.status === "accepting" || p.status === "childOnly"
  );

  const rowsHtml = acceptingPractices
    .map((p) => {
      const patientType =
        p.status === "childOnly" ? "Children only" : "Adults & Children";
      const distance = p.distanceText || "";
      const phone = p.phone || "";
      const profileLink = p.appointmentsUrl;
      const mapLink = p.mapsUrl || profileLink;

      return `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;">
            <strong>${p.name || "NHS Dentist"}</strong>
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
            <a href="${profileLink}" target="_blank" rel="noopener noreferrer">NHS Profile</a>
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            <a href="${mapLink}" target="_blank" rel="noopener noreferrer">View on map</a>
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
        for postcode <strong>${watch.postcode}</strong> within <strong>${scanResult.radiusMiles} miles</strong>.
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
        If you no longer wish to receive alerts for this postcode, you can unsubscribe from your dashboard.
      </p>
    </div>
  `;

  const listText = acceptingPractices
    .map((p) => {
      const patientType =
        p.status === "childOnly" ? "Children only" : "Adults & Children";
      const distance = p.distanceText ? ` (${p.distanceText})` : "";
      const phone = p.phone ? ` | Phone: ${p.phone}` : "";
      const profile = p.appointmentsUrl;
      const map = p.mapsUrl || profile;
      return `- ${p.name || "NHS Dentist"} [${patientType}]${distance}${phone}\n  NHS: ${profile}\n  Map: ${map}`;
    })
    .join("\n");

  const text =
    `Good news – we’ve found NHS dentists accepting new patients near ${watch.postcode} (within ${scanResult.radiusMiles} miles):\n\n` +
    (listText || "(No specific practice names could be extracted, please check NHS links.)") +
    `\n\nTip: NHS availability can change quickly. If you find a suitable practice, it’s best to contact them as soon as possible to confirm they are still accepting new patients.\n\n` +
    `This email is based on publicly available information from the NHS website at the time of scanning. DentistRadar does not guarantee availability and cannot book appointments on your behalf.\n\n` +
    `If you no longer wish to receive alerts for this postcode, you can unsubscribe from your dashboard.\n`;

  return {
    subject: `NHS dentist availability near ${watch.postcode}`,
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

    if (!lastLog)
      return {
        send: currentAcceptingUrls.length > 0,
        signature: currentSignature,
      };

    if (lastLog.signature === currentSignature) {
      console.log(
        `🔁 No change in accepting practices for watch ${watch._id} (${watch.email}) – skipping email.`
      );
      return { send: false, signature: currentSignature };
    }

    return {
      send: currentAcceptingUrls.length > 0,
      signature: currentSignature,
    };
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

    if (!groups.has(key))
      groups.set(key, { postcode: pc, radiusMiles: r, watches: [] });
    groups.get(key).watches.push(w);
  }

  console.log(
    `📦 Grouped into ${groups.size} distinct postcode+radius combinations.`
  );

  for (const [key, group] of groups.entries()) {
    console.log(
      `\n===== Group ${key} – ${group.watches.length} watch(es) =====`
    );

    const scanResult = await scanPostcodeRadius(
      group.postcode,
      group.radiusMiles
    );

    if (scanResult.accepting + scanResult.childOnly === 0) {
      console.log(
        "❌ No accepting practices found for this group – skipping emails."
      );
      continue;
    }

    for (const watch of group.watches) {
      const { send, signature } = await shouldSendAlertForWatch(
        watch,
        scanResult
      );
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
