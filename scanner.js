// scanner.js — v1.0 stable build for Dentist Radar
// ------------------------------------------------
// Robust NHS fetch with retries, debug logging, polite rate limiting
// Safe to run in Render (uses existing DB + Postmark setup)

import mongoose from "mongoose";

// --------------------------------------------------
// MongoDB connection (reuse from server.js if present)
// --------------------------------------------------
if (!mongoose.connection.readyState) {
  const uri = process.env.MONGO_URI || "";
  if (uri) {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true }).catch(() => {});
  }
}

// --------------------------------------------------
// Schemas
// --------------------------------------------------
const watchSchema = new mongoose.Schema({ email: String, postcode: String, radius: Number }, { timestamps: true });
const emailLogSchema = new mongoose.Schema(
  { to: String, subject: String, type: String, provider: String, providerId: String, meta: Object, sentAt: Date },
  { versionKey: false }
);
const practiceStateSchema = new mongoose.Schema(
  { practiceId: String, name: String, postcode: String, link: String, accepting: Boolean, lastSeenAt: Date },
  { versionKey: false, timestamps: true }
);

const Watch = mongoose.models.Watch || mongoose.model("Watch", watchSchema);
const EmailLog = mongoose.models.EmailLog || mongoose.model("EmailLog", emailLogSchema);
const PracticeState = mongoose.models.PracticeState || mongoose.model("PracticeState", practiceStateSchema);

// --------------------------------------------------
// Utility helpers
// --------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (arr) => [...new Set(arr)];
const SCAN_DEBUG = (process.env.SCAN_DEBUG || "0") === "1";

const normPostcode = (raw = "") => {
  const t = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length < 5) return raw.toUpperCase().trim();
  return `${t.slice(0, t.length - 3)} ${t.slice(-3)}`.trim();
};

const isAccepting = (html, strict = false) => {
  const body = (html || "").toLowerCase();
  const acceptingPhrases = [
    "accepting new nhs patients",
    "accepting adult nhs patients",
    "accepting child nhs patients",
    "accepting new patients"
  ];
  const notAcceptingPhrases = ["not accepting", "no longer accepting", "not currently accepting"];
  if (notAcceptingPhrases.some((p) => body.includes(p))) return false;
  if (strict) return body.includes("accepting new nhs patients");
  return acceptingPhrases.some((p) => body.includes(p));
};

// --------------------------------------------------
// Stronger fetchText with retries + backoff
// --------------------------------------------------
async function fetchText(url, opts = {}) {
  const ua =
    process.env.NHS_UA ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
  const headers = {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    Referer: "https://www.nhs.uk/"
  };

  const maxRetries = 3;
  const baseDelay = 800;
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { method: "GET", headers, redirect: "follow", signal: ctrl.signal });
      clearTimeout(timeout);
      if (r.status === 403 || r.status === 429) throw new Error(`blocked_or_rate_limited_${r.status}`);
      if (!r.ok) throw new Error(`http_${r.status}`);
      return await r.text();
    } catch (err) {
      lastErr = err;
      const delay = baseDelay * Math.pow(2, i) + Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr || new Error("fetch_failed");
}

// --------------------------------------------------
// Parse NHS results page
// --------------------------------------------------
function parsePracticeCards(html) {
  const out = [];
  const cardAnchorRegex = /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = cardAnchorRegex.exec(html))) {
    const href = m[1];
    const name = m[2].replace(/<[^>]+>/g, " ").trim();
    out.push({
      name: name || "Unknown Practice",
      link: href.startsWith("http") ? href : "https://www.nhs.uk" + href
    });
  }
  return out;
}

// --------------------------------------------------
// Postmark email sender
// --------------------------------------------------
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) return { ok: false, skipped: true };

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
  const body = await r.json().catch(() => ({}));
  const ok = r.ok;

  if (ok) {
    await EmailLog.create({ to, subject, type, providerId: body.MessageID, meta, sentAt: new Date() }).catch(() => {});
  }
  return { ok, status: r.status, body };
}

// --------------------------------------------------
// Main runScan()
// --------------------------------------------------
export async function runScan() {
  const BASE = (process.env.NHS_BASE || "https://www.nhs.uk/service-search/find-a-dentist").replace(/\/+$/, "");
  const PATH = process.env.NHS_RESULT_PATH || "/results?location={POSTCODE}";
  const LIMIT_POSTCODES = parseInt(process.env.SCAN_POSTCODES_LIMIT || "30", 10);
  const LIMIT_PRACTICES = parseInt(process.env.SCAN_PRACTICES_LIMIT || "30", 10);
  const DELAY_MS = parseInt(process.env.SCAN_DELAY_MS || "1200", 10);
  const STRICT = (process.env.SCAN_MATCH_STRICT || "0") === "1";

  const watches = await Watch.find({}, { email: 1, postcode: 1 }).lean();
  const postcodes = uniq(watches.map((w) => normPostcode(w.postcode))).slice(0, LIMIT_POSTCODES);

  let checked = 0;
  let found = 0;
  let alertsSent = 0;
  const byPostcode = new Map();
  for (const w of watches) {
    const pc = normPostcode(w.postcode);
    if (!byPostcode.has(pc)) byPostcode.set(pc, []);
    byPostcode.get(pc).push(w);
  }

  const errorSamples = [];

  for (const pc of postcodes) {
    try {
      const pcEnc = encodeURIComponent(pc.toUpperCase());
      const url = `${BASE}${PATH.replace("{POSTCODE}", pcEnc)}`;
      const html = await fetchText(url);
      await sleep(DELAY_MS);
      const cards = parsePracticeCards(html).slice(0, LIMIT_PRACTICES);

      for (const c of cards) {
        checked++;
        let accepting = false;
        try {
          const detail = await fetchText(c.link);
          accepting = isAccepting(detail, STRICT);
        } catch (e) {
          accepting = isAccepting(html, STRICT);
        }
        const id = (c.link || c.name + "|" + pc).toLowerCase();
        const prev = await PracticeState.findOne({ practiceId: id }).lean();
        const prevAcc = prev ? !!prev.accepting : false;

        await PracticeState.updateOne(
          { practiceId: id },
          { $set: { practiceId: id, name: c.name, postcode: pc, link: c.link, accepting, lastSeenAt: new Date() } },
          { upsert: true }
        );

        if (!prevAcc && accepting) {
          found++;
          const watchers = byPostcode.get(pc) || [];
          for (const w of watchers) {
            const subj = `NHS dentist update: ${c.name} — now accepting near ${pc}`;
            const text = `Good news! ${c.name} appears to be accepting new NHS patients near ${pc}.

Check details: ${c.link}

Please call the practice directly to confirm before travelling.

— Dentist Radar`;
            const r = await sendEmail(w.email, subj, text, "availability", { practice: c.name, postcode: pc });
            if (r.ok) alertsSent++;
          }
        }
      }
    } catch (e) {
      if (SCAN_DEBUG && errorSamples.length < 5) errorSamples.push({ pc, error: e.message });
      console.error("Scan error for postcode", pc, e.message);
    }
  }

  const result = { checked, found, alertsSent };
  if (SCAN_DEBUG) result.errors = errorSamples;
  return result;
}

// --------------------------------------------------
// If run standalone (node scanner.js)
// --------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then((r) => {
      console.log(JSON.stringify({ ok: true, ...r }));
      process.exit(0);
    })
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
}
