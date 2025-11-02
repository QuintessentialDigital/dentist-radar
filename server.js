// scanner.js — v1.4 (API-first + HTML fallback + health monitoring for DentistRadar)

import mongoose from "mongoose";

// ---------- MONGO CONNECTION ----------
if (!mongoose.connection.readyState) {
  const uri = process.env.MONGO_URI || "";
  if (uri) {
    await mongoose
      .connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
      .catch(() => {});
  }
}

// ---------- SCHEMAS ----------
const watchSchema = new mongoose.Schema(
  { email: String, postcode: String, radius: Number },
  { timestamps: true }
);

const emailLogSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    type: String,
    provider: String,
    providerId: String,
    meta: Object,
    sentAt: Date,
  },
  { versionKey: false }
);

const practiceStateSchema = new mongoose.Schema(
  {
    practiceId: String,
    name: String,
    postcode: String,
    link: String,
    accepting: Boolean,
    lastSeenAt: Date,
  },
  { versionKey: false, timestamps: true }
);

// stores small HTML snippet for debugging (optional)
const scanLogSchema = new mongoose.Schema(
  { pc: String, url: String, htmlSnippet: String, bytes: Number, when: Date },
  { versionKey: false }
);

// persistent health state for monitoring
const scanStatusSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "global" },
    zeroRuns: { type: Number, default: 0 }, // consecutive runs with cards==0 across all PCs
    lastOkAt: Date,
    lastWarnAt: Date,
  },
  { versionKey: false }
);

const Watch = mongoose.models.Watch || mongoose.model("Watch", watchSchema);
const EmailLog =
  mongoose.models.EmailLog || mongoose.model("EmailLog", emailLogSchema);
const PracticeState =
  mongoose.models.PracticeState || mongoose.model("PracticeState", practiceStateSchema);
const ScanLog = mongoose.models.ScanLog || mongoose.model("ScanLog", scanLogSchema);
const ScanStatus =
  mongoose.models.ScanStatus || mongoose.model("ScanStatus", scanStatusSchema);

// ---------- CONFIG / FLAGS ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (arr) => [...new Set(arr)];
const SCAN_DEBUG = (process.env.SCAN_DEBUG || "0") === "1";
const SCAN_SNAPSHOT = (process.env.SCAN_SNAPSHOT || "0") === "1";

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
    "accepting new patients",
  ];
  const notAcceptingPhrases = [
    "not accepting",
    "no longer accepting",
    "not currently accepting",
  ];
  if (notAcceptingPhrases.some((p) => body.includes(p))) return false;
  if (strict) return body.includes("accepting new nhs patients");
  return acceptingPhrases.some((p) => body.includes(p));
};

// ---------- FETCHERS ----------
async function fetchText(url) {
  const headers = {
    "User-Agent":
      process.env.NHS_UA ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    Referer: "https://www.nhs.uk/",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    DNT: "1",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Upgrade-Insecure-Requests": "1",
    Cookie: "nhsuk-cookie-consent=accepted",
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 15000);
  const r = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
  clearTimeout(timeout);
  if (!r.ok) throw new Error(`http_${r.status}`);
  return await r.text();
}

async function fetchJSON(url, headers = {}) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);
  const r = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
  clearTimeout(timeout);
  if (!r.ok) throw new Error(`api_http_${r.status}`);
  return await r.json();
}

// ---------- NHS RESULTS PAGE RESOLVER (uses lat/lon) ----------
async function resolveResultsPageForPostcode(pcRaw) {
  const pc = normPostcode(pcRaw);

  // 1) geocode via postcodes.io
  let lat = null, lon = null;
  try {
    const resp = await fetch(
      `https://api.postcodes.io/postcodes/${encodeURIComponent(pc.replace(/\s+/g, ""))}`
    );
    if (resp.ok) {
      const j = await resp.json();
      lat = j?.result?.latitude ?? null;
      lon = j?.result?.longitude ?? null;
    }
  } catch {}

  const label = encodeURIComponent(pc.toUpperCase());
  const candidates = [];

  // 2) New NHS pattern using lat/lon
  if (lat && lon) {
    candidates.push(
      `https://www.nhs.uk/service-search/find-a-dentist/results/${label}?latitude=${lat}&longitude=${lon}`
    );
  }

  // 3) Old fallbacks
  const BASE = (
    process.env.NHS_BASE ||
    "https://www.nhs.uk/service-search/find-a-dentist"
  ).replace(/\/+$/, "");
  const DEFAULT_PATH =
    process.env.NHS_RESULT_PATH || "/results?location={POSTCODE}";
  const pcEnc = encodeURIComponent(pc.toUpperCase());
  candidates.push(
    `${BASE}${DEFAULT_PATH.replace("{POSTCODE}", pcEnc)}`,
    `${BASE}/results?location=${pcEnc}`,
    `${BASE}?location=${pcEnc}`
  );

  for (const url of candidates) {
    try {
      const html = await fetchText(url);
      if (!/page not found|404/i.test(html)) {
        return { url, html };
      }
    } catch {}
  }
  throw new Error("no_results_url_resolved");
}

// ---------- POSTMARK EMAIL ----------
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  const key = process.env.POSTMARK_TOKEN;
  if (!key) return { ok: false, skipped: true };

  const r = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": key,
    },
    body: JSON.stringify({
      From: process.env.MAIL_FROM || "alerts@dentistradar.co.uk",
      To: to,
      Subject: subject,
      TextBody: text,
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.ok) {
    await EmailLog.create({
      to,
      subject,
      type,
      providerId: body.MessageID,
      meta,
      sentAt: new Date(),
    }).catch(() => {});
  }
  return { ok: r.ok, status: r.status, body };
}

// ---------- PARSERS ----------
function parsePracticeCardsHTML(html) {
  const out = [];
  const patterns = [
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<h2[^>]*class="[^"]*nhsuk-card__heading[^"]*"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+class="[^"]*nhsuk-list-panel__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/(?:services\/)?dentist\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const href = m[1];
      const name = m[2].replace(/<[^>]+>/g, " ").trim();
      out.push({
        name: name || "Dentist",
        link: href.startsWith("http") ? href : "https://www.nhs.uk" + href,
      });
    }
    if (out.length > 0) break;
  }

  // De-dup
  const seen = new Set();
  return out.filter((c) => {
    const k = c.link + "|" + c.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parsePracticeCardsAPI(json) {
  const out = [];
  const items =
    json?.results ||
    json?.organisations ||
    json?.value ||
    json?.items ||
    [];
  for (const it of items) {
    const name = it.name || it.title || it.practiceName || it.organisationName;
    let url = it.url || it.href || it.link || it.websiteUrl;
    const slug = it.slug || it.path || it.relativeUrl;
    if (!url && slug) url = slug.startsWith("http") ? slug : "https://www.nhs.uk" + slug;
    if (name && url) out.push({ name: name.trim(), link: url });
  }
  return out;
}

// ---------- CARD SOURCE (API first if available) ----------
async function getPracticeCardsForPostcode(pc) {
  const key = process.env.NHS_API_KEY || "";
  const pcEnc = encodeURIComponent(pc.toUpperCase());

  // Try the official API first if you have a key
  if (key) {
    const headers = { "subscription-key": key, Accept: "application/json" };
    const candidates = [
      `https://api.nhs.uk/service-search/organisations?api-version=2&search=${pcEnc}&top=20&skip=0&serviceType=dentist`,
      `https://api.nhs.uk/service-search/organisations?api-version=2&search=${pcEnc}&top=20&skip=0`,
    ];
    for (const url of candidates) {
      try {
        const json = await fetchJSON(url, headers);
        const cards = parsePracticeCardsAPI(json);
        if (cards.length > 0) return { source: "api", url, cards };
      } catch {
        // ignore and fall through
      }
    }
  }

  // Fallback to HTML (lat/lon)
  const { url, html } = await resolveResultsPageForPostcode(pc);

  if (SCAN_SNAPSHOT) {
    try {
      const snippet = html.replace(/\s+/g, " ").slice(0, 2500);
      await ScanLog.create({
        pc,
        url,
        htmlSnippet: snippet,
        bytes: html.length,
        when: new Date(),
      }).catch(() => {});
    } catch {}
  }

  const cards = parsePracticeCardsHTML(html);
  return { source: "html", url, cards, html };
}

// ---------- MAIN SCAN ----------
export async function runScan() {
  const LIMIT_POSTCODES = parseInt(process.env.SCAN_POSTCODES_LIMIT || "30", 10);
  const LIMIT_PRACTICES = parseInt(process.env.SCAN_PRACTICES_LIMIT || "30", 10);
  const DELAY_MS = parseInt(process.env.SCAN_DELAY_MS || "1200", 10);
  const STRICT = (process.env.SCAN_MATCH_STRICT || "0") === "1";
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.OWNER_EMAIL; // optional warning recipient

  const watches = await Watch.find({}, { email: 1, postcode: 1 }).lean();
  const postcodes = uniq(watches.map((w) => normPostcode(w.postcode))).slice(0, LIMIT_POSTCODES);

  let checked = 0, found = 0, alertsSent = 0;
  const debugMeta = { postcodesCount: postcodes.length, samples: [], flags: {} };

  // Postcode → watchers map
  const byPostcode = new Map();
  for (const w of watches) {
    const pc = normPostcode(w.postcode);
    if (!byPostcode.has(pc)) byPostcode.set(pc, []);
    byPostcode.get(pc).push(w);
  }

  // Aggregate signal to detect cookie wall/layout change
  let totalCards = 0;
  let suspectedCookieWall = false;

  for (const pc of postcodes) {
    try {
      const { source, url, cards, html } = await getPracticeCardsForPostcode(pc);
      totalCards += (cards?.length || 0);

      if (SCAN_DEBUG && debugMeta.samples.length < 5) {
        debugMeta.samples.push({ pc, source, url, cards: cards.length });
      }

      // crude cookie-wall detection
      if (html && /cookie/i.test(html) && /consent/i.test(html) && !/nhsuk-card__link|services\/dentist\//i.test(html)) {
        suspectedCookieWall = true;
      }

      for (const c of cards.slice(0, LIMIT_PRACTICES)) {
        checked++;

        // determine accepting
        let accepting = false;
        try {
          const detail = await fetchText(c.link);
          accepting = isAccepting(detail, STRICT);
        } catch {
          // ignore
        }

        const id = (c.link || c.name + "|" + pc).toLowerCase();
        const prev = await PracticeState.findOne({ practiceId: id }).lean();
        const prevAcc = prev ? !!prev.accepting : false;

        await PracticeState.updateOne(
          { practiceId: id },
          {
            $set: {
              practiceId: id,
              name: c.name,
              postcode: pc,
              link: c.link,
              accepting,
              lastSeenAt: new Date(),
            },
          },
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
            const r = await sendEmail(w.email, subj, text, "availability", {
              practice: c.name,
              postcode: pc,
              link: c.link,
            });
            if (r.ok) alertsSent++;
          }
        }
      }

      await sleep(DELAY_MS);
    } catch (e) {
      if (SCAN_DEBUG) {
        if (!debugMeta.errors) debugMeta.errors = [];
        if (debugMeta.errors.length < 5) debugMeta.errors.push({ pc, error: e.message });
      }
    }
  }

  // ---------- HEALTH MONITOR ----------
  const status = (await ScanStatus.findById("global").lean()) || { zeroRuns: 0 };
  if (totalCards > 0) {
    await ScanStatus.updateOne(
      { _id: "global" },
      { $set: { zeroRuns: 0, lastOkAt: new Date() } },
      { upsert: true }
    );
  } else {
    const next = (status.zeroRuns || 0) + 1;
    await ScanStatus.updateOne(
      { _id: "global" },
      { $set: { zeroRuns: next }, $setOnInsert: { lastOkAt: null } },
      { upsert: true }
    );

    // After 3 consecutive zero-card runs, send a warning email
    if (ADMIN_EMAIL && next >= 3) {
      const warnText = `DentistRadar scanner warning:

Consecutive runs with zero cards: ${next}
Suspected cookie wall: ${suspectedCookieWall ? "Yes" : "No"}

Actions:
• Open /admin.html and run Manual Scan
• In Render -> Env, set SCAN_SNAPSHOT=1
• Check Mongo 'scanlogs' for htmlSnippet
• Review NHS layout / cookies

— DentistRadar Monitor`;

      await sendEmail(
        ADMIN_EMAIL,
        "DentistRadar: Scanner reported zero results",
        warnText,
        "scanner-warning",
        { suspectedCookieWall, zeroRuns: next }
      ).catch(() => {});
      await ScanStatus.updateOne(
        { _id: "global" },
        { $set: { lastWarnAt: new Date() } },
        { upsert: true }
      );
    }
  }

  const result = { checked, found, alertsSent, totalCards };
  if (SCAN_DEBUG) {
    result.meta = {
      ...result.meta,
      samples: debugMeta.samples,
      errors: debugMeta.errors,
      flags: {
        suspectedCookieWall,
        usedApi: !!process.env.NHS_API_KEY,
      },
    };
  }
  return result;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  runScan()
    .then((r) => {
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      process.exit(0);
    })
    .catch((e) => {
      console.error(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    });
}
