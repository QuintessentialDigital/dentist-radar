// DentistRadar scanner (v2.2 – resilient, grouped, dual-mode, NHS URL fix)
//
// Modes:
//   1) DB mode (cron / /api/scan without postcode):
//        - Reads active watches from Mongo (excluding unsubscribed)
//        - Groups by (postcode, radius)
//        - Scans each unique NHS search ONCE
//        - Sends acceptance emails via SMTP
//        - Logs to EmailLog
//
//   2) Direct/manual mode (when options.postcode is provided):
//        - Scans that postcode+radius only
//        - DOES NOT send any emails
//        - Returns detailed accepting/childOnly arrays for admin.html
//
// Assumptions:
//   - Node 18+ (global fetch available)
//   - `nodemailer` installed
//   - Watch + EmailLog schemas exported in ./models.js
//
// Env vars used:
//   MONGO_URI             (connection handled in server.js)
//   NHS_SEARCH_BASE       (optional; defaults to NHS dentist search URL)
//   SCANNER_TIMEOUT_MS    (optional; default 60000)
//   SCANNER_RETRIES       (optional; default 3)
//   SCANNER_MAX_PRACTICES (optional; default 50)
//
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (for SMTP alerts)
//   EMAIL_FROM or MAIL_FROM (e.g. "DentistRadar <alerts@dentistradar.co.uk>")
//
//   PUBLIC_ORIGIN         (e.g. "https://www.dentistradar.co.uk")
//   POSTCODE              (optional cron override: "ALL" or a specific PC)
//
// Export:
//   async function runScan(options?)
//     - if options.postcode → direct/manual mode
//     - else → DB mode (for cron + /api/scan without body.postcode)

import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { Watch, EmailLog } from "./models.js";

dotenv.config();

/* ---------------------------
   Config & helpers
--------------------------- */

const NHS_SEARCH_BASE =
  process.env.NHS_SEARCH_BASE ||
  "https://www.nhs.uk/service-search/find-a-dentist/results";

const HTTP_TIMEOUT_MS = Number(process.env.SCANNER_TIMEOUT_MS || 60000);
const MAX_RETRIES = Number(process.env.SCANNER_RETRIES || 3);
const MAX_PRACTICES_PER_ALERT = Number(process.env.SCANNER_MAX_PRACTICES || 50);

// Hard safety cap on how many practices per postcode+radius we follow.
const HARD_MAX_PRACTICES = Math.max(10, Math.min(200, MAX_PRACTICES_PER_ALERT));

const PUBLIC_ORIGIN =
  (process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk").replace(/\/+$/, "");

// Multi-pattern text detection for resilience when NHS changes wording slightly.
const ACCEPT_PATTERNS = [
  /currently accepts new nhs patients/i,
  /currently accepting new nhs patients/i,
  /accepts nhs patients for routine dental care/i,
  /taking on nhs patients/i,
  /now accepting nhs patients/i,
];

const CHILD_ONLY_PATTERNS = [
  /accepts new nhs child patients/i,
  /accepts nhs patients if they are children/i,
  /accepts children on the nhs/i,
  /taking on nhs child patients/i,
  /only accepting nhs patients.*children/i,
];

const NOT_ACCEPTING_PATTERNS = [
  /currently has no nhs capacity/i,
  /not accepting nhs patients/i,
  /not taking on nhs patients/i,
  /not currently accepting new nhs patients/i,
  /nhs appointments are not available/i,
];

function normalizePostcode(raw = "") {
  const t = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!t) return "";
  if (t.length <= 4) return t;
  return `${t.slice(0, t.length - 3)} ${t.slice(-3)}`.trim();
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchWithRetry(
  url,
  { timeoutMs = HTTP_TIMEOUT_MS, retries = MAX_RETRIES } = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (DentistRadar NHS checker; +https://www.dentistradar.co.uk)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-GB,en;q=0.9",
        },
      });
      clearTimeout(timeout);
      if (!r.ok) {
        // If 404, no point retrying this URL
        if (r.status === 404) {
          throw new Error(`Fetch failed 404 for ${url}`);
        }
        throw new Error(`Fetch failed ${r.status} for ${url}`);
      }
      return await r.text();
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      const msg = err?.message || String(err);
      console.warn(
        `Fetch attempt ${attempt}/${retries} failed: ${msg}`
      );
      // If it's a clear 404, stop retrying this URL
      if (msg.includes("Fetch failed 404")) {
        break;
      }
      const isLast = attempt === retries;
      if (isLast) break;
      await sleep(500 * attempt);
    }
  }
  throw lastErr;
}

/* ---------------------------
   NHS search URL helpers
--------------------------- */

// Use path-style URL first, fallback to query-style if needed.
function buildSearchUrls(postcode, radiusMiles) {
  const pc = encodeURIComponent(postcode.trim());
  const r = radiusMiles || 10;

  return [
    // 1) Path style – commonly used NHS pattern
    `${NHS_SEARCH_BASE}/${pc}?distance=${r}`,
    // 2) Query style – fallback to support older/alternative pattern if still valid
    `${NHS_SEARCH_BASE}?postcode=${pc}&distance=${r}`,
  ];
}

async function fetchSearchHtml(postcode, radiusMiles, labelForLogs) {
  const urls = buildSearchUrls(postcode, radiusMiles);
  let lastError = null;

  for (const url of urls) {
    console.log(`Search NHS for ${labelForLogs} → ${url}`);
    try {
      const html = await fetchWithRetry(url, {
        timeoutMs: HTTP_TIMEOUT_MS,
        retries: 2,
      });
      if (html && html.length > 0) {
        return { html, url };
      }
    } catch (err) {
      lastError = err;
      console.warn(
        `Search fetch failed for ${url}: ${err?.message || err}`
      );
      // Try next URL variant if there is one
    }
  }

  throw lastError || new Error("All NHS search URL variants failed");
}

/* ---------------------------
   HTML parsing helpers
--------------------------- */

function extractPracticesFromSearch(html, max = HARD_MAX_PRACTICES) {
  const practices = [];
  const seen = new Set();

  const regex =
    /<a[^>]+href="([^"]+\/services\/dentist\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(html)) && practices.length < max) {
    const href = m[1];
    const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
    const url = href.startsWith("http") ? href : `https://www.nhs.uk${href}`;
    const idMatch = url.match(
      /\/services\/dentist\/[^/]+\/([^/?#]+)/i
    );
    const practiceId = idMatch ? idMatch[1] : url;

    if (seen.has(practiceId)) continue;
    seen.add(practiceId);

    const contextStart = Math.max(0, regex.lastIndex - 400);
    const context = html.slice(contextStart, regex.lastIndex + 400);
    const ctxText = context
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    practices.push({
      practiceId,
      title: rawTitle || "NHS Dentist",
      url,
      excerpt: ctxText.slice(0, 280),
    });
  }

  return practices;
}

function buildAppointmentsUrl(baseUrl) {
  if (!baseUrl) return null;
  if (/appointments-and-opening-times/i.test(baseUrl)) return baseUrl;
  if (!baseUrl.endsWith("/")) {
    return `${baseUrl}/appointments-and-opening-times`;
  }
  return `${baseUrl}appointments-and-opening-times`;
}

function classifyAppointmentPage(html) {
  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  if (ACCEPT_PATTERNS.some((rx) => rx.test(text))) {
    if (CHILD_ONLY_PATTERNS.some((rx) => rx.test(text))) {
      return "childOnly";
    }
    return "accepting";
  }

  if (CHILD_ONLY_PATTERNS.some((rx) => rx.test(text))) {
    return "childOnly";
  }

  if (NOT_ACCEPTING_PATTERNS.some((rx) => rx.test(text))) {
    return "notAccepting";
  }

  return "unknown";
}

/* ---------------------------
   SMTP email helper
--------------------------- */

function getSmtpTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log(
      "[DentistRadar] SMTP not fully configured (SMTP_HOST/SMTP_USER/SMTP_PASS). " +
        "Skipping email send but continuing scanner/logging."
    );
    return null;
  }
  const port = Number(SMTP_PORT || 587);
  const secure = port === 465;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function buildUnsubscribeUrl(watch) {
  const params = new URLSearchParams({
    id: String(watch._id || ""),
    email: watch.email || "",
    postcode: watch.postcode || "",
  });
  return `${PUBLIC_ORIGIN}/unsubscribe.html?${params.toString()}`;
}

function buildMyAlertsUrl(email) {
  const params = new URLSearchParams({ email: email || "" });
  return `${PUBLIC_ORIGIN}/my-alerts.html?${params.toString()}`;
}

function buildAcceptingEmailHtml({ watch, adults, radiusMiles }) {
  const unsubscribeUrl = buildUnsubscribeUrl(watch);
  const myAlertsUrl = buildMyAlertsUrl(watch.email);

  const rows = adults
    .map((p) => {
      const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${p.title} ${watch.postcode}`
      )}`;
      return `
        <tr>
          <td style="padding:8px 6px;border-bottom:1px solid #e5e5e5;">
            <div style="font-weight:600;font-size:14px;margin-bottom:2px;">
              <a href="${p.url}" style="color:#0b63ff;text-decoration:none;" target="_blank" rel="noopener">
                ${p.title}
              </a>
            </div>
            <div style="font-size:12px;color:#555;">
              ${p.excerpt || ""}
            </div>
            <div style="font-size:12px;margin-top:4px;">
              <a href="${mapUrl}" style="color:#0b63ff;" target="_blank" rel="noopener">View on map</a>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#222;">
    <h2 style="margin:0 0 8px 0;font-size:18px;color:#0b63ff;">Good news – NHS dentist availability near you</h2>
    <p style="margin:0 0 10px 0;">
      We’ve detected NHS practices near <strong>${watch.postcode}</strong> that are currently
      accepting NHS patients within roughly <strong>${radiusMiles} miles</strong>.
    </p>
    <p style="margin:0 0 14px 0;">
      Please contact the practice directly as soon as possible – availability can change quickly and
      we can’t guarantee that slots will remain open.
    </p>

    <table style="border-collapse:collapse;width:100%;max-width:640px;margin:0 0 16px 0;">
      <tbody>
        ${rows}
      </tbody>
    </table>

    <p style="margin:12px 0 6px 0;font-size:13px;color:#444;">
      You can view or manage your alerts here:<br/>
      <a href="${myAlertsUrl}" style="color:#0b63ff;">Manage my alerts</a>
    </p>

    <p style="margin:6px 0 0 0;font-size:12px;color:#777;">
      If you no longer wish to receive alerts for this postcode, you can unsubscribe here:<br/>
      <a href="${unsubscribeUrl}" style="color:#0b63ff;">Unsubscribe from this alert</a>
    </p>

    <p style="margin:12px 0 0 0;font-size:11px;color:#999;">
      DentistRadar checks the public NHS website and cannot guarantee availability or bookings.
      Always confirm directly with the practice before travelling.
    </p>
  </div>
  `;
}

/* ---------------------------
   Core scanning for one postcode+radius
--------------------------- */

async function scanPostcodeRadius(postcode, radiusMiles) {
  const normPc = normalizePostcode(postcode);
  const start = Date.now();
  const summary = {
    postcode: normPc,
    radiusMiles,
    scanned: 0,
    accepting: 0,
    childOnly: 0,
    notAccepting: 0,
    unknown: 0,
    tookMs: 0,
  };

  let html;
  try {
    const res = await fetchSearchHtml(
      normPc,
      radiusMiles,
      `${normPc} (${radiusMiles} miles)`
    );
    html = res.html;
  } catch (err) {
    console.error("Search fetch failed:", err?.message || err);
    summary.tookMs = Date.now() - start;
    return { summary, accepting: [], childOnly: [], notAccepting: [], practices: [] };
  }

  const practices = extractPracticesFromSearch(html, HARD_MAX_PRACTICES);
  console.log(`Found ${practices.length} practice candidates for ${normPc}`);

  const accepting = [];
  const childOnly = [];
  const notAccepting = [];

  for (const p of practices) {
    const apptUrl = buildAppointmentsUrl(p.url);
    if (!apptUrl) continue;

    let apptHtml;
    try {
      apptHtml = await fetchWithRetry(apptUrl);
    } catch (err) {
      console.warn("Appointments fetch failed:", err?.message || err);
      continue;
    }

    const classification = classifyAppointmentPage(apptHtml);
    summary.scanned += 1;

    const practiceObj = {
      practiceId: p.practiceId,
      title: p.title,
      url: p.url,
      appointmentUrl: apptUrl,
      excerpt: p.excerpt,
      patientType: classification === "childOnly" ? "children_only" : "adults_and_children",
    };

    if (classification === "accepting") {
      accepting.push(practiceObj);
      summary.accepting += 1;
    } else if (classification === "childOnly") {
      childOnly.push(practiceObj);
      summary.childOnly += 1;
    } else if (classification === "notAccepting") {
      notAccepting.push(practiceObj);
      summary.notAccepting += 1;
    } else {
      summary.unknown += 1;
    }
  }

  summary.tookMs = Date.now() - start;
  return { summary, accepting, childOnly, notAccepting, practices };
}

/* ---------------------------
   DB mode (cron / background alerts)
--------------------------- */

async function runDbMode() {
  const envPc = (process.env.POSTCODE || "").trim();
  const filter = {
    status: { $ne: "unsubscribed" },
  };

  if (envPc && envPc.toUpperCase() !== "ALL") {
    filter.postcode = normalizePostcode(envPc);
  }

  const watches = await Watch.find(filter).lean();
  if (!watches.length) {
    console.log("No active watches found for DB scan.");
    return {
      ok: true,
      mode: "db",
      summary: { jobs: 0, scanned: 0, emails: 0, alertsSent: 0 },
    };
  }

  const groups = new Map();
  for (const w of watches) {
    if (!w.email || !w.postcode || !w.radius) continue;
    const pc = normalizePostcode(w.postcode);
    const radius = Number(w.radius) || 25;
    const key = `${pc}|${radius}`;
    if (!groups.has(key)) {
      groups.set(key, { postcode: pc, radius, watches: [] });
    }
    groups.get(key).watches.push(w);
  }

  console.log(
    `Starting DB scan for ${watches.length} watches grouped into ${groups.size} postcode+radius combos at ${new Date().toISOString()}`
  );

  const transport = getSmtpTransport();
  let totalScanned = 0;
  let totalEmails = 0;
  let totalAlertsSent = 0;

  for (const [key, group] of groups.entries()) {
    const { postcode, radius, watches: groupWatches } = group;
    console.log(`Scanning group ${key} with ${groupWatches.length} watches`);

    const { summary, accepting } = await scanPostcodeRadius(postcode, radius);
    totalScanned += summary.scanned;

    const adultPractices = accepting.filter(
      (p) => p.patientType !== "children_only"
    );
    if (!adultPractices.length) {
      console.log(`No adult-accepting practices for group ${key}`);
      continue;
    }

    if (!transport) {
      continue;
    }

    for (const watch of groupWatches) {
      try {
        const html = buildAcceptingEmailHtml({
          watch,
          adults: adultPractices,
          radiusMiles: radius,
        });
        const subject = `NHS dentist availability near ${watch.postcode}`;

        const from =
          process.env.EMAIL_FROM ||
          process.env.MAIL_FROM ||
          "DentistRadar <alerts@dentistradar.co.uk>";

        const info = await transport.sendMail({
          from,
          to: watch.email,
          subject,
          html,
        });

        totalEmails += 1;
        totalAlertsSent += 1;

        for (const p of adultPractices) {
          try {
            await EmailLog.create({
              email: watch.email,
              postcode: watch.postcode,
              radiusMiles: radius,
              alertId: watch._id || null,
              practiceId: p.practiceId,
              appointmentUrl: p.appointmentUrl,
              type: "accepting",
              providerId: info?.messageId || null,
              sentAt: new Date(),
            });
          } catch (e) {
            console.error(
              "⚠️ EmailLog save error:",
              e?.message || e
            );
          }
        }
      } catch (err) {
        console.error(
          `❌ Failed to send alert email to ${watch.email} for ${watch.postcode}:`,
          err?.message || err
        );
      }
    }
  }

  return {
    ok: true,
    mode: "db",
    summary: {
      jobs: groups.size,
      scanned: totalScanned,
      emails: totalEmails,
      alertsSent: totalAlertsSent,
    },
  };
}

/* ---------------------------
   Direct/manual mode (single postcode)
--------------------------- */

async function runDirectMode(options = {}) {
  const postcode = normalizePostcode(options.postcode || "");
  const radius = Number(options.radius || options.radiusMiles || 25) || 25;
  const includeChildOnly = Boolean(options.includeChildOnly);

  console.log(
    `Manual/direct scan for ${postcode} (${radius} miles) at ${new Date().toISOString()}`
  );

  const { summary, accepting, childOnly } = await scanPostcodeRadius(
    postcode,
    radius
  );

  return {
    ok: true,
    mode: "direct",
    summary: {
      postcode: summary.postcode,
      radiusMiles: summary.radiusMiles,
      scanned: summary.scanned,
      accepting: summary.accepting,
      childOnly: summary.childOnly,
      notAccepting: summary.notAccepting,
      unknown: summary.unknown,
      tookMs: summary.tookMs,
    },
    accepting,
    childOnly: includeChildOnly ? childOnly : [],
  };
}

/* ---------------------------
   Exported entry point
--------------------------- */

export async function runScan(options = {}) {
  const envPc = (process.env.POSTCODE || "").trim();
  const hasPostcode = Boolean(options && options.postcode);

  if (hasPostcode) {
    return runDirectMode(options);
  }

  console.log(
    `🦷 DentistRadar scanner — timeout=${HTTP_TIMEOUT_MS}ms retries=${MAX_RETRIES} Mode=DB POSTCODE=${envPc || "ALL"}`
  );

  return runDbMode();
}

export default runScan;
