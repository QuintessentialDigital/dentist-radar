// scanner.js
// DentistRadar scanner (v3.5 – grouped, appointments-first, enriched metadata)
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
//   - For metadata (name, distance, phone, maps):
//        • Parse legacy "Result for ... / End of result for ..." blocks (v1 behaviour)
//   - For each practice, construct /appointments URL and classify:
//        • accepting / notAccepting / childOnly / unknown
//   - Emails:
//        • Acceptance logic from appointments pages only
//        • Name / distance / phone from search metadata where possible
//        • Fallback name/phone from appointments page if needed

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
  fromEmail: process.env.FROM_EMAIL || "alerts@dentistradar.co.uk",
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

// NHS expects the location (postcode or town) in the path segment.
// Example: https://www.nhs.uk/service-search/find-a-dentist/results/TW1%203SD
function buildSearchUrl(postcode, radiusMiles) {
  const pc = encodeURIComponent(normalisePostcode(postcode));
  safeRadius(radiusMiles); // radius is still your own semantics
  return `${NHS_BASE}/service-search/find-a-dentist/results/${pc}`;
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

function buildMapsUrl(name, postcode) {
  const q = `${name || ""} ${postcode || ""}`.trim();
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    q
  )}`;
}

// UK phone extractor: prefers local numbers, ignores "111"
function extractUkPhone(text) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, " ");
  const match =
    cleaned.match(/\b0\d{2,4}[-\s]?\d{3}[-\s]?\d{3,4}\b/) ||
    cleaned.match(/\b0\d{9,10}\b/);
  if (!match) return null;
  const phone = match[0].trim();
  if (phone === "111") return null;
  return phone;
}

// Extract an NHS V-ID from href (handles XV001234 and XV001234_1)
function extractPracticeIdFromHref(href) {
  if (!href) return null;
  const clean = href.split("#")[0].split("?")[0];
  const match = clean.match(/\/(V[0-9A-Z]{6})(?:_\d+)?\/?$/i);
  return match ? match[1] : null;
}

// ---------------- NHS parsing: search metadata (v1-style) ----------------

// This reuses your original, working logic: "Result for ... / End of result for ..."
function extractPracticesFromSearch(searchHtml, searchPostcode) {
  const results = [];
  if (!searchHtml) return results;

  const regex =
    /Result for\s+(.+?)\r?\n([\s\S]*?)(?:End of result for\s+.+?\r?\n)/g;

  let match;
  while ((match = regex.exec(searchHtml)) !== null) {
    const name = match[1].trim();
    const block = match[2];
    const lower = block.toLowerCase();

    // Practice ID: lines like "V006578"
    const idMatch = block.match(/\bV[0-9A-Z]{6}\b/);
    const practiceId = idMatch ? idMatch[0] : null;

    // Distance text: e.g. "1.5 miles away"
    let distanceText = null;
    let distanceMiles = null;
    const distMatch = block.match(/([\d.]+)\s*miles?\s+away/i);
    if (distMatch) {
      distanceText = `${distMatch[1]} miles away`;
      distanceMiles = Number(distMatch[1]);
    }

    // Phone number from block
    const phone = extractUkPhone(block);

    // Acceptance-related text (we still extract, but we use appointments for truth)
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

    // Adult / child tagging for metadata
    const adultPatterns = [
      "adults aged 18 or over",
      "adults aged 18 and over",
      "adults aged 18+",
      "adult nhs patients",
      "adult patients",
      "adult dental patients",
      "nhs adult patients",
      "adults",
    ];

    const childPatterns = [
      "children aged 17 or under",
      "children aged under 18",
      "child nhs patients",
      "child patients",
      "nhs child patients",
      "nhs children",
      "children for routine dental care",
      "children for routine care",
      "under 18s",
      "under 18 years",
      "aged under 18",
      "children",
    ];

    const acceptsAdults = adultPatterns.some((p) => lower.includes(p));
    const acceptsChildren = childPatterns.some((p) => lower.includes(p));

    let patientType = "Not specified";
    if (acceptsAdults && acceptsChildren) patientType = "Adults & Children";
    else if (acceptsAdults) patientType = "Adults only";
    else if (acceptsChildren) patientType = "Children only";

    results.push({
      name,
      practiceId: practiceId || name,
      distanceText,
      distanceMiles,
      phone,
      acceptsAdults,
      acceptsChildren,
      patientType,
      // we’ll build maps/profile URLs later
    });
  }

  return results;
}

// ---------------- NHS parsing: detail URLs & appointments ----------------

// Extract all dentist detail URLs from the search results page
// (handles both /services/dentist/... and full https://www.nhs.uk/services/dentist/...)
function extractPracticeDetailUrls(searchHtml) {
  const $ = cheerio.load(searchHtml || "");
  const urls = new Set();

  $("a[href*='/services/dentist/']").each((_, el) => {
    let href = $(el).attr("href");
    if (!href) return;

    href = href.trim();

    // strip query/fragment
    href = href.split("#")[0].split("?")[0];

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
  const $ = cheerio.load(html || "");
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

// ---------------- Unsubscribe URL helper ----------------

function buildUnsubscribeUrl(alertId, email) {
  const base =
    process.env.PUBLIC_BASE_URL ||
    process.env.APP_BASE_URL ||
    "https://www.dentistradar.co.uk";

  const params = new URLSearchParams({
    alert: String(alertId),
    email: email || "",
  });

  return `${base.replace(/\/$/, "")}/unsubscribe?${params.toString()}`;
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
  const { email, postcode, radiusMiles, _id: alertId } = watch;
  const acceptingPractices = scanResult.practices.filter(
    (p) => p.status === "accepting" || p.status === "childOnly"
  );
  const count = acceptingPractices.length;

  const unsubscribeUrl = buildUnsubscribeUrl(alertId, email);

  const subject = `DentistRadar: ${count} NHS dentist(s) accepting near ${postcode}`;

  const headerText = `Good news – NHS dentists are accepting new patients near you`;

  const plainRows = acceptingPractices
    .map((p) => {
      const pt = p.patientType || "Not specified";
      const dist = p.distanceText || "";
      const phone = p.phone || "";
      const nhs = p.profileUrl || p.appointmentsUrl || "";
      const map = p.mapsUrl || nhs;
      return `  ${p.name || "NHS Dentist"}\t${pt}\t${dist}\t${phone}\t${nhs}\t${map}`;
    })
    .join("\n");

  const text =
    `${headerText}\n` +
    `You are receiving this alert from DentistRadar because you registered for updates for postcode ${postcode} within ${radiusMiles} miles.\n\n` +
    `Based on the latest information from the NHS website, the following practices are currently shown as accepting new NHS patients (subject to change and availability):\n\n` +
    `Practice\tPatient type\tDistance\tPhone\tNHS Page\tMap\n` +
    `${plainRows}\n\n` +
    `Tip: NHS availability can change quickly. If you find a suitable practice, it’s best to contact them as soon as possible to confirm they are still accepting new patients.\n\n` +
    `This email is based on publicly available information from the NHS website at the time of scanning. DentistRadar does not guarantee availability and cannot book appointments on your behalf.\n\n` +
    `If you no longer wish to receive alerts for this postcode, you can unsubscribe from this alert here:\n${unsubscribeUrl}\n\n` +
    `If you did not register for this alert, please ignore this email or contact DentistRadar support.\n`;

  const htmlRows = acceptingPractices
    .map((p) => {
      const pt = p.patientType || "Not specified";
      const dist = p.distanceText || "";
      const phone = p.phone || "";
      const nhs = p.profileUrl || p.appointmentsUrl || "#";
      const map = p.mapsUrl || nhs;
      return `
        <tr>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;">
            <strong>${p.name || "NHS Dentist"}</strong>
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${pt}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${dist}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            ${phone || ""}
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            <a href="${nhs}" target="_blank" rel="noopener noreferrer">NHS Profile</a>
          </td>
          <td style="padding:8px 12px;border:1px solid #e0e0e0;text-align:center;">
            <a href="${map}" target="_blank" rel="noopener noreferrer">View on map</a>
          </td>
        </tr>
      `;
    })
    .join("");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #333;">
      <h2 style="color:#0b5cff; margin-bottom: 8px;">${headerText}</h2>
      <p>
        You are receiving this alert from <strong>DentistRadar</strong> because you registered for updates
        for postcode <strong>${postcode}</strong> within <strong>${radiusMiles} miles</strong>.
      </p>

      <p>
        Based on the latest information from the NHS website, the following practices are currently shown
        as accepting new NHS patients (subject to change and availability):
      </p>

      <table style="border-collapse:collapse;width:100%;margin-top:12px;font-size:14px;">
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
          ${htmlRows}
        </tbody>
      </table>

      <p style="margin-top:16px;">
        <strong>Tip:</strong> NHS availability can change quickly. If you find a suitable practice,
        it’s best to contact them as soon as possible to confirm they are still accepting new patients.
      </p>

      <p style="font-size:12px;color:#777;margin-top:16px;">
        This email is based on publicly available information from the NHS website at the time of scanning.
        DentistRadar does not guarantee availability and cannot book appointments on your behalf.
      </p>

      <p style="font-size:12px;color:#777;margin-top:8px;">
        If you no longer wish to receive alerts for this postcode, you can
        <a href="${unsubscribeUrl}" target="_blank" rel="noopener noreferrer">unsubscribe from this alert here</a>.
      </p>

      <p style="font-size:12px;color:#777;margin-top:4px;">
        If you did not register for this alert, please ignore this email or contact DentistRadar support.
      </p>
    </div>
  `;

  return { subject, text, html };
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

// Signature-based dedupe (by set of accepting appointments URLs)
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

    if (!lastLog) {
      return { send: currentAcceptingUrls.length > 0, signature: currentSignature };
    }

    if (lastLog.signature === currentSignature) {
      console.log(
        `🔁 No change in accepting practices for watch ${watch._id} (${watch.email}) – skipping email.`
      );
      return { send: false, signature: currentSignature };
    }

    return { send: currentAcceptingUrls.length > 0, signature: currentSignature };
  } catch (err) {
    console.error("Error checking EmailLog, defaulting to send:", err);
    return { send: true, signature: null };
  }
}

// IMPORTANT: write via raw collection so watchId + signature are stored
async function logEmailSent(watch, scanResult, signature) {
  try {
    await EmailLog.collection.insertOne({
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

// ---------------- Core postcode+radius scan ----------------

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

  // v1-style metadata
  const metaFromSearch = extractPracticesFromSearch(searchHtml, postcode);
  const metaById = new Map();
  for (const m of metaFromSearch) {
    if (m.practiceId) {
      metaById.set(m.practiceId, m);
    }
  }

  const detailHrefs = extractPracticeDetailUrls(searchHtml).slice(
    0,
    SCAN_CONFIG.maxPracticesPerSearch
  );

  console.log(
    `📄 Found ${detailHrefs.length} potential practices in search results (metadata hits=${metaFromSearch.length}).`
  );

  const practices = [];
  let accepting = 0;
  let childOnly = 0;
  let notAccepting = 0;
  let unknown = 0;

  for (const href of detailHrefs) {
    const appointmentsUrl = toAppointmentsUrl(href);
    const practiceId = extractPracticeIdFromHref(href);
    const meta = practiceId ? metaById.get(practiceId) : null;

    console.log(
      `  → Fetching appointments: ${appointmentsUrl} (id=${practiceId || "?"})`
    );

    const apptHtml = await fetchHtml(appointmentsUrl);
    await sleep(SCAN_CONFIG.appointmentDelayMs);

    if (!apptHtml) {
      unknown += 1;
      practices.push({
        appointmentsUrl,
        name: meta?.name || null,
        status: "unknown",
        patientType: meta?.patientType || "Not specified",
        distanceText: meta?.distanceText || null,
        phone: meta?.phone || null,
        profileUrl: appointmentsUrl.replace(/\/appointments\/?$/, ""),
        mapsUrl: buildMapsUrl(meta?.name, postcode),
      });
      continue;
    }

    const $ = cheerio.load(apptHtml);

    // Name: prefer metadata, else H1 (excluding plain "Appointments"), else title
    let name = meta?.name || null;
    if (!name) {
      const h1 = $("h1").first().text().trim();
      if (h1 && h1.toLowerCase() !== "appointments") {
        name = h1;
      } else {
        const title = $("title").first().text().trim();
        name = title.replace(/\s*-\s*NHS\s*$/i, "").trim() || "NHS Dentist";
      }
    }

    // Phone: prefer metadata phone, else tel: link, else regex from body text
    let phone = meta?.phone || null;
    if (!phone) {
      const telHref = $("a[href^='tel:']").first().attr("href");
      if (telHref) {
        const candidate = telHref.replace(/^tel:/i, "").trim();
        if (candidate && candidate !== "111") {
          phone = candidate;
        }
      }
    }
    if (!phone) {
      const bodyText = $("body").text();
      phone = extractUkPhone(bodyText);
    }

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

    let patientType = meta?.patientType || "Not specified";
    if (!meta?.patientType) {
      if (status === "childOnly") {
        patientType = "Children only";
      } else if (status === "accepting") {
        patientType = "Adults & Children";
      }
    }

    const distanceText = meta?.distanceText || null;
    const profileUrl = appointmentsUrl.replace(/\/appointments\/?$/, "");
    const mapsUrl = buildMapsUrl(name, postcode);

    practices.push({
      appointmentsUrl,
      name,
      status,
      patientType,
      distanceText,
      phone,
      profileUrl,
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
    const r = safeRadius(w.radiusMiles ?? w.radius ?? 10);
    const key = `${pc}::${r}`;

    if (!groups.has(key)) groups.set(key, { postcode: pc, radiusMiles: r, watches: [] });
    groups.get(key).watches.push(w);
  }

  console.log(`📦 Grouped into ${groups.size} distinct postcode+radius combinations.`);

  for (const [key, group] of groups.entries()) {
    console.log(
      `\n===== Group ${key} – ${group.watches.length} watch(es) =====`
    );

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

// Alias for server.js that imports { runScan }
export async function runScan() {
  return runAllScans();
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
