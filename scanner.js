// Dentist Radar - scanner.js (v1.9.2+)
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

// NEW: temporal reconfirmation before emailing
const RECONFIRM        = /^(1|true|yes)$/i.test(String(process.env.RECONFIRM || "0"));
const RECONFIRM_TRIES  = Math.max(0, Number(process.env.RECONFIRM_TRIES || 1));   // additional tries after first hit
const RECONFIRM_GAP_MS = Math.max(0, Number(process.env.RECONFIRM_GAP_MS || 120000)); // 2 minutes

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
  }.filter(Boolean);

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
/** Extract JSON-LD blocks for extra hints (sometimes status appears there) */
function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const node = JSON.parse(m[1]);
      out.push(node);
    } catch {}
  }
  return out;
}

/** Classify acceptance using multi-signal ensemble (badge + body + jsonld) */
function classifyAcceptance(html, diag) {
  if (!html) return { accepting: null, score: 0, snippet: "" };

  // Keep original HTML for DOM-ish checks
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // Negative phrases (strong/soft)
  const HARD_NEG = [
    'not accepting new nhs patients',
    'no longer accepting nhs',
    'no new nhs patients',
    'not currently accepting',
    'closed to new nhs patients',
    'not accepting nhs adult patients',
    'nhs registrations closed',
    'nhs closed',
    'waiting list only'
  ];
  const SOFT_NEG = [
    'not accepting new patients',
    'temporarily not accepting',
    'private patients only',
    'accepting children nhs only',
    'waiting list'
  ];

  // Positive phrases (strong/soft)
  const HARD_POS = [
    'accepting new nhs patients',
    'taking new nhs patients',
    'currently accepting nhs patients',
    'now accepting nhs',
    'open to new nhs patients'
  ];
  const SOFT_POS = [
    'accepting nhs patients',
    'limited nhs spaces',
    'nhs registrations open',
    'adults: yes',
    'children: yes'
  ];

  // Badge/tag quick scan with a small DOM-ish regex (kept simple to avoid cheerio here)
  const badgeRe = /<span[^>]*class="[^"]*nhsuk-tag[^"]*"[^>]*>([\s\S]*?)<\/span>/i;
  const badgeMatch = html.match(badgeRe);
  const badgeText  = badgeMatch ? norm(badgeMatch[1]) : "";

  const jsonldRaw = extractJsonLd(html);
  const jsonld    = norm(JSON.stringify(jsonldRaw));

  let score = 0;
  const add = (n, why) => { score += n; if (SCAN_DEBUG) (diag.snippets ||= []).push(`[${why}]`); };

  // Hard negatives first (override bias)
  if (HARD_NEG.some(p => plain.includes(p)) || HARD_NEG.some(p => badgeText.includes(p)) || HARD_NEG.some(p => jsonld.includes(p))) {
    add(-3, "hard_neg");
  }
  if (SOFT_NEG.some(p => plain.includes(p)) || SOFT_NEG.some(p => badgeText.includes(p)) || SOFT_NEG.some(p => jsonld.includes(p))) {
    add(-1, "soft_neg");
  }

  // Hard positives
  if (HARD_POS.some(p => plain.includes(p)) || HARD_POS.some(p => badgeText.includes(p)) || HARD_POS.some(p => jsonld.includes(p))) {
    add(+3, "hard_pos");
  }
  // Soft positives
  if (SOFT_POS.some(p => plain.includes(p)) || SOFT_POS.some(p => badgeText.includes(p)) || SOFT_POS.some(p => jsonld.includes(p))) {
    add(+1, "soft_pos");
  }

  // Table-like pattern: "...Accepting new NHS patients...</dt>...<dd>Yes"
  const tableYes = /accepting\s+new\s+nhs\s+patients[^<]{0,200}<\/(dt|th)>[^<]{0,200}<(dd|td)[^>]*>\s*(yes|open|currently\s*accepting)/i.test(html);
  if (tableYes) add(+3, "table_yes");

  // Badge that explicitly contains accepting + nhs
  const badgeYes = /<span[^>]*class="[^"]*nhsuk-tag[^"]*"[^>]*>[^<]*(accepting|taking\s+on)[^<]*nhs[^<]*<\/span>/i.test(html);
  if (badgeYes) add(+3, "badge_yes");

  // Decide 3-way label
  let accepting = null;
  if (score >= 3) accepting = true;
  else if (score <= -2) accepting = false;

  // Build a short snippet for debug (body segment around most relevant hit)
  let snippet = badgeText || plain.slice(0, 220);
  return { accepting, score, snippet };
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

/* ---------- Detail fetch + reconfirm ---------- */
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

  if (!r.ok) return { accepting:false, htmlLen: r.text.length, score: 0 };

  // primary classification
  const cls = classifyAcceptance(r.text, diag);
  let accepting = cls.accepting === true;
  let score = cls.score;

  // optional reconfirm to reduce false positives
  if (RECONFIRM && accepting && RECONFIRM_TRIES > 0) {
    let confirms = 1;
    for (let i = 0; i < RECONFIRM_TRIES; i++) {
      await sleep(RECONFIRM_GAP_MS);
      const r2 = await fetchText(link, {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
        "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
      });
      if (!r2.ok) continue;
      const cls2 = classifyAcceptance(r2.text, diag);
      if (cls2.accepting === true) {
        confirms++;
        score = Math.max(score, cls2.score);
      }
    }
    // require at least 2 successful confirmations total
    if (confirms < 2) accepting = false;
    (diag.snippets ||= []).push(`[reconfirm=${confirms}]`);
  }

  // stash a short snippet for debug
  if (SCAN_DEBUG && cls.snippet) {
    (diag.snippets ||= []).push(cls.snippet.slice(0, 220));
  }

  return { accepting, htmlLen: r.text.length, score };
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
        const detail = await fetchDetail(c.link, diag);
        localDetailHits++;
        if (detail.accepting) {
          localAcceptHits++; found++;
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
