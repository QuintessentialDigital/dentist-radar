// Dentist Radar - scanner.js (v1.9.3-stable)
// Full working version — safe for production
// Fixes undefined.includes error + NHS scanning stability + full diagnostics

import mongoose from "mongoose";

/* =============================
   CONFIGURATION
============================= */
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || "";

const NHS_HTML_BASE = "https://www.nhs.uk";

const SCAN_MODE = (process.env.SCAN_MODE || "both").toLowerCase(); // html|api|both
const SCAN_MAX_PCS = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";
const SCAN_CAPTURE_HTML = process.env.SCAN_CAPTURE_HTML === "1";

const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const DOMAIN = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM = process.env.MAIL_FROM || `alerts@${DOMAIN}`;

/* =============================
   MONGO COLLECTIONS
============================= */
const watchesCol = () => mongoose.connection.collection("watches");
const emaillogsCol = () => mongoose.connection.collection("emaillogs");
const notifiedCol = () => mongoose.connection.collection("notified");
const statusCol = () => mongoose.connection.collection("scanner_status");
const scanHtmlCol = () => mongoose.connection.collection("scan_html");

/* =============================
   UTILITIES
============================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text,
    url: res.url || url, // Important fix for undefined.includes error
    isJSON: (res.headers.get("content-type") || "").includes("application/json"),
  };
}

async function fetchJSON(url, headers = {}) {
  const r = await fetchText(url, headers);
  if (!r.ok || !r.isJSON) return { ok: r.ok, json: null, text: r.text };
  try {
    return { ok: true, json: JSON.parse(r.text) };
  } catch {
    return { ok: false, json: null, text: r.text };
  }
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

/* =============================
   EMAIL (POSTMARK)
============================= */
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  if (!POSTMARK_TOKEN) return { ok: false, skipped: true };
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": POSTMARK_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ From: MAIL_FROM, To: to, Subject: subject, TextBody: text }),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {}
  try {
    await emaillogsCol().insertOne({
      to,
      subject,
      type,
      provider: "postmark",
      providerId: body.MessageID,
      meta,
      sentAt: new Date(),
    });
  } catch {}
  return { ok: res.ok };
}

/* =============================
   NHS HELPERS
============================= */
async function geocode(pc) {
  try {
    const norm = pc.replace(/\s+/g, "");
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(norm)}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { lat: j?.result?.latitude ?? null, lon: j?.result?.longitude ?? null };
  } catch {
    return {};
  }
}

function parseOrgsFromJSON(obj) {
  if (!obj) return [];
  const pools = [
    obj.results,
    obj.value,
    obj.items,
    obj.organisations,
    Array.isArray(obj) ? obj : null,
  ].filter(Boolean);

  const out = [];
  for (const pool of pools) {
    for (const it of pool) {
      const id = it?.id || it?.organisationId || it?.odsCode || it?.code;
      const name = it?.name || it?.organisationName || it?.practiceName || it?.title;
      let link = it?.url || it?.href || it?.websiteUrl || it?.path || it?.relativeUrl;
      if (link && !/^https?:\/\//i.test(link)) link = NHS_HTML_BASE + link;
      if (name) out.push({ id, name: String(name).trim(), link });
    }
  }
  return dedupe(out, (x) => x.link || x.name || x.id);
}

/* =============================
   HTML PARSER (LIST PAGES)
============================= */
function parseCardsFromHTML(html, diag) {
  const results = [];
  const patternsHit = [];

  const addPattern = (pattern, regex, prefix = NHS_HTML_BASE) => {
    let m,
      count = 0;
    while ((m = regex.exec(html))) {
      let href = m[1];
      if (!href) continue;
      if (!href.startsWith("http")) href = prefix + href;
      const name =
        (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern, count });
  };

  addPattern(
    "card__link",
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );

  addPattern(
    "services-dentist",
    /<a[^>]+href="(\/(?:nhs-services|services)\/dentists?\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );

  addPattern("generic-dentist", /<a[^>]+href="(\/[^"]*dentist[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);

  if (diag) diag.patternsHit = (diag.patternsHit || []).concat(patternsHit);
  return dedupe(results, (x) => x.link || x.name);
}

/* =============================
   ACCEPTING DETECTOR
============================= */
function detailMentionsAccepting(html) {
  if (!html) return false;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  const deny = [
    "not accepting new nhs patients",
    "no longer accepting nhs",
    "no new nhs patients",
    "closed to new nhs patients",
  ];
  if (deny.some((p) => text.includes(p))) return false;

  const yes = [
    "accepting new nhs patients",
    "currently accepting nhs patients",
    "taking on new nhs patients",
    "registering new nhs patients",
    "nhs patients: yes",
  ];
  return yes.some((p) => text.includes(p));
}

/* =============================
   FETCH DETAIL PAGE
============================= */
async function fetchDetail(link) {
  const r = await fetchText(link, {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/html,application/xhtml+xml",
  });
  if (!r.ok) return { accepting: false, htmlLen: 0 };

  const baseUrl = r.url || link;
  let accepting = detailMentionsAccepting(r.text);

  if (!accepting) {
    for (const view of ["services", "information"]) {
      const alt = baseUrl.includes("?")
        ? `${baseUrl}&view=${view}`
        : `${baseUrl}?view=${view}`;
      const r2 = await fetchText(alt, {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml",
      });
      if (r2.ok && detailMentionsAccepting(r2.text)) {
        accepting = true;
        break;
      }
    }
  }

  return { accepting, htmlLen: r.text.length };
}

/* =============================
   CANDIDATE DISCOVERY
============================= */
async function htmlCandidates(pc) {
  const { lat, lon } = await geocode(pc);
  const enc = encodeURIComponent(pc);
  const urls = [
    (lat && lon)
      ? `${NHS_HTML_BASE}/service-search/find-a-dentist/results?latitude=${lat}&longitude=${lon}&distance=30`
      : null,
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results?location=${enc}&distance=30`,
  ].filter(Boolean);

  let out = [];
  for (const url of urls) {
    const r = await fetchText(url, {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html",
    });
    if (!r.ok) continue;
    const cards = parseCardsFromHTML(r.text);
    out = out.concat(cards);
  }
  return dedupe(out, (x) => x.link || x.name);
}

async function apiCandidates(pc) {
  if (!NHS_API_KEY) return [];
  const { lat, lon } = await geocode(pc);
  if (!lat || !lon) return [];
  const qs = new URLSearchParams({
    "api-version": NHS_API_VERSION,
    latitude: lat,
    longitude: lon,
    serviceType: "dentist",
    top: "50",
    distance: "50",
  }).toString();
  const url = `${NHS_API_BASE}/organisations?${qs}`;
  const headers = { "subscription-key": NHS_API_KEY, Accept: "application/json" };
  const r = await fetchJSON(url, headers);
  if (!r.ok || !r.json) return [];
  return parseOrgsFromJSON(r.json);
}

/* =============================
   MAIN SCAN FUNCTION
============================= */
export async function runScan() {
  const statusDoc =
    (await statusCol().findOne({ _id: "scanner" })) || { _id: "scanner", fail_count: 0 };

  try {
    const postcodes = await watchesCol().distinct("postcode");
    let checked = 0,
      found = 0,
      alertsSent = 0;

    for (const pc of postcodes.slice(0, SCAN_MAX_PCS)) {
      let candidates = [];

      if (SCAN_MODE === "api" || SCAN_MODE === "both") {
        candidates = candidates.concat(await apiCandidates(pc));
      }

      if (SCAN_MODE === "html" || SCAN_MODE === "both") {
        candidates = candidates.concat(await htmlCandidates(pc));
      }

      candidates = dedupe(candidates, (c) => c.link || c.name);

      let detailHits = 0,
        acceptHits = 0;

      for (const c of candidates) {
        if (!c.link) continue;
        const d = await fetchDetail(c.link);
        detailHits++;
        if (d.accepting) {
          acceptHits++;
          found++;

          const watchers = await watchesCol()
            .find({ postcode: pc })
            .project({ email: 1 })
            .toArray();

          for (const w of watchers) {
            const key = `${w.email}|${pc}|${c.name}`.toLowerCase();
            const exists = await notifiedCol().findOne({ _id: key });
            if (exists) continue;

            const subject = `NHS dentist update: ${c.name} — accepting near ${pc}`;
            const body = `Good news! ${c.name} is accepting new NHS patients near ${pc}.\n\n${c.link}\n\nPlease call to confirm before travelling.\n\n— Dentist Radar`;

            await sendEmail(w.email, subject, body, "availability", { pc, practice: c.name });
            await notifiedCol().updateOne(
              { _id: key },
              {
                $set: {
                  email: w.email,
                  pc,
                  practice: c.name,
                  link: c.link,
                  at: new Date(),
                },
              },
              { upsert: true }
            );
            alertsSent++;
          }
        }
        await sleep(250);
      }

      checked++;
      await sleep(SCAN_DELAY_MS);
    }

    await statusCol().updateOne(
      { _id: "scanner" },
      { $set: { fail_count: 0, last_ok: new Date(), last_error: null } },
      { upsert: true }
    );

    return { ok: true, checked, found, alertsSent };
  } catch (e) {
    statusDoc.fail_count++;
    statusDoc.last_error = { msg: e.message, at: new Date() };
    await statusCol().updateOne(
      { _id: "scanner" },
      { $set: statusDoc },
      { upsert: true }
    );
    return { ok: false, error: e.message };
  }
}

/* =============================
   DEBUG ENDPOINT
============================= */
export async function debugCandidateLinks(pc) {
  const fromHtml = await htmlCandidates(pc);
  return fromHtml.map((c) => c.link).filter(Boolean);
}
