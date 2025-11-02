// Dentist Radar - scanner.js (v1.8.7)
// Baseline stable + improved acceptance detection + NHS alternate view support

import mongoose from "mongoose";

/* ---------- Config ---------- */
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || ""; // optional

const NHS_HTML_BASE = "https://www.nhs.uk";

function resultUrlsFor(pc) {
  const enc = encodeURIComponent(pc);
  return [
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results/${enc}?distance=30`,
    `${NHS_HTML_BASE}/service-search/other-services/Dentists/LocationSearch/${enc}?distance=30`,
    `${NHS_HTML_BASE}/find-a-dentist/results/${enc}?distance=30`
  ];
}

const SCAN_MODE = (process.env.SCAN_MODE || "both").toLowerCase();
const SCAN_MAX_PCS = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const DOMAIN = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM = process.env.MAIL_FROM || `alerts@${DOMAIN}`;

/* ---------- Mongo collections ---------- */
const watchesCol   = () => mongoose.connection.collection("watches");
const emaillogsCol = () => mongoose.connection.collection("emaillogs");
const notifiedCol  = () => mongoose.connection.collection("notified");
const statusCol    = () => mongoose.connection.collection("scanner_status");

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isJSONResponse(res) {
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json");
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, isJSON: isJSONResponse(res) };
}

async function fetchJSON(url, headers = {}) {
  const r = await fetchText(url, headers);
  if (!r.ok || !r.isJSON) return { ok: r.ok, status: r.status, json: null, text: r.text, isJSON: false };
  try {
    const json = JSON.parse(r.text);
    return { ok: true, status: r.status, json, text: r.text, isJSON: true };
  } catch {
    return { ok: false, status: r.status, json: null, text: r.text, isJSON: false };
  }
}

function dedupe(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr) { const k = keyFn(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

/* ---------- Email ---------- */
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  if (!POSTMARK_TOKEN) return { ok:false, skipped:true };
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": POSTMARK_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({ From: MAIL_FROM, To: to, Subject: subject, TextBody: text })
  });
  let body = {};
  try { body = await res.json(); } catch {}
  try {
    await emaillogsCol().insertOne({
      to, subject, type, provider: "postmark", providerId: body.MessageID, meta, sentAt: new Date()
    });
  } catch {}
  return { ok: res.ok, status: res.status, body };
}

/* ---------- NHS helpers ---------- */
async function geocode(pc) {
  try {
    const norm = pc.replace(/\s+/g, "");
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(norm)}`);
    if (!r.ok) return {};
    const j = await r.json();
    return { lat: j?.result?.latitude ?? null, lon: j?.result?.longitude ?? null };
  } catch { return {}; }
}

function parseOrgsFromJSON(obj) {
  if (!obj) return [];
  const pools = [obj.results, obj.value, obj.items, obj.organisations, Array.isArray(obj)?obj:null].filter(Boolean);
  const out = [];
  for (const pool of pools) {
    for (const it of pool) {
      const id    = it?.id || it?.organisationId || it?.odsCode || it?.code || it?.identifier;
      const name  = it?.name || it?.organisationName || it?.practiceName || it?.title;
      let link    = it?.url || it?.href || it?.websiteUrl || it?.path || it?.relativeUrl;
      if (link && !/^https?:\/\//i.test(link)) link = NHS_HTML_BASE + link;
      if (name) out.push({ id: id?String(id):undefined, name: String(name).trim(), link });
    }
  }
  return dedupe(out, x => (x.id || x.link || x.name || Math.random()));
}

/* ---------- HTML parsing ---------- */
function parseCardsFromHTML(html, diag) {
  const results = [];
  const patternsHit = [];

  const addPattern = (pattern, regex, prefix = NHS_HTML_BASE) => {
    let m, count = 0;
    while ((m = regex.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : prefix + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern, count });
  };

  addPattern("card__link", /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  addPattern("services/dentist", /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
  addPattern("generic-dentist", /<a[^>]+href="(\/[^"]*dentist[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);

  // JSON-LD
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m; let count = 0;
  while ((m = re.exec(html))) {
    try {
      const node = JSON.parse(m[1]);
      const arr = Array.isArray(node) ? node : [node];
      for (const n of arr) {
        const name = n.name || n?.item?.name;
        let url = n.url || n?.item?.url;
        if (name && url) {
          if (!/^https?:\/\//i.test(url)) url = NHS_HTML_BASE + url;
          results.push({ name: String(name).trim(), link: url });
          count++;
        }
      }
    } catch {}
  }
  if (count) patternsHit.push({ pattern: "jsonld", count });

  if (diag) diag.patternsHit = (diag.patternsHit || []).concat(patternsHit);
  return dedupe(results, x => x.link || x.name);
}

/* ---------- Acceptance check ---------- */
function detailMentionsAccepting(html) {
  if (!html) return false;

  const txt = html.replace(/\s+/g, ' ').toLowerCase();

  const deny = [
    'not accepting new nhs patients',
    'no longer accepting nhs',
    'currently full',
    'no new nhs patients',
    'not currently accepting'
  ];
  if (deny.some(p => txt.includes(p))) return false;

  // "Accepting new NHS patients: Yes"
  if (/accepting\s+new\s+nhs\s+patients\s*[:\-]\s*(yes|open|currently\s+accepting)/i.test(html)) return true;

  // Tag variants
  if (/<span[^>]*class="[^"]*nhsuk-tag[^"]*"[^>]*>[^<]*accepting[^<]*new[^<]*nhs[^<]*patients[^<]*<\/span>/i.test(html)) return true;

  // Summary-list (label + value)
  if (/accepting\s+new\s+nhs\s+patients[^<]{0,200}<\/(dt|th)>[^<]{0,200}<(dd|td)[^>]*>\s*(yes|open|currently\s*accepting)/i.test(html)) return true;

  // Fallbacks
  const loose = [
    /(accepting|taking)\s+new\s+nhs\s+patients/i,
    /open\s+to\s+new\s+nhs\s+patients/i,
    /now\s+accepting\s+nhs/i,
    /(accepting|taking)\s+new\s+nhs\s+patients\s*\(children|under\s*18\)\s*[:\-]?\s*yes/i
  ];
  if (loose.some(r => r.test(html))) return true;

  return false;
}

/* ---------- HTML + API candidates ---------- */
async function htmlCandidates(pc, diag) {
  const urls = resultUrlsFor(pc);
  let out = [];
  for (const url of urls) {
    const r = await fetchText(url, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html",
      "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true"
    });
    diag?.calls.push({ url, ok:r.ok, isJSON:r.isJSON, status:r.status, source:"html", htmlBytes:r.text.length });
    if (!r.ok) continue;
    const cards = parseCardsFromHTML(r.text, diag);
    out = out.concat(cards);
    if (cards.length) break;
  }
  return dedupe(out, x => x.link || x.name);
}

async function apiCandidates(pc, diag) {
  if (!NHS_API_KEY) return [];
  const { lat, lon } = await geocode(pc);
  if (!lat || !lon) return [];
  const qs = new URLSearchParams({
    "api-version": NHS_API_VERSION,
    latitude: lat, longitude: lon,
    serviceType: "dentist", top: "50", distance: "50"
  }).toString();

  const url = `${NHS_API_BASE}/organisations?${qs}`;
  const headers = { "subscription-key": NHS_API_KEY, "Accept": "application/json" };
  const r = await fetchJSON(url, headers);
  diag?.calls.push({ url, ok:r.ok, isJSON:r.isJSON, status:r.status, source:"api" });
  if (!r.ok || !r.json) return [];
  return parseOrgsFromJSON(r.json);
}

async function fetchDetail(link, diag) {
  let r = await fetchText(link, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url:link, ok:r.ok, isJSON:r.isJSON, status:r.status, kind:"detail" });

  if (r.ok && !detailMentionsAccepting(r.text)) {
    let alt = link.includes('?') ? link + '&view=services' : link + '?view=services';
    const r2 = await fetchText(alt, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-GB,en;q=0.9",
      "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
    });
    diag?.calls.push({ url:alt, ok:r2.ok, isJSON:r2.isJSON, status:r2.status, kind:"detail-alt" });
    if (r2.ok) return { accepting: detailMentionsAccepting(r2.text), htmlLen: r2.text.length };
  }

  if (!r.ok) return { accepting:false, html:"" };
  return { accepting: detailMentionsAccepting(r.text), htmlLen: r.text.length };
}

/* ---------- Watches ---------- */
async function distinctPostcodesFromWatches() {
  const docs = await watchesCol().find({}).project({ postcode:1 }).toArray();
  const set = new Set();
  for (const w of docs) {
    const pcs = Array.isArray(w.postcode) ? w.postcode : String(w.postcode || "").split(/[,;]+/);
    for (const raw of pcs) {
      const pc = String(raw || "").trim();
      if (pc) set.add(pc);
    }
  }
  return Array.from(set).slice(0, SCAN_MAX_PCS);
}
async function usersWatching(pc) {
  const docs = await watchesCol().find({ postcode: { $in: [pc, pc.toUpperCase()] } }).project({ email:1, radius:1 }).toArray();
  return docs.map(d => ({ email: d.email, radius: d.radius || 5 }));
}
function notifiedKey(email, pc, practice) {
  return `${String(email||"").toLowerCase()}|${pc}|${practice}`.toLowerCase();
}

/* ---------- Public entry ---------- */
export async function runScan() {
  const diag = SCAN_DEBUG ? { calls: [], errors: [], patternsHit: [] } : null;
  const statusDoc = await statusCol().findOne({ _id:"scanner" }) || { _id:"scanner", fail_count:0, last_ok:null, last_error:null };

  try {
    const postcodes = await distinctPostcodesFromWatches();
    let checked = 0, found = 0, alertsSent = 0;

    for (const pc of postcodes) {
      let candidates = [];

      if (SCAN_MODE === "api" || SCAN_MODE === "both") {
        const api = await apiCandidates(pc, diag);
        candidates = candidates.concat(api);
      }

      const html = await htmlCandidates(pc, diag);
      candidates = candidates.concat(html);
      candidates = dedupe(candidates, c => c.link || c.name || c.id || `${c.name}|${pc}`);

      const nhs = candidates.filter(c => /nhs\.uk\/services\/dentist\//i.test(c.link));
      const ordered = nhs.length ? nhs.concat(candidates.filter(c => !nhs.includes(c))) : candidates;

      let detailHits = 0, acceptHits = 0;

      for (const c of ordered) {
        if (!c.link) continue;
        const detail = await fetchDetail(c.link, diag);
        detailHits++;

        if (detail.accepting) {
          acceptHits++;
          found++;
          const watchers = await usersWatching(pc);

          for (const u of watchers) {
            const key = notifiedKey(u.email, pc, c.name);
            const exists = await notifiedCol().findOne({ _id:key });
            if (exists) continue;

            const subject = `NHS dentist update: ${c.name} — accepting near ${pc}`;
            const body = [
              `Good news! ${c.name} is showing as accepting new NHS patients near ${pc}.`,
              c.link ? `Check details: ${c.link}` : "",
              "",
              "Please call the practice to confirm availability before travelling.",
              "",
              "— Dentist Radar"
            ].filter(Boolean).join("\n");

            await sendEmail(u.email, subject, body, "availability", { pc, practice: c.name, link: c.link });
            await notifiedCol().updateOne(
              { _id: key },
              { $set: { email: u.email, pc, practice: c.name, link: c.link, at: new Date() } },
              { upsert: true }
            );
            alertsSent++;
          }
        }
        await sleep(250);
      }

      if (SCAN_DEBUG) {
        diag.detailHits = (diag.detailHits || 0) + detailHits;
        diag.acceptHits = (diag.acceptHits || 0) + acceptHits;
      }

      checked++;
      await sleep(SCAN_DELAY_MS);
    }

    statusDoc.fail_count = 0;
    statusDoc.last_ok = new Date();
    statusDoc.last_error = null;
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    const out = { ok: true, checked, found, alertsSent };
    if (SCAN_DEBUG) out.meta = {
      usedApi: !!NHS_API_KEY,
      mode: SCAN_MODE,
      pcs: postcodes.length,
      calls: diag.calls,
      patternsHit: diag.patternsHit,
      detailHits: diag.detailHits,
      acceptHits: diag.acceptHits
    };
    return out;

  } catch (err) {
    statusDoc.fail_count = (statusDoc.fail_count || 0) + 1;
    statusDoc.last_error = String(err?.message || err);
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    if (statusDoc.fail_count >= 3 && ADMIN_EMAIL) {
      await sendEmail(ADMIN_EMAIL, "Dentist Radar scanner issue",
        `The scanner has failed ${statusDoc.fail_count} times.\nLast error: ${statusDoc.last_error}`,
        "admin");
    }

    const out = { ok: true, checked: 0, found: 0, alertsSent: 0, note: "scanner_exception" };
    if (SCAN_DEBUG) out.meta = { last_error: status
