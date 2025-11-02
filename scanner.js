// scanner.js — v0.9 starter scanner for Dentist Radar
// ---------------------------------------------------
// - Groups watches by postcode, fetches NHS search results per postcode,
// - Extracts practice cards and detects "Accepting new NHS patients" phrases,
// - Compares with last-known status (PracticeState collection),
// - Sends availability emails to matching watches (same-postcode match first),
// - Returns { checked, found, alertsSent } for admin/metrics.
//
// No changes required to server.js. server.js will import runScan() dynamically.
//
// ENV you can tune (optional):
// NHS_BASE               default "https://www.nhs.uk/service-search/find-a-dentist"
// NHS_RESULT_PATH        default "/results?location={POSTCODE}"
// NHS_UA                 default polite UA for scraping
// SCAN_POSTCODES_LIMIT   default 50 (max postcodes per run)
// SCAN_PRACTICES_LIMIT   default 50 (max practices per postcode)
// SCAN_DELAY_MS          default 1200 (delay between requests)
// SCAN_MATCH_STRICT      default "0" (if "1", require stronger match phrase)

import mongoose from "mongoose";

// Use the same live connection that server.js opened:
if (!mongoose.connection.readyState) {
  // In case scanner is ever executed standalone, try to connect.
  const uri = process.env.MONGO_URI || "";
  if (uri) {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true }).catch(()=>{});
  }
}

// --- Models (replicate minimal schemas used in server.js) ---
const watchSchema = new mongoose.Schema(
  { email: String, postcode: String, radius: Number },
  { timestamps: true, versionKey: false }
);
watchSchema.index({ email: 1, postcode: 1 }, { unique: true });

const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,
    provider: { type: String, default: "postmark" },
    providerId: String,
    meta: Object,
    sentAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

// Light state store for flipping detection per practice:
const practiceStateSchema = new mongoose.Schema(
  {
    practiceId: String,        // derived id (name+postcode or page link)
    name: String,
    postcode: String,
    link: String,
    accepting: Boolean,        // last seen status
    lastSeenAt: Date
  },
  { versionKey: false, timestamps: true }
);

const Watch = mongoose.models.Watch || mongoose.model("Watch", watchSchema);
const EmailLog = mongoose.models.EmailLog || mongoose.model("EmailLog", emailLogSchema);
const PracticeState = mongoose.models.PracticeState || mongoose.model("PracticeState", practiceStateSchema);

// --- Utility helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uniq = (arr) => [...new Set(arr)];
const normPostcode = (raw="") => {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length < 5) return raw.toUpperCase().trim();
  return `${t.slice(0, t.length - 3)} ${t.slice(-3)}`.trim();
};
const isAccepting = (html, strict=false) => {
  // Broad phrases seen on NHS pages
  const acceptingPhrases = [
    "accepting new nhs patients",
    "accepting adult nhs patients",
    "accepting child nhs patients",
    "accepting new patients" // fallback
  ];
  const notAcceptingPhrases = [
    "not accepting",
    "not currently accepting",
    "no longer accepting"
  ];
  const body = (html || "").toLowerCase();

  // If explicit "not accepting" appears, treat as false
  if (notAcceptingPhrases.some(p => body.includes(p))) return false;

  // Strict mode requires the most explicit phrase
  if (strict) {
    return body.includes("accepting new nhs patients");
  }
  // Otherwise, allow any of the broader accept phrases
  return acceptingPhrases.some(p => body.includes(p));
};

async function fetchText(url) {
  const ua = process.env.NHS_UA || "Mozilla/5.0 (compatible; DentistRadarBot/1.0; +https://www.dentistradar.co.uk)";
  const r = await fetch(url, { headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml" }});
  if (!r.ok) throw new Error(`fetch ${url} ${r.status}`);
  return await r.text();
}

// Naive parser for NHS results page: extract practice cards with link + name + maybe postcode
function parsePracticeCards(html) {
  const out = [];
  const body = html;

  // Try to find card anchors (nhsuk-card__link) first, then names around them
  const cardAnchorRegex = /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = cardAnchorRegex.exec(body))) {
    const href = m[1];
    const nameRaw = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    // Try to pull postcode near the card (rough heuristic)
    // Look behind this anchor for a "postcode" like pattern
    const windowHtml = body.slice(Math.max(0, m.index - 400), Math.min(body.length, m.index + 1000));
    const pcMatch = windowHtml.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/i);
    out.push({
      name: nameRaw || "Unknown practice",
      link: href.startsWith("http") ? href : ("https://www.nhs.uk" + href),
      postcode: pcMatch ? normPostcode(pcMatch[0]) : null
    });
  }
  return out;
}

// Minimal email sender (duplicates server.js logic but independent)
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) {
    console.log("ℹ️ POSTMARK_TOKEN not set → skipping email.");
    return { ok: false, skipped: true };
  }
  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": key
    },
    body: JSON.stringify({
      From: process.env.MAIL_FROM || "alerts@dentistradar.co.uk",
      To: to,
      Subject: subject,
      TextBody: text
    })
  });
  const body = await r.json().catch(()=>({}));
  const ok = r.ok;

  if (ok) {
    // Log to emaillogs (same schema as server)
    await EmailLog.create({
      to, subject, type,
      providerId: body.MessageID,
      meta,
      sentAt: new Date()
    }).catch(e => console.error("EmailLog save error:", e.message));
  } else {
    console.error("Postmark error:", body);
  }
  return { ok, status: r.status, body };
}

// --- Core runScan() ---
export async function runScan() {
  const BASE = (process.env.NHS_BASE || "https://www.nhs.uk/service-search/find-a-dentist").replace(/\/+$/,"");
  const PATH = process.env.NHS_RESULT_PATH || "/results?location={POSTCODE}";
  const SCAN_POSTCODES_LIMIT = parseInt(process.env.SCAN_POSTCODES_LIMIT || "50", 10);
  const SCAN_PRACTICES_LIMIT = parseInt(process.env.SCAN_PRACTICES_LIMIT || "50", 10);
  const SCAN_DELAY_MS = parseInt(process.env.SCAN_DELAY_MS || "1200", 10);
  const STRICT = (process.env.SCAN_MATCH_STRICT || "0") === "1";

  // 1) Collect postcodes from watches
  const watches = await Watch.find({}, { email:1, postcode:1, radius:1 }).lean();
  const postcodes = uniq(watches.map(w => normPostcode(w.postcode))).slice(0, SCAN_POSTCODES_LIMIT);

  let checked = 0;
  let foundPractices = 0;
  let alertsSent = 0;

  // Group watches by postcode for quick lookups
  const byPostcode = new Map();
  for (const w of watches) {
    const pc = normPostcode(w.postcode);
    if (!byPostcode.has(pc)) byPostcode.set(pc, []);
    byPostcode.get(pc).push(w);
  }

  for (const pc of postcodes) {
    try {
      // 2) Fetch result page for this postcode
      const url = `${BASE}${PATH.replace("{POSTCODE}", encodeURIComponent(pc))}`;
      const html = await fetchText(url);
      await sleep(SCAN_DELAY_MS);

      // 3) Parse practice cards
      const cards = parsePracticeCards(html).slice(0, SCAN_PRACTICES_LIMIT);

      for (const card of cards) {
        checked++;

        // Fetch individual practice page to detect status (accepting vs not)
        let accepting = false;
        let practiceHtml = "";
        try {
          practiceHtml = await fetchText(card.link);
          accepting = isAccepting(practiceHtml, STRICT);
        } catch (e) {
          // If individual page fails, attempt detection directly from results page snippet
          accepting = isAccepting(html, STRICT);
        }
        await sleep(250); // micro-pause between practice fetches

        // Determine a practiceId for state tracking
        const practiceId = (card.link || (card.name + "|" + (card.postcode || pc))).toLowerCase();

        // 4) Load last state and compare
        const prev = await PracticeState.findOne({ practiceId }).lean();
        const prevAccepting = prev ? !!prev.accepting : false;

        // Always update last seen (avoid stale)
        await PracticeState.updateOne(
          { practiceId },
          {
            $set: {
              practiceId,
              name: card.name,
              postcode: card.postcode || pc,
              link: card.link,
              accepting,
              lastSeenAt: new Date()
            }
          },
          { upsert: true }
        );

        // Only notify on flip: false -> true
        if (!prevAccepting && accepting) {
          foundPractices++;

          // 5) Notify all watches on SAME POSTCODE for now (simple + safe)
          const watchers = byPostcode.get(pc) || [];
          for (const w of watchers) {
            const subj = `NHS dentist update: ${card.name} — now accepting near ${pc}`;
            const lines = [
              `Good news! ${card.name} appears to be accepting new NHS patients near ${pc}.`,
              card.link ? `Check details: ${card.link}` : "",
              "",
              "Please call the practice directly to confirm before travelling.",
              "",
              "— Dentist Radar"
            ].filter(Boolean);
            const r = await sendEmail(w.email, subj, lines.join("\n"), "availability", { practice: card.name, postcode: pc, link: card.link });
            if (r.ok) alertsSent++;
          }
        }
      }
    } catch (e) {
      console.error("Scan error for postcode", pc, e.message);
    }
  }

  return { checked, found: foundPractices, alertsSent };
}

// If someone runs this file directly (node scanner.js), run once then exit:
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then(r => {
      console.log(JSON.stringify({ ok:true, ...r }));
      process.exit(0);
    })
    .catch(e => {
      console.error(JSON.stringify({ ok:false, error: e.message }));
      process.exit(1);
    });
}
