// Dentist Radar - scanner.js (v1.9.2++ Appointments-link first)
// Safe for production: keeps routes, Mongo, email, env flags. ESM + tolerant exports.

import mongoose from "mongoose";

/* ---------- Config ---------- */
const NHS_API_BASE     = process.env.NHS_API_BASE     || "https://api.nhs.uk/service-search";
const NHS_API_VERSION  = process.env.NHS_API_VERSION  || "2";
const NHS_API_KEY      = process.env.NHS_API_KEY      || "";   // optional

const NHS_HTML_BASE    = "https://www.nhs.uk";

const SCAN_MODE        = (process.env.SCAN_MODE || "html").toLowerCase(); // html|api|both
const SCAN_MAX_PCS     = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS    = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG       = process.env.SCAN_DEBUG === "1";
const SCAN_CAPTURE_HTML= process.env.SCAN_CAPTURE_HTML === "1";

// Optional: reconfirm positives to avoid blips
const RECONFIRM        = /^(1|true|yes)$/i.test(String(process.env.RECONFIRM || "0"));
const RECONFIRM_TRIES  = Math.max(0, Number(process.env.RECONFIRM_TRIES || 1));
const RECONFIRM_GAP_MS = Math.max(0, Number(process.env.RECONFIRM_GAP_MS || 120000));

// Optional: treat "children-only" acceptance as positive
const ACCEPT_CHILDREN_OK = /^(1|true|yes)$/i.test(String(process.env.ACCEPT_CHILDREN_OK || "0"));

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
const norm  = (s) => String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

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

function resolveUrlMaybeRelative(href, baseUrl) {
  try {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith("//")) return "https:" + href;
    return new URL(href, baseUrl).toString();
  } catch { return null; }
}

/* ---------- Email (Postmark) ---------- */
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
    const normPc = pc.replace(/\s+/g, "");
    const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(normPc)}`);
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
      href = resolveUrlMaybeRelative(href, prefix);
      const name = (m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "Dentist";
      results.push({ name, link: href });
      count++;
    }
    if (count) patternsHit.push({ pattern, count });
  };

  addPattern("card__link",
    /<a[^>]+class="[^"]*nhsuk-card__link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );
  addPattern("services-dentist",
    /<a[^>]+href="(\/(?:nhs-services|services)\/dentists?\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi
  );
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
          url = resolveUrlMaybeRelative(url, NHS_HTML_BASE);
          results.push({ name: String(name).trim(), link: url });
          count++;
        }
      }
    } catch {}
  }
  if (count) patternsHit.push({ pattern: "jsonld", count });

  // Keep only links that look like practice detail pages
  const practiceLike = (u) => {
    if (!u) return false;
    if (/\/nhs-services\/dentists\/(\?|$)/i.test(u)) return false; // landing page
    return /nhs\.uk\/(services\/dentist\/[^/?#]+|nhs-services\/dentists\/[^/?#]+)/i.test(u);
  };

  const filtered = results.filter(r => r.link && practiceLike(r.link));

  if (diag) {
    diag.patternsHit = (diag.patternsHit || []).concat(patternsHit);
    diag.candidateCounts = {
      raw: (diag.candidateCounts?.raw || 0) + results.length,
      filtered: (diag.candidateCounts?.filtered || 0) + filtered.length
    };
  }
  return dedupe(filtered, x => x.link || x.name);
}

/* ---------- Acceptance detector (phrases tuned to Appointments page) ---------- */
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function classifyAcceptance(html, diag) {
  if (!html) return { accepting: null, score: 0, snippet: "" };

  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // NHS copy seen on "Appointments" pages
  const HARD_NEG = [
    'not accepting new nhs patients for routine dental care',
    'not accepting new nhs patients',
    'no longer accepting nhs',
    'closed to new nhs patients',
    'nhs registrations closed',
    'registrations suspended',
    'nhs list closed'
  ];
  const SOFT_NEG = [
    'not accepting new patients',
    'temporarily not accepting',
    'private patients only',
    'waiting list only',
    'waiting list'
  ];
  const HARD_POS = [
    'accepting new nhs patients for routine dental care',
    'accepting new nhs patients',
    'we are accepting new nhs',
    "we're accepting new nhs",
    'open to new nhs patients',
    'taking on nhs',
    'new nhs registrations open',
    'accepting nhs registrations'
  ];
  const SOFT_POS = [
    'accepting nhs patients',
    'limited nhs capacity',
    'nhs spaces available',
    'registering nhs'
  ];

  // Children-only detection
  const childrenOnly = /\b(accepting|registering|taking on)\b[^.]{0,50}\b(children|child|under\s*18)\b[^.]{0,50}\bnhs\b/.test(plain);

  // quick JSON-LD scan (rarely holds acceptance, but harmless)
  const jsonldText = extractJsonLd(html).map(x => JSON.stringify(x)).join(' ').toLowerCase();

  let score = 0;
  const mark = (src, arr, val, tag) => { if (arr.some(p => src.includes(p))) { score += val; if (SCAN_DEBUG) (diag.snippets ||= []).push(`[${tag}]`); } };

  // negatives
  mark(plain, HARD_NEG, -3, 'hard_neg'); mark(jsonldText, HARD_NEG, -2, 'hard_neg_jsonld');
  mark(plain, SOFT_NEG, -1, 'soft_neg'); mark(jsonldText, SOFT_NEG, -1, 'soft_neg_jsonld');

  // positives
  mark(plain, HARD_POS, +3, 'hard_pos'); mark(jsonldText, HARD_POS, +2, 'hard_pos_jsonld');
  mark(plain, SOFT_POS, +1, 'soft_pos'); mark(jsonldText, SOFT_POS, +1, 'soft_pos_jsonld');

  // table-like pattern: "...Accepting new NHS patients... Yes"
  if (/accepting\s+new\s+nhs\s+patients[^<]{0,200}<\/(dt|th)>[^<]{0,200}<(dd|td)[^>]*>\s*(yes|open|currently\s*accepting)/i.test(html)) {
    score += 3; if (SCAN_DEBUG) (diag.snippets ||= []).push('[table_yes]');
  }

  if (childrenOnly) {
    if (ACCEPT_CHILDREN_OK) { score += 2; (diag.snippets ||= []).push('[children_only_pos]'); }
    else { score -= 1; (diag.snippets ||= []).push('[children_only_soft_neg]'); }
  }

  let accepting = null;
  if (score >= 3) accepting = true;
  else if (score <= -2) accepting = false;

  // small snippet for debug
  const snippet = plain.slice(0, 220);
  return { accepting, score, snippet };
}

/* ---------- Appointments link helpers ---------- */
// 1) Pull the real "Appointments" link from the practice page
function findAppointmentsHref(html, profileUrl) {
  const anchors = [];
  const aRe = /<a\b([^>]+)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const attrs = m[1] || "";
    const inner = (m[2] || "").replace(/<[^>]+>/g, " ").trim();
    const innerNorm = norm(inner);
    const hrefMatch = attrs.match(/\bhref="([^"]+)"/i) || attrs.match(/\bhref='([^']+)'/i);
    const href = hrefMatch ? hrefMatch[1] : null;
    if (!href) continue;

    // Prioritise anchors whose text says "appointments"
    const isAppointmentsText =
      /\bappointments?\b/.test(innerNorm) ||
      /\bappointments?\b/.test(norm(attrs)) ||
      /appointments/i.test(href);

    if (isAppointmentsText) {
      const abs = resolveUrlMaybeRelative(href, profileUrl);
      if (abs) anchors.push(abs);
    }
  }

  // If nothing by text, fall back to slugs commonly used
  if (!anchors.length) {
    const slugCandidates = [
      "appointments",
      "appointments-and-opening-times",
      "appointments-and-opening-hours",
      "opening-times-and-appointments"
    ];
    for (const slug of slugCandidates) {
      const abs = resolveUrlMaybeRelative(slug, profileUrl);
      if (abs) anchors.push(abs);
    }
    // also common hash anchors
    anchors.push(profileUrl + "#appointments");
    anchors.push(profileUrl + "#appointment");
  }

  // Deduplicate preserving order
  return Array.from(new Set(anchors));
}

// 2) If the appointments content is on the same page (hash), extract just that section
function extractAppointmentsSectionFromHtml(html) {
  const idx = html.search(/id=["']appointments["']|>appointments</i);
  if (idx >= 0) {
    const start = Math.max(0, idx - 3000);
    const end = Math.min(html.length, idx + 8000);
    return html.slice(start, end);
  }
  const hIdx = html.search(/<h[23][^>]*>\s*appointments\s*<\/h[23]>/i);
  if (hIdx >= 0) {
    const start = Math.max(0, hIdx - 2000);
    const end = Math.min(html.length, hIdx + 8000);
    return html.slice(start, end);
  }
  return null;
}

/* ---------- Candidate discovery ---------- */
async function htmlCandidates(pc, diag) {
  const enc = encodeURIComponent(pc);
  const url = `${NHS_HTML_BASE}/service-search/find-a-dentist/results/${enc}?distance=30`;

  const r = await fetchText(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Referer": `${NHS_HTML_BASE}/service-search/find-a-dentist/`,
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url, ok:r.ok, status:r.status, source:"html", htmlBytes:r.text.length });

  if (!r.ok) return [];

  // Pass 1: parse card-like links & JSON-LD
  let cards = parseCardsFromHTML(r.text, diag);

  // Pass 2: href fallback
  if (!cards.length) {
    const alts = [];
    const hrefRe = /href="([^"]+)"/gi;
    let m;
    while ((m = hrefRe.exec(r.text))) {
      const href = m[1];
      const abs = resolveUrlMaybeRelative(href, NHS_HTML_BASE);
      if (/nhs\.uk\/(services\/dentist\/|nhs-services\/dentists\/[^/?#]+)/i.test(abs)
          && !/\/nhs-services\/dentists\/(\?|$)/i.test(abs)) {
        alts.push({ name: "Dentist", link: abs });
      }
    }
    if (alts.length) {
      (diag.patternsHit ||= []).push({ pattern: "href-fallback", count: alts.length });
      cards = cards.concat(alts);
      if (diag) {
        diag.candidateCounts = {
          raw: (diag.candidateCounts?.raw || 0) + alts.length,
          filtered: (diag.candidateCounts?.filtered || 0) + alts.length
        };
      }
    }
  }

  return dedupe(cards, x => x.link || x.name);
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

/* ---------- Detail fetch (APPOINTMENTS LINK FIRST) ---------- */
async function fetchDetail(profileUrl, diag) {
  // Fetch profile
  const rProfile = await fetchText(profileUrl, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url:profileUrl, ok:rProfile.ok, status:rProfile.status, kind:"detail", htmlBytes:rProfile.text.length });

  if (!rProfile.ok) return { accepting:false, htmlLen: rProfile.text.length, score: 0 };

  if (SCAN_CAPTURE_HTML) {
    try {
      await scanHtmlCol().updateOne(
        { _id: profileUrl },
        { $set: { html: rProfile.text, at: new Date() } },
        { upsert:true }
      );
    } catch {}
  }

  // Find the actual "Appointments" link(s) from the profile HTML
  const appointLinks = findAppointmentsHref(rProfile.text, profileUrl);

  let appointHtml = null;
  let appointUrlUsed = null;

  // First, if we have a hash-only link, try extracting the section from this HTML
  for (const aUrl of appointLinks) {
    if (/#/.test(aUrl)) {
      const section = extractAppointmentsSectionFromHtml(rProfile.text);
      if (section) {
        appointHtml = section; appointUrlUsed = aUrl; break;
      }
    }
  }

  // Otherwise, fetch the first working appointments subpage
  if (!appointHtml) {
    for (const aUrl of appointLinks) {
      if (/#/.test(aUrl)) continue; // already handled hash
      const rApp = await fetchText(aUrl, {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
      });
      diag?.calls.push({ url:aUrl, ok:rApp.ok, status:rApp.status, kind:"appointments", htmlBytes:rApp.text.length });
      if (rApp.ok && rApp.text) {
        appointHtml = rApp.text; appointUrlUsed = aUrl;
        if (SCAN_CAPTURE_HTML) {
          try {
            await scanHtmlCol().updateOne(
              { _id: aUrl },
              { $set: { html: rApp.text, at: new Date(), from: "appointments" } },
              { upsert:true }
            );
          } catch {}
        }
        break;
      }
    }
  }

  // If still nothing, last resort: try to extract an appointments section from profile page
  if (!appointHtml) {
    appointHtml = extractAppointmentsSectionFromHtml(rProfile.text);
    appointUrlUsed = appointHtml ? (profileUrl + "#appointments") : null;
  }

  // Classify using appointments content if available, else full profile
  let cls = appointHtml ? classifyAcceptance(appointHtml, diag) : classifyAcceptance(rProfile.text, diag);
  if (SCAN_DEBUG) (diag.snippets ||= []).push(appointHtml ? `[appointments_used:${appointUrlUsed}]` : `[appointments_missing]`);

  let accepting = cls.accepting === true;
  let score = cls.score;

  // Reconfirm on appointments content (or profile if no appointments HTML)
  if (RECONFIRM && accepting && RECONFIRM_TRIES > 0) {
    let confirms = 1;
    for (let i = 0; i < RECONFIRM_TRIES; i++) {
      await sleep(RECONFIRM_GAP_MS);

      let htmlAgain = null;
      if (appointUrlUsed && !/#/.test(appointUrlUsed)) {
        const rAgain = await fetchText(appointUrlUsed, {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
          "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
        });
        if (rAgain.ok) htmlAgain = rAgain.text;
      } else {
        const rProf2 = await fetchText(profileUrl, {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
          "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
        });
        if (rProf2.ok) htmlAgain = extractAppointmentsSectionFromHtml(rProf2.text) || rProf2.text;
      }

      if (!htmlAgain) continue;
      const cls2 = classifyAcceptance(htmlAgain, diag);
      if (cls2.accepting === true) { confirms++; score = Math.max(score, cls2.score); }
    }
    if (confirms < 2) accepting = false;
    (diag.snippets ||= []).push(`[reconfirm=${confirms}]`);
  }

  if (SCAN_DEBUG && cls.snippet) (diag.snippets ||= []).push(cls.snippet.slice(0, 220));

  return { accepting, htmlLen: rProfile.text.length, score };
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
  const diag = SCAN_DEBUG ? { calls: [], errors: [], patternsHit: [], candidateCounts:{}, detailHits:0, acceptHits:0, snippets:[] } : null;
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

      let localDetailHits = 0, localAcceptHits = 0;

      for (const c of ordered) {
        if (!c.link) continue;
        const detail = await fetchDetail(c.link, diag);  // Appointments link first
        localDetailHits++;
        if (detail.accepting) {
          localAcceptHits++; found++;
          const watchers = await usersWatching(pc);
          for (const u of watchers) {
            const key = notifiedKey(u.email, pc, c.name);
            const exists = await notifiedCol().findOne({ _id:key });
            if (exists) continue;

            const subject = `NHS dentist update: ${c.name} — accepting near ${pc}`;
            const body = `Good news! ${c.name} shows as accepting new NHS patients near ${pc} (per their Appointments page).\n\n${c.link}\n\nPlease call the practice directly to confirm before travelling.\n\n— Dentist Radar`;
            await sendEmail(u.email, subject, body, "availability", { pc, practice:c.name, link:c.link });

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
        diag.detailHits += localDetailHits;
        diag.acceptHits += localAcceptHits;
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

/* ---------- Compatibility exports ---------- */
export default runScan;          // default import support
export { runScan as runscan };  // tolerate lowercase alias
export { runScan as run_scan }; // tolerate snake_case alias
