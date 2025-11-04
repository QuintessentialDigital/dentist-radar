// Dentist Radar - scanner.js (v1.9.2 Strict Appointments-first)
// - Follows the practice "Appointments" page first (with Referer + slash variants)
// - Only raises positives if the Appointments page/section confirms acceptance
// - Blocks profile/JSON-LD-only positives (avoids stale copy FPs)
// - Requires adults unless overridden
// - Preserves v1.9.2 structure, collections, and exports

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

// Optional: reconfirm positives to avoid blips (Appointments URL only)
const RECONFIRM        = /^(1|true|yes)$/i.test(String(process.env.RECONFIRM || "0"));
const RECONFIRM_TRIES  = Math.max(0, Number(process.env.RECONFIRM_TRIES || 1));
const RECONFIRM_GAP_MS = Math.max(0, Number(process.env.RECONFIRM_GAP_MS || 120000));

// Strict guardrails to avoid false positives
const STRICT_APPOINTMENTS_ONLY       = /^(1|true|yes)$/i.test(String(process.env.STRICT_APPTS_ONLY || "1")); // default ON
const IGNORE_JSONLD_FOR_POSITIVES    = /^(1|true|yes)$/i.test(String(process.env.IGNORE_JSONLD_FOR_POS || "1"));
const REQUIRE_ADULTS_FOR_POSITIVE    = /^(1|true|yes)$/i.test(String(process.env.REQUIRE_ADULTS_POS || "1"));

// Optional: treat children-only acceptance as positive (overrides strict adults)
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

// include with and without trailing slash
function withSlashVariants(url) {
  try {
    const u = new URL(url);
    const noSlash = u.toString().replace(/\/+$/, "");
    const withSlash = noSlash + "/";
    return Array.from(new Set([noSlash, withSlash]));
  } catch { return [url]; }
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

/* ---------- Acceptance detector (STRICT: Appointments-only positives) ---------- */
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch {}
  }
  return out;
}

function classifyAcceptanceStrict(html, diag, { ignoreJsonLdForPositives = true, requireAdults = true } = {}) {
  if (!html) return { accepting: null, score: 0, snippet: "" };

  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // Canonical NHS phrasing (gold standard)
  const GOLD_POS = [
    /\b(currently\s+)?accepts?\s+new\s+nhs\s+patients\s+for\s+routine\s+dental\s+care\b/i,
    /\b(currently\s+)?accepts?\s+new\s+nhs\s+patients\b/i,
    /\baccepting\s+new\s+nhs\s+patients\s+for\s+routine\s+dental\s+care\b/i,
    /\baccepting\s+new\s+nhs\s+patients\b/i
  ];

  // Adults/children detection
  const mentionsAdults   = /\badults?\b/.test(plain) || /\b18\s*or\s*over\b/.test(plain);
  const mentionsChildren = /\b(children|child|under\s*18|17\s*or\s*under)\b/.test(plain);

  // Hard negatives
  const HARD_NEG_STR = [
    'not accepting new nhs patients for routine dental care',
    'not accepting new nhs patients',
    'no longer accepting nhs',
    'closed to new nhs patients',
    'nhs registrations closed',
    'registrations suspended',
    'nhs list closed'
  ];
  const SOFT_NEG_STR = [
    'not accepting new patients',
    'temporarily not accepting',
    'private patients only',
    'waiting list only',
    'waiting list'
  ];

  // JSON-LD (stale sometimes)
  const jsonldText = extractJsonLd(html).map(x => JSON.stringify(x)).join(' ').toLowerCase();

  let score = 0;
  const note = (tag) => { if (SCAN_DEBUG) (diag.snippets ||= []).push(tag); };

  // negatives (JSON-LD allowed to push negative)
  if (HARD_NEG_STR.some(s => plain.includes(s))) { score -= 3; note('[hard_neg]'); }
  if (SOFT_NEG_STR.some(s => plain.includes(s)))  { score -= 1; note('[soft_neg]'); }
  if (HARD_NEG_STR.some(s => jsonldText.includes(s))) { score -= 2; note('[hard_neg_jsonld]'); }
  if (SOFT_NEG_STR.some(s => jsonldText.includes(s)))  { score -= 1; note('[soft_neg_jsonld]'); }

  // positives ONLY from visible text (never JSON-LD)
  let goldHit = GOLD_POS.some(rx => rx.test(plain));
  if (goldHit) { score += 4; note('[gold_pos]'); }

  // Table-like on-page Yes
  if (/accept(ing|s)?\s+new\s+nhs\s+patients[^<]{0,180}<\/(dt|th)>[^<]{0,160}<(dd|td)[^>]*>\s*(yes|open|currently\s*accept(ing|s)?)/i.test(html)) {
    score += 3; note('[table_yes]');
  }

  // Adults requirement (children-only should not count unless ACCEPT_CHILDREN_OK)
  if (requireAdults && !ACCEPT_CHILDREN_OK && mentionsChildren && !mentionsAdults) {
    score = Math.min(score, 2); // cap below positive threshold
    note('[children_only_guard]');
  }

  let accepting = null;
  if (score >= 3) accepting = true;
  else if (score <= -2) accepting = false;

  return { accepting, score, snippet: plain.slice(0, 220), mentionsAdults, mentionsChildren, goldHit };
}

/* ---------- Appointments discovery ---------- */
const APPOINTMENT_SLUGS = [
  "appointments",
  "appointments-and-opening-times",
  "appointments-and-opening-hours",
  "opening-times-and-appointments"
];

// Find explicit appointments link(s) on the profile page
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

    const isAppointmentsText =
      /\bappointments?\b/.test(innerNorm) ||
      /\bappointments?\b/.test(norm(attrs)) ||
      /appointments/i.test(href);
    if (isAppointmentsText) {
      const abs = resolveUrlMaybeRelative(href, profileUrl);
      if (abs) anchors.push(abs);
    }
  }
  return Array.from(new Set(anchors));
}

// If the appointments content is on the same page (hash), extract that section
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

function buildHardProbes(profileUrl) {
  const u = new URL(profileUrl, NHS_HTML_BASE);
  const base = u.pathname.replace(/\/+$/,'');
  const slugs = APPOINTMENT_SLUGS.map(slug => new URL(`${base}/${slug}`, u).toString());
  // hash anchors on same page
  const anchors = [profileUrl + "#appointments", profileUrl + "#appointment"];
  // expand non-hash candidates with/without trailing slash
  const out = [];
  for (const t of [...slugs, ...anchors]) {
    if (/#/.test(t)) out.push(t);
    else out.push(...withSlashVariants(t));
  }
  return Array.from(new Set(out));
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

  let cards = parseCardsFromHTML(r.text, diag);

  // Fallback: broad href scan
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

/* ---------- Detail fetch (Appointments-first + Referer + Slash-Variants) ---------- */
async function fetchDetail(profileUrl, diag) {
  // 1) Fetch profile
  const rProfile = await fetchText(profileUrl, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url:profileUrl, ok:rProfile.ok, status:rProfile.status, kind:"detail", htmlBytes:rProfile.text.length });

  if (!rProfile.ok) return { accepting:false, htmlLen: rProfile.text.length, score: 0, usedAppointments:false };

  if (SCAN_CAPTURE_HTML && rProfile.ok) {
    try {
      await scanHtmlCol().updateOne(
        { _id: profileUrl },
        { $set: { html: rProfile.text, at: new Date() } },
        { upsert:true }
      );
    } catch {}
  }

  // 2) Collect Appointments targets
  const linkDerived = findAppointmentsHref(rProfile.text, profileUrl);
  const hardProbes = buildHardProbes(profileUrl);
  const appointTargets = Array.from(new Set([...linkDerived, ...hardProbes]));

  // 3) Try hash section first (same HTML)
  let appointHtml = null;
  let appointUrlUsed = null;

  for (const aUrl of appointTargets) {
    if (/#/.test(aUrl)) {
      const section = extractAppointmentsSectionFromHtml(rProfile.text);
      if (section) { appointHtml = section; appointUrlUsed = aUrl; break; }
    }
  }

  // 4) Then try dedicated subpages — with Referer and slash variants
  if (!appointHtml) {
    for (const aUrl0 of appointTargets) {
      if (/#/.test(aUrl0)) continue;
      const tryUrls = withSlashVariants(aUrl0);
      for (const aUrl of tryUrls) {
        const rApp = await fetchText(aUrl, {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
          "Referer": profileUrl, // important for NHS
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
      if (appointHtml) break;
    }
  }

  // 5) Classify using appointments content; profile only used for negatives/meta
  const usedAppointments = !!appointHtml;
  const htmlToClassify = appointHtml || rProfile.text;

  const cls = classifyAcceptanceStrict(htmlToClassify, diag, {
    ignoreJsonLdForPositives: IGNORE_JSONLD_FOR_POSITIVES,
    requireAdults: REQUIRE_ADULTS_FOR_POSITIVE && !ACCEPT_CHILDREN_OK
  });

  let accepting = cls.accepting === true;
  let score = cls.score;

  // Enforce Appointments-only positives if configured
  if (STRICT_APPOINTMENTS_ONLY && accepting && !usedAppointments) {
    accepting = false;
    if (SCAN_DEBUG) (diag.snippets ||= []).push('[blocked_profile_positive]');
  }

  if (SCAN_DEBUG) (diag.snippets ||= []).push(usedAppointments ? `[appointments_used:${appointUrlUsed}]` : `[appointments_missing]`);

  // 6) Optional reconfirm (Appointments URL only)
  if (RECONFIRM && accepting && usedAppointments && RECONFIRM_TRIES > 0 && appointUrlUsed && !/#/.test(appointUrlUsed)) {
    let confirms = 1;
    for (let i = 0; i < RECONFIRM_TRIES; i++) {
      await sleep(RECONFIRM_GAP_MS);
      const rAgain = await fetchText(appointUrlUsed, {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        "Referer": profileUrl,
        "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
      });
      if (!rAgain.ok) continue;
      const cls2 = classifyAcceptanceStrict(rAgain.text, diag, {
        ignoreJsonLdForPositives: IGNORE_JSONLD_FOR_POSITIVES,
        requireAdults: REQUIRE_ADULTS_FOR_POSITIVE && !ACCEPT_CHILDREN_OK
      });
      if (cls2.accepting === true) { confirms++; score = Math.max(score, cls2.score); }
    }
    if (confirms < 2) accepting = false;
    (diag.snippets ||= []).push(`[reconfirm=${confirms}]`);
  }

  return { accepting, htmlLen: rProfile.text.length, score, usedAppointments };
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
        const detail = await fetchDetail(c.link, diag);  // Appointments-first + strict
        localDetailHits++;
        if (detail.accepting && detail.usedAppointments) { // only alert when Appointments produced the positive
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
export default runScan;          // default import
export { runScan as runscan };  // tolerate lowercase import
export { runScan as run_scan }; // tolerate snake_case import
