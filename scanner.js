// Dentist Radar - scanner.js (v1.9.2)
// Stable baseline + modern NHS list discovery + broader acceptance detection
// Safe for production: does NOT change UI, Mongo schemas, Stripe, or routes outside scanner usage.

import mongoose from "mongoose";

/* ---------- Config ---------- */
const NHS_API_BASE     = process.env.NHS_API_BASE     || "https://api.nhs.uk/service-search";
const NHS_API_VERSION  = process.env.NHS_API_VERSION  || "2";
const NHS_API_KEY      = process.env.NHS_API_KEY      || "";   // optional but helpful

const NHS_HTML_BASE    = "https://www.nhs.uk";

const SCAN_MODE        = (process.env.SCAN_MODE || "both").toLowerCase(); // html|api|both
const SCAN_MAX_PCS     = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS    = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG       = process.env.SCAN_DEBUG === "1";
const SCAN_CAPTURE_HTML= process.env.SCAN_CAPTURE_HTML === "1";

const POSTMARK_TOKEN   = process.env.POSTMARK_TOKEN || "";
const DOMAIN           = process.env.DOMAIN || "dentistradar.co.uk";
const MAIL_FROM        = process.env.MAIL_FROM || `alerts@${DOMAIN}`;

/* ---------- Mongo Collections ---------- */
const watchesCol   = () => mongoose.connection.collection("watches");
const emaillogsCol = () => mongoose.connection.collection("emaillogs");
const notifiedCol  = () => mongoose.connection.collection("notified");
const statusCol    = () => mongoose.connection.collection("scanner_status");
const scanHtmlCol  = () => mongoose.connection.collection("scan_html");

/* ---------- Utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, headers = {}) {
  const res  = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    text,
    isJSON: (res.headers.get("content-type") || "").includes("application/json")
  };
}

async function fetchJSON(url, headers = {}) {
  const r = await fetchText(url, headers);
  if (!r.ok || !r.isJSON) return { ok: r.ok, json: null, text: r.text };
  try { return { ok: true, json: JSON.parse(r.text) }; }
  catch { return { ok: false, json: null, text: r.text }; }
}

function dedupe(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr) { const k = keyFn(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

/* ---------- Email (simple Postmark) ---------- */
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
  return { ok: res.ok };
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
  const pools = [
    obj.results, obj.value, obj.items, obj.organisations,
    Array.isArray(obj) ? obj : null
  ].filter(Boolean);

  const out = [];
  for (const pool of pools) {
    for (const it of pool) {
      const id   = it?.id || it?.organisationId || it?.odsCode || it?.code;
      const name = it?.name || it?.organisationName || it?.practiceName || it?.title;
      let link   = it?.url || it?.href || it?.websiteUrl || it?.path || it?.relativeUrl;
      if (link && !/^https?:\/\//i.test(link)) link = NHS_HTML_BASE + link;
      if (name) out.push({ id, name: String(name).trim(), link });
    }
  }
  return dedupe(out, x => x.link || x.name || x.id);
}

/* ---------- HTML parsing (list pages) ---------- */
function parseCardsFromHTML(html, diag) {
  const results = [];
  const patternsHit = [];

  const addPattern = (pattern, regex, prefix = NHS_HTML_BASE) => {
    let m, count = 0;
    while ((m = regex.exec(html))) {
      let href = m[1];
      if (!href) continue;
      if (!href.startsWith("http")) href = prefix + href;
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern, count });
  };

  // Card link styles commonly used on NHS search pages
  addPattern("card__link",
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );

  // Dentist links in both "services" and "nhs-services" namespaces
  addPattern("services-dentist",
    /<a[^>]+href="(\/(?:nhs-services|services)\/dentists?\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );

  // Fallback: any anchor with "dentist" segment
  addPattern("generic-dentist",
    /<a[^>]+href="(\/[^"]*dentist[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );

  // JSON-LD (structured data) fallback
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

  // Keep only links that look like actual practice detail pages, not category landing
  const practiceLike = (u) => {
    if (!u) return false;
    if (/\/nhs-services\/dentists\/(\?|$)/i.test(u)) return false; // landing page
    return /nhs\.uk\/(services\/dentist\/[^/?#]+|nhs-services\/dentists\/[^/?#]+)/i.test(u);
  };

  const filtered = results.filter(r => r.link && practiceLike(r.link));

  if (diag) {
    diag.patternsHit = (diag.patternsHit || []).concat(patternsHit);
    diag.candidateCounts = { raw: results.length, filtered: filtered.length };
  }
  return dedupe(filtered, x => x.link || x.name);
}

/* ---------- Acceptance detector (detail pages) ---------- */
function detailMentionsAccepting(html, diag) {
  if (!html) return false;

  // Strip tags + normalize whitespace for robust matching
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  // Any explicit denials override
  const deny = [
    'not accepting new nhs patients',
    'no longer accepting nhs',
    'currently full',
    'no new nhs patients',
    'not currently accepting',
    'closed to new nhs patients',
    'not accepting nhs adult patients',
    'nhs patient list is closed'
  ];
  if (deny.some(p => plain.includes(p))) return false;

  // Positive signals covering tables, badges, and free text (incl. "registering" / "taking on")
  const yesFreeText = [
    /accepting\s+new\s+nhs\s+patients/i,
    /(now|currently)\s+accepting\s+(new\s+)?nhs/i,
    /(taking|taking\s+on)\s+new\s+nhs\s+patients/i,
    /open\s+to\s+new\s+nhs\s+patients/i,
    /registering\s+(new\s+)?nhs\s+patients/i,
    /we\s+are\s+accepting\s+(new\s+)?nhs\s+patients/i,
    /accepting\s+nhs\s+patients\s*\(children\s+only\)/i,
    /accepting\s+nhs\s+(adults?|children)/i
  ];
  if (yesFreeText.some(r => r.test(plain))) {
    if (diag) (diag.snippets ||= []).push("free-text: " + plain.slice(0, 220));
    return true;
  }

  // Badge/tag
  if (/<span[^>]*class="[^"]*nhsuk-tag[^"]*"[^>]*>[^<]*(accepting|taking\s+on)[^<]*nhs[^<]*<\/span>/i.test(html)) {
    if (diag) (diag.snippets ||= []).push("badge: nhsuk-tag accepting");
    return true;
  }

  // Table-like "Accepting new NHS patients" -> "Yes"
  const yesTable =
    /accepting\s+new\s+nhs\s+patients[^<]{0,200}<\/(dt|th)>[^<]{0,200}<(dd|td)[^>]*>\s*(yes|open|accepting|currently\s*accepting)\b/i;
  if (yesTable.test(html)) {
    if (diag) (diag.snippets ||= []).push("table: accepting new NHS patients → Yes");
    return true;
  }

  // Generic "NHS patients: Yes"
  const nhsYes =
    /nhs\s+patients\s*[:\-]\s*(yes|open|accepting|currently\s*accepting)\b/i;
  if (nhsYes.test(plain)) {
    if (diag) (diag.snippets ||= []).push("table: NHS patients → Yes");
    return true;
  }

  // Adults/Children rows
  const rowYes =
    /(adults?|children)\s*[:\-]\s*(yes|open|accepting|currently\s*accepting)\b/i;
  if (rowYes.test(plain)) {
    if (diag) (diag.snippets ||= []).push("row: adult/children → Yes");
    return true;
  }

  // Structured data hint
  const ld = [];
  const ldRe = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ldRe.exec(html))) {
    ld.push(m[1]);
  }
  for (const block of ld) {
    try {
      const data = JSON.parse(block);
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const s = JSON.stringify(node).toLowerCase();
        if (
          s.includes('accepting new nhs patients') ||
          /"nhspatients"\s*:\s*"(yes|open|accepting)"/i.test(s)
        ) {
          if (diag) (diag.snippets ||= []).push("jsonld: accepting");
          return true;
        }
      }
    } catch {}
  }

  return false;
}

/* ---------- Candidate discovery ---------- */
async function htmlCandidates(pc, diag) {
  const { lat, lon } = await geocode(pc);
  const enc = encodeURIComponent(pc);
  const urls = [
    (lat && lon) ? `${NHS_HTML_BASE}/service-search/find-a-dentist/results?latitude=${lat}&longitude=${lon}&distance=30` : null,
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results?location=${enc}&distance=30`,
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results?postcode=${enc}&distance=30`,
    `${NHS_HTML_BASE}/service-search/find-a-dentist/results/${enc}?distance=30`,
    `${NHS_HTML_BASE}/service-search/other-services/Dentists/LocationSearch/${enc}?distance=30`,
    `${NHS_HTML_BASE}/find-a-dentist/results/${enc}?distance=30`
  ].filter(Boolean);

  let out = [];
  for (const url of urls) {
    const r = await fetchText(url, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html",
      "Referer": `${NHS_HTML_BASE}/service-search/find-a-dentist/`,
      "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
    });
    diag?.calls.push({ url, ok:r.ok, status:r.status, source:"html", htmlBytes:r.text.length });

    if (!r.ok) continue;

    // Pass 1: regular card parsers
    let cards = parseCardsFromHTML(r.text, diag);

    // Pass 2: href fallback (scan all anchors for dentist detail patterns)
    if (!cards.length) {
      const alts = [];
      const hrefRe = /href="([^"]+)"/gi;
      let m;
      while ((m = hrefRe.exec(r.text))) {
        const href = m[1];
        if (!href) continue;
        const abs = href.startsWith("http") ? href : NHS_HTML_BASE + href;
        if (/nhs\.uk\/(services\/dentist\/|nhs-services\/dentists\/[^/?#]+)/i.test(abs)
            && !/\/nhs-services\/dentists\/(\?|$)/i.test(abs)) {
          alts.push({ name: "Dentist", link: abs });
        }
      }
      if (alts.length) {
        (diag.patternsHit ||= []).push({ pattern: "href-fallback", count: alts.length });
        cards = cards.concat(alts);
      }
    }

    out = out.concat(cards);
    if (cards.length) break; // stop after first working list page
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
    serviceType: "dentist",
    top: "50",
    distance: "50"
  }).toString();
  const url = `${NHS_API_BASE}/organisations?${qs}`;
  const headers = { "subscription-key": NHS_API_KEY, "Accept": "application/json" };
  const r = await fetchJSON(url, headers);
  diag?.calls.push({ url, ok:r.ok, status:r.status, source:"api" });
  if (!r.ok || !r.json) return [];
  return parseOrgsFromJSON(r.json);
}

/* ---------- Detail fetch ---------- */
async function fetchDetail(link, diag) {
  const r = await fetchText(link, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url:link, ok:r.ok, status:r.status, kind:"detail", htmlBytes:r.text.length });

  if (SCAN_CAPTURE_HTML && r.ok) {
    try {
      await scanHtmlCol().updateOne(
        { _id: link },
        { $set: { html: r.text, at: new Date() } },
        { upsert:true }
      );
    } catch {}
  }

  // Optional alt-views in case the main tab hides the wording
  if (r.ok && !detailMentionsAccepting(r.text, diag)) {
    for (const view of ["services", "information"]) {
      const alt = r.url.includes("?") ? `${r.url}&view=${view}` : `${r.url}?view=${view}`;
      const r2 = await fetchText(alt, {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
      });
      diag?.calls.push({ url:alt, ok:r2.ok, status:r2.status, kind:"detail-alt", htmlBytes:r2.text.length });
      if (r2.ok && detailMentionsAccepting(r2.text, diag)) {
        return { accepting: true, htmlLen: r2.text.length };
      }
    }
  }

  return { accepting: r.ok && detailMentionsAccepting(r.text, diag), htmlLen: r.text.length };
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
  const docs = await watchesCol()
    .find({ postcode: { $in: [pc, pc.toUpperCase()] } })
    .project({ email:1, radius:1 })
    .toArray();
  return docs.map(d => ({ email: d.email, radius: d.radius || 5 }));
}

function notifiedKey(email, pc, practice) {
  return `${String(email||"").toLowerCase()}|${pc}|${practice}`.toLowerCase();
}

/* ---------- Public entry ---------- */
export async function runScan() {
  const diag = SCAN_DEBUG ? { calls: [], errors: [], patternsHit: [], candidateCounts:{} } : null;
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
      candidates = dedupe(candidates.concat(html), c => c.link || c.name || c.id);

      // Prefer NHS detail links
      const nhsDetail = candidates.filter(c => c.link && /nhs\.uk\/(services\/dentist\/|nhs-services\/dentists\/[^/?#]+)/i.test(c.link));
      const ordered = nhsDetail.length ? nhsDetail : candidates;

      let detailHits = 0, acceptHits = 0;

      for (const c of ordered) {
        if (!c.link) continue;
        const detail = await fetchDetail(c.link, diag);
        detailHits++;
        if (detail.accepting) {
          acceptHits++; found++;
          const watchers = await usersWatching(pc);
          for (const u of watchers) {
            const key = notifiedKey(u.email, pc, c.name);
            const exists = await notifiedCol().findOne({ _id:key });
            if (exists) continue;

            const subject = `NHS dentist update: ${c.name} — accepting near ${pc}`;
            const body = `Good news! ${c.name} is showing as accepting new NHS patients near ${pc}.\n\n${c.link}\n\nPlease call the practice directly to confirm availability before travelling.\n\n— Dentist Radar`;
            await sendEmail(u.email, subject, body, "availability", { pc, practice: c.name, link: c.link });

            await notifiedCol().updateOne(
              { _id:key },
              { $set: { email:u.email, pc, practice:c.name, link:c.link, at:new Date() } },
              { upsert:true }
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
    statusDoc.last_ok    = new Date();
    statusDoc.last_error = null;
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });

    const out = { ok: true, checked, found, alertsSent };
    if (SCAN_DEBUG) out.meta = {
      usedApi: !!NHS_API_KEY,
      mode: SCAN_MODE,
      pcs: postcodes.length,
      calls: diag.calls,
      patternsHit: diag.patternsHit,
      candidateCounts: diag.candidateCounts,
      detailHits: diag.detailHits,
      acceptHits: diag.acceptHits,
      snippets: diag.snippets || []
    };
    return out;

  } catch (e) {
    statusDoc.fail_count++;
    statusDoc.last_error = { msg: e.message, stack: e.stack, at: new Date() };
    await statusCol().updateOne({ _id:"scanner" }, { $set: statusDoc }, { upsert:true });
    return { ok:false, error:e.message };
  }
}

/* ---------- Debug helper for server route /api/scan/links ---------- */
export async function debugCandidateLinks(pc) {
  const diag = { calls: [], patternsHit: [], candidateCounts:{} };
  const fromHtml = await htmlCandidates(pc, diag);
  return fromHtml.map(c => c.link).filter(Boolean);
}
