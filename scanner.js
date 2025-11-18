// DentistRadar scanner (v3.1 – distance + phone + resilient URL + per-group error handling)
//
// Modes:
//   1) TEST mode (CLI):
//        node scanner.js --test "PR25 1QX" 25
//        -> Scans NHS, prints JSON + sample email HTML, DOES NOT send any emails
//
//   2) DB mode (cron / server):
//        import { runAllScans } from "./scanner.js";
//        -> Reads active Watches from Mongo, groups by (postcode, radiusMiles),
//           scans NHS once per group, sends alert emails, logs EmailLog.
//
//   3) Single group mode (if you wire it from /api/scan):
//        import { runSingleScan } from "./scanner.js";
//        await runSingleScan("PR25 1QX", 25, { dryRun: true });
//
// Notes:
//   - Uses appointments page ONLY for acceptance logic
//   - Distance comes from NHS search results page
//   - Phone comes from NHS profile page
//   - radiusMiles is always set so email never shows "undefined miles"

import "dotenv/config";
import nodemailer from "nodemailer";
import { connectMongo, Watch, EmailLog } from "./models.js";

// If you're on Node < 18, uncomment this and add dependency:
// import fetch from "node-fetch";

const NHS_BASE = "https://www.nhs.uk";

// ---------------- Small helpers ----------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (!block) return "";
  const text = block.replace(/\s+/g, " ");
  // Look for tel: links first
  const telMatch = text.match(/tel:([0-9+\s()\-]{8,})/i);
  if (telMatch) {
    return telMatch[1].trim();
  }
  // Fallback: UK-ish number patterns
  const phoneMatch = text.match(/(0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4})/);
  if (phoneMatch) {
    return phoneMatch[1].trim();
  }
  return "";
}

function normalisePostcode(pc) {
  return (pc || "").toUpperCase().trim();
}

function getRadiusFromWatch(w) {
  // Support both radius and radiusMiles fields; default 25
  return Number(w.radiusMiles ?? w.radius ?? 25);
}

// ---------------- Nodemailer transport ----------------

let transport = null;

function getTransport() {
  if (transport) return transport;

  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || "587"),
    secure: false,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : undefined,
  });

  return transport;
}

// ---------------- NHS HTTP helpers ----------------

async function fetchHtml(url, label = "fetchHtml") {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "DentistRadar Scanner / Node",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    console.error(`❌ [${label}] HTTP ${res.status} for ${url}`);
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }

  return await res.text();
}

// ✅ FIXED: NHS currently uses path-based URL, not ?postcode=
function buildNhsSearchUrl(postcode, radiusMiles) {
  const trimmed = (postcode || "").trim();
  const encodedPostcode = encodeURIComponent(trimmed); // "RG41 4UW" -> "RG41%204UW"

  let url = `${NHS_BASE}/service-search/find-a-dentist/results/${encodedPostcode}`;
  if (radiusMiles) {
    url += `?distance=${encodeURIComponent(String(radiusMiles))}`;
  }
  return url;
}

// Try to get a practice profile URL from the search result HTML chunk
function extractProfileUrl(chunk) {
  const m = chunk.match(/href="(\/services\/dentist\/[^"]+)"/i);
  if (!m) return "";
  return NHS_BASE + m[1];
}

// Try to get an appointments URL (if present) from a search result chunk.
// Fallback: derive from profile URL.
function extractAppointmentsUrl(chunk, profileUrl) {
  // 1) If there is an explicit appointments link in this HTML chunk, use it
  const m = chunk.match(/href="(\/services\/dentist\/appointments\/[^"]+)"/i);
  if (m) return NHS_BASE + m[1];

  if (!profileUrl) return "";

  // 2) If the profileUrl is already an appointments URL, just return it
  if (profileUrl.includes("/services/dentist/appointments/")) {
    return profileUrl;
  }

  // 3) If it's a normal dentist profile, derive the appointments URL from it
  if (profileUrl.includes("/services/dentist/")) {
    return profileUrl.replace(
      "/services/dentist/",
      "/services/dentist/appointments/"
    );
  }

  // 4) Last resort: fall back to profile URL
  return profileUrl;
}

// Parse the NHS search results page to extract practices + distance + URLs
function parseSearchResults(html) {
  const results = [];

  // Super-generic: look at ALL links, then filter down to dentist-related ones
  const re = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;

  while ((match = re.exec(html)) !== null) {
    const hrefRaw = match[1];
    const textRaw = match[2].trim();
    if (!textRaw) continue;

    const text = textRaw.replace(/\s+/g, " ");

    // Keep only links that look like actual dental practices
    // (very loose on purpose so we don't miss anything)
    const looksLikePracticeName =
      /appointments/i.test(text) ||
      /dental|dentist/i.test(text);

    const looksLikeDentistUrl =
      /dentist/i.test(hrefRaw) || /find-a-dentist/i.test(hrefRaw);

    if (!looksLikePracticeName || !looksLikeDentistUrl) continue;

    // Normalise URL: relative -> absolute
    const profileUrl = hrefRaw.startsWith("http")
      ? hrefRaw
      : NHS_BASE + hrefRaw;

    // Look around the link for something like "2.3 miles"
    const windowText = html.slice(match.index, match.index + 400);
    const distMatch =
      windowText.match(/([\d.,]+)\s*miles?/i) ||
      windowText.match(/([\d.,]+)\s*mi\b/i);
    const distanceText = distMatch ? distMatch[0].trim() : "";

    const appointmentsUrl = extractAppointmentsUrl(windowText, profileUrl);
    const mapUrl = profileUrl;

    results.push({
      name: text,
      distanceText,
      profileUrl,
      appointmentsUrl,
      mapUrl,
    });
  }

  console.log(
    `🔎 parseSearchResults: extracted ${results.length} practices from HTML`
  );
  return results;
}

// Fetch phone from practice profile page
async function fetchPhoneFromProfile(profileUrl) {
  if (!profileUrl) return "";
  try {
    const html = await fetchHtml(profileUrl, "profile");
    const phone = extractPhone(html);
    return phone;
  } catch (err) {
    console.error(
      "❌ Error fetching phone from profile",
      profileUrl,
      err.message
    );
    return "";
  }
}

// Acceptance classifier based on appointments page text
function classifyAcceptance(text) {
  const lower = text.toLowerCase();

  let accepting = false;
  let childOnly = false;
  let notAccepting = false;

  if (
    /currently accepts? new nhs patients/i.test(text) ||
    /accepting new nhs patients/i.test(text)
  ) {
    accepting = true;
  }

  if (
    /only accepting.*children/i.test(text) ||
    /accepts? new nhs patients.*children/i.test(text) ||
    /new nhs child patients only/i.test(text)
  ) {
    childOnly = true;
  }

  if (
    /not accepting new nhs patients/i.test(text) ||
    /no (longer )?accepting new nhs/i.test(text) ||
    /has no availability for routine nhs dental appointments/i.test(text)
  ) {
    notAccepting = true;
  }

  if (childOnly) {
    accepting = false;
  }

  return { accepting, childOnly, notAccepting };
}

// Scan a single practice (appointments + profile) to see if it's accepting
async function scanPractice(practice) {
  const { name, distanceText, profileUrl, appointmentsUrl, mapUrl } = practice;

  // 1) Fetch appointments page for acceptance logic
  let acceptance = { accepting: false, childOnly: false, notAccepting: false };
  if (appointmentsUrl) {
    try {
      const html = await fetchHtml(appointmentsUrl, "appointments");
      const text = html.replace(/\s+/g, " ");
      acceptance = classifyAcceptance(text);
    } catch (err) {
      console.error(
        "❌ Error fetching appointments page",
        appointmentsUrl,
        err.message
      );
    }
  }

  // 2) Fetch phone from profile page
  const phone = await fetchPhoneFromProfile(profileUrl);

  return {
    name,
    distanceText,
    profileUrl,
    appointmentsUrl,
    mapUrl,
    phone,
    ...acceptance,
  };
}

// ---------------- Email rendering ----------------

function renderAcceptingEmailHtml({ postcode, radiusMiles, practices }) {
  const safeRadius = radiusMiles ?? "your chosen";

  const rowsHtml =
    practices
      .map((p) => {
        const distanceCell = p.distanceText || "";
        const phoneCell = p.phone || "";
        const nhsLink = p.profileUrl || "#";
        const mapLink = p.mapUrl || nhsLink;

        return `
      <tr>
        <td style="padding:6px 8px;border:1px solid #ddd;">${p.name}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;">Adults &amp; Children</td>
        <td style="padding:6px 8px;border:1px solid #ddd;">${distanceCell}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;">${phoneCell}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;"><a href="${nhsLink}">NHS Profile</a></td>
        <td style="padding:6px 8px;border:1px solid #ddd;"><a href="${mapLink}">View on map</a></td>
      </tr>
    `;
      })
      .join("") || `
      <tr>
        <td colspan="6" style="padding:6px 8px;border:1px solid #ddd;">No practices are currently shown as accepting new NHS patients.</td>
      </tr>
    `;

  return `
  <div style="font-family:system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size:14px; color:#222;">
    <p><strong>Good news – NHS dentists are accepting new patients near you</strong></p>

    <p>You are receiving this alert from <strong>DentistRadar</strong> because you registered for updates for postcode <strong>${postcode}</strong> within <strong>${safeRadius} miles</strong>.</p>

    <p>Based on the latest information from the NHS website, the following practices are currently shown as accepting new NHS patients (subject to change and availability):</p>

    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%; max-width:800px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">Practice</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">Patient type</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">Distance</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">Phone</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">NHS Page</th>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;">Map</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>

    <p style="margin-top:12px;font-size:13px;color:#555;">
      Tip: NHS availability can change quickly. If you find a suitable practice, it’s best to contact them as soon as possible to confirm they are still accepting new patients.
    </p>

    <p style="margin-top:16px;font-size:12px;color:#777;">
      You’re receiving this email because you opted in to alerts on DentistRadar. You can unsubscribe or change your alert settings at any time.
    </p>
  </div>
  `;
}

// ---------------- Core scan for a (postcode, radiusMiles) ----------------

async function scanPostcodeRadius(postcodeRaw, radiusMilesRaw, opts = {}) {
  const postcode = normalisePostcode(postcodeRaw);
  const radiusMiles = Number(radiusMilesRaw || 25);
  const started = Date.now();

  const url = buildNhsSearchUrl(postcode, radiusMiles);
  console.log(
    `🔍 Scanning NHS for postcode="${postcode}", radius=${radiusMiles} – ${url}`
  );

  const searchHtml = await fetchHtml(url, "search");
  const basicPractices = parseSearchResults(searchHtml);

  console.log(
    `📄 Found ${basicPractices.length} potential practices in search results for ${postcode} (${radiusMiles} miles).`
  );

  const detailed = [];
  let accepting = 0;
  let childOnly = 0;
  let notAccepting = 0;

  for (const p of basicPractices) {
    await sleep(400);

    const result = await scanPractice(p);
    detailed.push(result);

    if (result.accepting) accepting++;
    if (result.childOnly) childOnly++;
    if (result.notAccepting) notAccepting++;
  }

  const acceptingPractices = detailed.filter((p) => p.accepting);
  const childOnlyPractices = detailed.filter((p) => p.childOnly);
  const notAcceptingPractices = detailed.filter((p) => p.notAccepting);

  const summary = {
    postcode,
    radiusMiles,
    accepting: acceptingPractices.length,
    childOnly: childOnlyPractices.length,
    notAccepting: notAcceptingPractices.length,
    scanned: detailed.length,
    tookMs: Date.now() - started,
    acceptingPractices,
    allPractices: detailed,
  };

  console.log(
    `✅ Scan complete for ${postcode} (${radiusMiles} miles): accepting=${summary.accepting}, childOnly=${summary.childOnly}, notAccepting=${summary.notAccepting}, scanned=${summary.scanned}, tookMs=${summary.tookMs}`
  );

  return summary;
}

// ---------------- DB mode: run for all Watches ----------------

async function sendAlertEmail(toEmail, { postcode, radiusMiles, practices }) {
  const fromEmail = process.env.FROM_EMAIL || "alerts@dentistradar.com";

  const html = renderAcceptingEmailHtml({ postcode, radiusMiles, practices });
  const subject = `NHS dentists near ${postcode} currently accepting patients`;

  const mailOptions = {
    from: `DentistRadar <${fromEmail}>`,
    to: toEmail,
    subject,
    html,
  };

  const tx = getTransport();
  await tx.sendMail(mailOptions);
}

async function runAllScans({ dryRun = false } = {}) {
  await connectMongo();

  const watches = await Watch.find({
    unsubscribed: { $ne: true },
  }).lean();

  if (!watches.length) {
    console.log("ℹ️ No active watches found.");
    return;
  }

  // Group by (postcode, radiusMiles)
  const groups = new Map();
  for (const w of watches) {
    const pc = normalisePostcode(w.postcode);
    const radiusMiles = getRadiusFromWatch(w);
    const key = `${pc}::${radiusMiles}`;
    if (!groups.has(key)) {
      groups.set(key, {
        postcode: pc,
        radiusMiles,
        watches: [],
      });
    }
    groups.get(key).watches.push(w);
  }

  console.log(
    `📦 Found ${watches.length} watches across ${groups.size} unique (postcode, radius) groups.`
  );

  for (const [key, group] of groups) {
    const { postcode, radiusMiles } = group;

    let summary;
    try {
      summary = await scanPostcodeRadius(postcode, radiusMiles, {
        dryRun: true,
      });
    } catch (err) {
      console.error(
        `❌ Skipping group ${postcode} (${radiusMiles} miles) due to error: ${err.message}`
      );
      continue; // don't kill the whole cron
    }

    const acceptingPractices = summary.acceptingPractices;

    if (!acceptingPractices.length) {
      console.log(
        `ℹ️ No accepting practices for ${postcode} (${radiusMiles} miles). Skipping emails.`
      );
      continue;
    }

    for (const w of group.watches) {
      const email = w.email || w.userEmail;
      if (!email) continue;

      if (dryRun) {
        console.log(
          `🧪 [DRY RUN] Would send alert to ${email} for ${postcode} (${radiusMiles} miles) with ${acceptingPractices.length} practices.`
        );
        continue;
      }

      try {
        await sendAlertEmail(email, {
          postcode,
          radiusMiles,
          practices: acceptingPractices,
        });

        await EmailLog.create({
          watchId: w._id,
          email,
          postcode,
          radiusMiles,
          sentAt: new Date(),
          type: "accepting-alert",
        });

        console.log(
          `📧 Sent accepting alert to ${email} for ${postcode} (${radiusMiles} miles) with ${acceptingPractices.length} practices.`
        );
      } catch (err) {
        console.error("❌ Error sending email to", email, err.message);
      }

      await sleep(250);
    }
  }
}

// ---------------- Single-group helper (for /api/scan or manual test) ----------------

async function runSingleScan(postcode, radiusMiles, { dryRun = false } = {}) {
  await connectMongo();
  const summary = await scanPostcodeRadius(postcode, radiusMiles, {
    dryRun: true,
  });

  if (!dryRun) {
    console.log(
      "ℹ️ runSingleScan called with dryRun=false but no recipients wired. No emails sent."
    );
  }

  return summary;
}

// ---------------- CLI entry (TEST MODE) ----------------

if (process.argv[1] && process.argv[1].endsWith("scanner.js")) {
  const args = process.argv.slice(2);
  (async () => {
    if (args[0] === "--test") {
      const postcode = args[1] || "PR25 1QX";
      const radiusMiles = Number(args[2] || "25");

      await connectMongo(); // if you don't need DB for test, you can remove
      const summary = await scanPostcodeRadius(postcode, radiusMiles, {
        dryRun: true,
      });

      console.log("🧪 TEST SUMMARY:");
      console.log(JSON.stringify(summary, null, 2));

      if (summary.acceptingPractices.length) {
        const sampleHtml = renderAcceptingEmailHtml({
          postcode,
          radiusMiles,
          practices: summary.acceptingPractices,
        });
        console.log("\n🧪 SAMPLE EMAIL HTML (first chunk):\n");
        console.log(sampleHtml.slice(0, 4000));
      } else {
        console.log(
          "\n(no accepting practices found – no email HTML rendered)"
        );
      }

      process.exit(0);
    }
  })().catch((err) => {
    console.error("❌ CLI error:", err);
    process.exit(1);
  });
}

// ---------------- Exports ----------------

export { runAllScans, runSingleScan, scanPostcodeRadius };
