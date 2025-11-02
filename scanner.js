// scanner.js — API-first robust scanner with HTML fallback, notifications & self-monitoring
// Safe: no UI changes; plugs into existing Mongo & Postmark via env vars.

import mongoose from "mongoose";

/* ---------- Config (env) ---------- */
const NHS_API_BASE = process.env.NHS_API_BASE || "https://api.nhs.uk/service-search";
const NHS_API_VERSION = process.env.NHS_API_VERSION || "2";
const NHS_API_KEY = process.env.NHS_API_KEY || ""; // optional but preferred

const NHS_HTML_BASE = "https://www.nhs.uk";
const NHS_FIND_BASE = `${NHS_HTML_BASE}/service-search/find-a-dentist/results`;

const SCAN_MODE = (process.env.SCAN_MODE || "api").toLowerCase();  // "api" | "html" | "both"
const SCAN_MAX_PCS = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG = process.env.SCAN_DEBUG === "1";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || ""; // to notify on persistent failures

// Email (Postmark)
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "";
const DOMAIN = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM = process.env.MAIL_FROM || `alerts@${DOMAIN}`;

/* ---------- Mongo collections (no new models) ---------- */
const watchesCol   = () => mongoose.connection.collection("watches");
const emaillogsCol = () => mongoose.connection.collection("emaillogs"); // existing EmailLog via server.js
const notifiedCol  = () => mongoose.connection.collection("notified");  // for dedupe notifications
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

/* ---------- Email helpers (local; does not change server.js) ---------- */
async function sendEmail(to, subject, text, type = "availability", meta = {}) {
  if (!POSTMARK_TOKEN) {
    console.warn("📭 Postmark missing, email skipped:", subject);
    return { ok:false, skipped:true };
  }
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
  const ok = res.ok;

  // Also mirror a minimal log to emaillogs (keeps parity with server.js)
  try {
    await emaillogsCol().insertOne({
      to, subject, type, provider: "postmark", providerId: body.MessageID,
      meta, sentAt: new Date()
    });
  } catch (e) {
    console.error("⚠️ emaillogs insert error:", e?.message || e);
  }

  if (!ok) console.error("❌ Postmark error:", res.status, body);
  return { ok, status: res.status, body };
}

async function notifyAdmin(subject, lines) {
  if (!ADMIN_EMAIL) return;
  try {
    await sendEmail(ADMIN_EMAIL, subject, Array.isArray(lines)?lines.join("\n"):String(lines), "admin");
  } catch (e) {
    console.error("❌ notifyAdmin failed:", e?.message || e);
  }
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

function parseCardsFromHTMLList(html) {
  const out = [];
  const patterns = [
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html))) {
      const href = m[1].startsWith("http") ? m[1] : NHS_HTML_BASE + m[1];
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      out.push({ name, link: href });
    }
    if (out.length) break;
  }
  return dedupe(out, x => x.link || x.name);
}

function detailMentionsAccepting(html) {
  // Inclusive, case-insensitive checks
  const accept = /(accepting|taking)\s+new\s+nhs\s+patients/i;
  const alt    = /(open\s+to\s+new\s+nhs\s+patients|now\s+accepting\s+nhs)/i;
  const deny   = /(not\s+accepting|currently\s+full|no\s+longer\s+accepting|no\s+new\s+nhs\s+patients)/i;
  if (deny.test(html)) return false;
  return accept.test(html) || alt.test(html);
}

/* ---------- Probes ---------- */
async function apiSearchByLatLon(pc, diag) {
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

async function htmlListByPC(pc, diag) {
  const url = `${NHS_FIND_BASE}/${encodeURIComponent(pc)}?distance=30`;
  const r = await fetchText(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true",
    "Referer": NHS_HTML_BASE + "/",
  });
  diag?.calls.push({ url, ok:r.ok, isJSON:r.isJSON, status:r.status, source:"html" });
  if (!r.ok) return [];
  return parseCardsFromHTMLList(r.text);
}

async function fetchDetail(link, diag) {
  const r = await fetchText(link, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Referer": NHS_HTML_BASE + "/",
  });
  diag?.calls.push({ url:link, ok:r.ok, isJSON:r.isJSON, status:r.status, kind:"detail" });
  if (!r.ok) return { accepting:false, html:"" };
  return { accepting: detailMentionsAccepting(r.text), html: r.text };
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
  const diag = SCAN_DEBUG ? { calls: [], errors: [] } : null;

  // scanner health doc
  const statusDoc = await statusCol().findOne({ _id:"scanner" }) || { _id:"scanner", fail_count:0, last_ok:null, last_error:null };

  try {
    const postcodes = await distinctPostcodesFromWatches();
    let checked = 0, found = 0, alertsSent = 0;

    for (const pc of postcodes) {
      let candidates = [];

      if (SCAN_MODE === "api" || SCAN_MODE === "both") {
        const viaApi = await apiSearchByLatLon(pc, diag);
        candidates = candidates.concat(viaApi);
      }
      if (!candidates.length || SCAN_MODE === "html" || SCAN_MODE === "both") {
        const viaHtml = await htmlListByPC(pc, diag);
        candidates = candidates.concat(viaHtml);
      }

      // dedupe
      candidates = dedupe(candidates, c => c.link || c.name || c.id || `${c.name}|${pc}`);

      // inspect details for "accepting new NHS patients"
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
        await sleep(250); // be nice between detail pages
      }

      checked++;
      await sleep(SCAN_DELAY_MS);
    }

    // success: reset fail counter
    statusDoc.fail_count = 0;
    statusDoc.last_ok = new Date();
    statusDoc.last_error = null;
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    const result = { ok: true, checked, found, alertsSent };
    if (SCAN_DEBUG) result.meta = { usedApi: !!NHS_API_KEY, mode: SCAN_MODE, pcs: postcodes.length, calls: diag.calls, errors: diag.errors };
    return result;

  } catch (err) {
    // failure: increment and alert admin on repeated failures
    statusDoc.fail_count = (statusDoc.fail_count || 0) + 1;
    statusDoc.last_error = String(err?.message || err);
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    if (statusDoc.fail_count >= 3 && ADMIN_EMAIL) {
      await notifyAdmin("Dentist Radar scanner issue", [
        `The scanner has failed ${statusDoc.fail_count} times in a row.`,
        `Last error: ${statusDoc.last_error}`,
        `Time: ${new Date().toISOString()}`,
        `Action: check NHS API/CSS changes or keys.`
      ]);
    }

    const out = { ok: true, checked: 0, found: 0, alertsSent: 0, note: "scanner_exception" };
    if (SCAN_DEBUG) out.meta = { last_error: statusDoc.last_error };
    return out;
  }
}
