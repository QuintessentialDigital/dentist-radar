// scanner.js — robust discovery (multi-URL + JSON-LD + regex), API-first, HTML fallback.
// Leaves UI, Mongo saves, Stripe, welcome emails untouched.

import mongoose from "mongoose";

/* ---------- Config ---------- */
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || ""; // optional but preferred

const NHS_HTML_BASE = "https://www.nhs.uk";

// We’ll try these result page variants (NHS uses different routes)
function resultUrlsFor(pc) {
  const enc = encodeURIComponent(pc);
  return [
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results/${enc}?distance=30`,                  // variant A (your current)
    `${NHS_HTML_BASE}/service-search/other-services/Dentists/LocationSearch/${enc}?distance=30`, // legacy
    `${NHS_HTML_BASE}/find-a-dentist/results/${enc}?distance=30`,                                 // variant B (short)
  ];
}

const SCAN_MODE = (process.env.SCAN_MODE || "api").toLowerCase();  // "api" | "html" | "both"
const SCAN_MAX_PCS = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

// Email (Postmark)
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

/* ---------- Email (local) ---------- */
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
  // mirror log
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

/* ---- HTML parsers (broadened) ---- */
function parseCardsFromHTML(html, diag) {
  const results = [];
  const patternsHit = [];

  // 1) Card link pattern (nhsuk-card__link)
  {
    const re = /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m; let count = 0;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : NHS_HTML_BASE + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern: "card__link", count });
  }

  // 2) Direct dentist service links
  {
    const re = /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m; let count = 0;
    while ((m = re.exec(html))) {
      const href = NHS_HTML_BASE + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern: "services/dentist", count });
  }

  // 3) JSON-LD (if present)
  {
    const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m; let count = 0;
    while ((m = re.exec(html))) {
      try {
        const node = JSON.parse(m[1]);
        const arr = Array.isArray(node) ? node : [node];
        for (const n of arr) {
          if (!n) continue;
          const name = n.name || n?.item?.name;
          let url = n.url || n?.item?.url;
          if (name && url) {
            if (!/^https?:\/\//i.test(url)) url = NHS_HTML_BASE + url;
            results.push({ name: String(name).trim(), link: url });
            count++;
          }
          if (Array.isArray(n.itemListElement)) {
            for (const it of n.itemListElement) {
              const nm = it?.name || it?.item?.name;
              let u  = it?.url || it?.item?.url;
              if (nm && u) {
                if (!/^https?:\/\//i.test(u)) u = NHS_HTML_BASE + u;
                results.push({ name: String(nm).trim(), link: u });
                count++;
              }
            }
          }
        }
      } catch {}
    }
    if (count) patternsHit.push({ pattern: "jsonld", count });
  }

  // 4) Very broad dentist link catch-all
  {
    const re = /<a[^>]+href="(\/[^"]*dentist[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m; let count = 0;
    while ((m = re.exec(html))) {
      const href = NHS_HTML_BASE + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern: "generic-dentist", count });
  }

  if (diag) diag.patternsHit = (diag.patternsHit || []).concat(patternsHit);
  return dedupe(results, x => x.link || x.name);
}

async function htmlCandidates(pc, diag) {
  const urls = resultUrlsFor(pc);
  let out = [];
  for (const url of urls) {
    const r = await fetchText(url, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html",
      "Referer": NHS_HTML_BASE + "/",
      "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true"
    });
    diag?.calls.push({ url, ok:r.ok, isJSON:r.isJSON, status:r.status, source:"html", htmlBytes: r.text.length });
    if (!r.ok) continue;
    const cards = parseCardsFromHTML(r.text, diag);
    out = out.concat(cards);
    if (cards.length) break; // one variant succeeded—stop
  }
  return dedupe(out, x => x.link || x.name);
}

async function apiCandidates(pc, diag) {
  if (!NHS_API_KEY) return [];
  const { lat, lon } = await geocode(pc);
  if (!lat || !lon) { diag?.errors.push({ step:"geocode", pc, msg:"no_lat_lon"}); return []; }

  const qs = new URLSearchParams({
    "api-version": NHS_API_VERSION,
    latitude: String(lat),
    longitude: String(lon),
    serviceType: "dentist",
    top: String(process.env.NHS_API_TOP || 50),
    skip: "0",
    distance: String(process.env.NHS_API_DISTANCE_KM || 50),
  }).toString();

  const url = `${NHS_API_BASE}/organisations?${qs}`;
  const headers = { "subscription-key": NHS_API_KEY, "Accept": "application/json" };
  const r = await fetchJSON(url, headers);
  diag?.calls.push({ url, ok:r.ok, isJSON:r.isJSON, status:r.status, source:"api" });
  if (!r.ok || !r.json) return [];
  return parseOrgsFromJSON(r.json);
}

async function fetchDetail(link, diag) {
  const r = await fetchText(link, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Referer": NHS_HTML_BASE + "/",
  });
  diag?.calls.push({ url:link, ok:r.ok, isJSON:r.isJSON, status:r.status, kind:"detail" });
  if (!r.ok) return { accepting:false, html:"" };

  // Decide acceptance via phrases
  const html = r.text;
  const deny   = /(not\s+accepting|currently\s+full|no\s+longer\s+accepting|no\s+new\s+nhs\s+patients)/i;
  const accept = /(accepting|taking)\s+new\s+nhs\s+patients/i;
  const alt    = /(open\s+to\s+new\s+nhs\s+patients|now\s+accepting\s+nhs)/i;
  if (deny.test(html)) return { accepting:false, htmlLen: html.length };
  const accepting = accept.test(html) || alt.test(html);
  return { accepting, htmlLen: html.length };
}

/* ---------- Watch helpers ---------- */
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

      // API first?
      if (SCAN_MODE === "api" || SCAN_MODE === "both") {
        const api = await apiCandidates(pc, diag);
        candidates = candidates.concat(api);
      }

      // Always try HTML too (safety net)
      const html = await htmlCandidates(pc, diag);
      candidates = candidates.concat(html);

      // dedupe
      candidates = dedupe(candidates, c => c.link || c.name || c.id || `${c.name}|${pc}`);

      // inspect details
      for (const c of candidates) {
        if (!c.link) continue;
        const detail = await fetchDetail(c.link, diag);
        if (detail.accepting) {
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
      patternsHit: diag.patternsHit
    };
    return out;

  } catch (err) {
    statusDoc.fail_count = (statusDoc.fail_count || 0) + 1;
    statusDoc.last_error = String(err?.message || err);
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    if (statusDoc.fail_count >= 3 && ADMIN_EMAIL) {
      await sendEmail(ADMIN_EMAIL, "Dentist Radar scanner issue",
        `The scanner has failed ${statusDoc.fail_count} times in a row.\nLast error: ${statusDoc.last_error}\nTime: ${new Date().toISOString()}`,
        "admin");
    }

    const out = { ok: true, checked: 0, found: 0, alertsSent: 0, note: "scanner_exception" };
    if (SCAN_DEBUG) out.meta = { last_error: statusDoc.last_error };
    return out;
  }
}
