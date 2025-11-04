// Dentist Radar — scanner.js (v1.9.2 — Appointments-Only, Strict & Clean)
//
// What it does
// 1) For each watched postcode, discover nearby practices via NHS list pages.
// 2) For each practice, fetch the *Appointments* page (following the real link when present,
//    and probing canonical slugs with/without trailing slash and a proper Referer).
// 3) Classify acceptance **only** from Appointments content using NHS' canonical phrases:
//    - Accepting (adults & children listed)
//    - Accepting children only
//    - Not confirmed
//    - Not accepting (inc. specialist-by-referral only)
// 4) Alerts are sent **only** when Appointments says "accepting" (adults and/or children,
//    per config). Profile/JSON-LD cannot produce a positive.
//
// Safe for production: keeps Mongo collections, email flow, and exports intact.

import mongoose from "mongoose";

/* ---------- Config ---------- */
const NHS_HTML_BASE          = "https://www.nhs.uk";
const SEARCH_DISTANCE_MILES  = Number(process.env.SEARCH_DISTANCE_MILES || 25); // for NHS list pages
const SCAN_MAX_PCS           = Number(process.env.SCAN_MAX_PCS || 40);
const SCAN_DELAY_MS          = Number(process.env.SCAN_DELAY_MS || 800);
const SCAN_DEBUG             = process.env.SCAN_DEBUG === "1";
const SCAN_CAPTURE_HTML      = process.env.SCAN_CAPTURE_HTML === "1";

// Acceptance policy
const ACCEPT_CHILDREN_ONLY_OK = /^(1|true|yes)$/i.test(String(process.env.ACCEPT_CHILDREN_ONLY_OK || "0")); // default: adults required

// Optional reconfirm to reduce blips (Appointments URL only)
const RECONFIRM        = /^(1|true|yes)$/i.test(String(process.env.RECONFIRM || "0"));
const RECONFIRM_TRIES  = Math.max(0, Number(process.env.RECONFIRM_TRIES || 1));
const RECONFIRM_GAP_MS = Math.max(0, Number(process.env.RECONFIRM_GAP_MS || 120000));

// Email
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

/* ---------- Candidate discovery (NHS list pages) ---------- */
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

  // Keep only links that look like practice detail pages, not category landings
  const practiceLike = (u) => {
    if (!u) return false;
    if (/\/nhs-services\/dentists\/(\?|$)/i.test(u)) return false;
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

async function htmlCandidates(pc, diag) {
  const enc = encodeURIComponent(pc);
  const url = `${NHS_HTML_BASE}/service-search/find-a-dentist/results/${enc}?distance=${SEARCH_DISTANCE_MILES}`;

  const r = await fetchText(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Referer": `${NHS_HTML_BASE}/service-search/find-a-dentist/`,
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url, ok:r.ok, status:r.status, source:"html", htmlBytes:r.text.length });

  if (!r.ok) return [];
  let cards = parseCardsFromHTML(r.text, diag);

  // HREF fallback if the markup shifts
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

/* ---------- Appointments discovery & fetch ---------- */
const APPOINTMENT_SLUGS = [
  "appointments",
  "appointments-and-opening-times",
  "appointments-and-opening-hours",
  "opening-times-and-appointments"
];

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

function buildHardProbes(profileUrl) {
  const u = new URL(profileUrl, NHS_HTML_BASE);
  const base = u.pathname.replace(/\/+$/,'');
  const slugs = APPOINTMENT_SLUGS.map(slug => new URL(`${base}/${slug}`, u).toString());
  const anchors = [profileUrl + "#appointments", profileUrl + "#appointment"];
  const out = [];
  for (const t of [...slugs, ...anchors]) {
    if (/#/.test(t)) out.push(t);
    else out.push(...withSlashVariants(t));
  }
  return Array.from(new Set(out));
}

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

/* ---------- Acceptance classifier (Appointments ONLY) ---------- */
// Exact phrases you provided, plus variant-tolerant regexes.
// We *never* take positives from profile/JSON-LD; only from appointmentsHtml.

function classifyAppointments(appointmentsHtml, diag) {
  if (!appointmentsHtml) return { accepting:false, reason:"no_appointments_html" };

  const plain = appointmentsHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();

  // Exact/canonical messages
  const EXACT = {
    ACCEPTING:
      "this dentist currently accepts new nhs patients for routine dental care if they are:",
    ACCEPTING_CHILDREN_ONLY:
      "this dentist currently only accepts new nhs patients for routine dental care if they are children aged 17 or under.",
    NOT_CONFIRMED:
      "this dentist has not confirmed if they currently accept new nhs patients for routine dental care.",
    NOT_ACCEPTING_1:
      "this dentist does not accept new nhs patients for routine dental care.",
    NOT_ACCEPTING_2:
      "this dentist only accepts new nhs patients for specialist dental care by clinical referral from another dentist.",
    NOT_ACCEPTING_3:
      "this dentist does not currently accept new nhs patients for routine dental care."
  };

  // Variant-tolerant regex (minor wording shifts)
  const RX = {
    accepting: /\b(currently\s+)?accepts?\s+new\s+nhs\s+patients\s+for\s+routine\s+dental\s+care\b/,
    acceptingChildrenOnly: /\bcurrently\s+only\s+accepts?\s+new\s+nhs\s+patients\b[^.]*\b(children|under\s*18|17\s*or\s*under)\b/,
    notConfirmed: /\bhas\s+not\s+confirmed\s+if\s+they\s+currently\s+accept\s+new\s+nhs\s+patients\s+for\s+routine\s+dental\s+care\b/,
    notAccepting: /\bdoes\s+not\s+(currently\s+)?accept\s+new\s+nhs\s+patients\s+for\s+routine\s+dental\s+care\b/,
    specialistOnly: /\bonly\s+accepts\s+new\s+nhs\s+patients\s+for\s+specialist\s+dental\s+care\b/
  };

  const hitExact = (msg) => plain.includes(msg);
  const hit = {
    accepting:            hitExact(EXACT.ACCEPTING)            || RX.accepting.test(plain),
    acceptingChildrenOnly:hitExact(EXACT.ACCEPTING_CHILDREN_ONLY) || RX.acceptingChildrenOnly.test(plain),
    notConfirmed:         hitExact(EXACT.NOT_CONFIRMED)         || RX.notConfirmed.test(plain),
    notAccepting:         hitExact(EXACT.NOT_ACCEPTING_1)       || hitExact(EXACT.NOT_ACCEPTING_2) ||
                          hitExact(EXACT.NOT_ACCEPTING_3)       || RX.notAccepting.test(plain) || RX.specialistOnly.test(plain)
  };

  // Decision
  if (hit.accepting) {
    return { accepting:true, childrenOnly:false, reason:"accepting" };
  }
  if (hit.acceptingChildrenOnly) {
    return { accepting: !!ACCEPT_CHILDREN_ONLY_OK, childrenOnly:true,
             reason: ACCEPT_CHILDREN_ONLY_OK ? "accepting_children_ok" : "children_only_blocked" };
  }
  if (hit.notConfirmed) {
    return { accepting:false, reason:"not_confirmed" };
  }
  if (hit.notAccepting) {
    return { accepting:false, reason:"not_accepting" };
  }

  // Default conservative: do not alert
  if (SCAN_DEBUG) (diag.snippets ||= []).push("[no_known_phrase_found]");
  return { accepting:false, reason:"unknown_copy" };
}

/* ---------- Detail fetch (Appointments-first) ---------- */
async function fetchAppointmentsAndClassify(profileUrl, diag) {
  // 1) Fetch profile
  const rProfile = await fetchText(profileUrl, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-GB,en;q=0.9",
    "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
  });
  diag?.calls.push({ url:profileUrl, ok:rProfile.ok, status:rProfile.status, kind:"detail", htmlBytes:rProfile.text.length });
  if (!rProfile.ok) return { accepting:false, usedAppointments:false, reason:"profile_fetch_failed" };

  if (SCAN_CAPTURE_HTML) {
    try {
      await scanHtmlCol().updateOne(
        { _id: profileUrl },
        { $set: { html: rProfile.text, at: new Date(), kind:"profile" } },
        { upsert:true }
      );
    } catch {}
  }

  // 2) Collect Appointments targets
  const linkDerived = findAppointmentsHref(rProfile.text, profileUrl);
  const hardProbes  = buildHardProbes(profileUrl);
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

  // 4) Try dedicated subpages — with Referer and slash variants
  if (!appointHtml) {
    for (const aUrl0 of appointTargets) {
      if (/#/.test(aUrl0)) continue;
      const tryUrls = withSlashVariants(aUrl0);
      for (const aUrl of tryUrls) {
        const rApp = await fetchText(aUrl, {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
          "Referer": profileUrl,
          "Cookie": "nhsuk-cookie-consent=accepted; nhsuk_preferences=true; geoip_country=GB"
        });
        diag?.calls.push({ url:aUrl, ok:rApp.ok, status:rApp.status, kind:"appointments", htmlBytes:rApp.text.length });
        if (rApp.ok && rApp.text) {
          appointHtml = rApp.text; appointUrlUsed = aUrl;
          if (SCAN_CAPTURE_HTML) {
            try {
              await scanHtmlCol().updateOne(
                { _id: aUrl },
                { $set: { html: rApp.text, at: new Date(), kind:"appointments" } },
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

  // 5) Classify from Appointments ONLY
  const usedAppointments = !!appointHtml;
  const baseResult = classifyAppointments(appointHtml, diag);

  // 6) Optional reconfirm (same Appointments URL only)
  if (RECONFIRM && usedAppointments && baseResult.accepting && appointUrlUsed && !/#/.test(appointUrlUsed) && RECONFIRM_TRIES > 0) {
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
      const again = classifyAppointments(rAgain.text, diag);
      if (again.accepting) confirms++;
    }
    if (confirms < 2) {
      baseResult.accepting = false;
      baseResult.reason = "reconfirm_failed";
    }
    (diag.snippets ||= []).push(`[reconfirm=${confirms}]`);
  }

  if (SCAN_DEBUG) (diag.snippets ||= []).push(usedAppointments ? "[appointments_used]" : "[appointments_missing]");
  return { ...baseResult, usedAppointments };
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
  return docs.map(d => ({ email: d.email, radius: d.radius || SEARCH_DISTANCE_MILES }));
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
      // Candidate discovery around this PC; search radius is controlled by SEARCH_DISTANCE_MILES
      const candidates = await htmlCandidates(pc, diag);
      const ordered = candidates.filter(c => c.link);

      let localDetailHits = 0, localAcceptHits = 0;

      for (const c of ordered) {
        const detail = await fetchAppointmentsAndClassify(c.link, diag);
        localDetailHits++;

        if (detail.accepting && detail.usedAppointments) {
          localAcceptHits++; found++;

          // Notify all watchers subscribed to this postcode (radius is applied upstream in the NHS list call)
          const watchers = await usersWatching(pc);
          for (const u of watchers) {
            const key = notifiedKey(u.email, pc, c.name);
            const exists = await notifiedCol().findOne({ _id:key });
            if (exists) continue;

            const subject = `NHS dentist update: ${c.name} — accepting near ${pc}`;
            const body =
`Good news! ${c.name} is currently accepting new NHS patients for routine dental care near ${pc} (per NHS Appointments page).

Practice: ${c.name}
NHS profile: ${c.link}

Tip: Availability changes fast. Please call the practice to confirm before travelling.

— Dentist Radar`;
            await sendEmail(u.email, subject, body, "availability", { pc, practice:c.name, link:c.link, reason:detail.reason });

            await notifiedCol().updateOne(
              { _id:key },
              { $set: { email:u.email, pc, practice:c.name, link:c.link, at:new Date(), reason:detail.reason } },
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
      pcs: postcodes.length,
      distance: SEARCH_DISTANCE_MILES,
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

/* ---------- Debug helper ---------- */
export async function debugCandidateLinks(pc) {
  const diag = { calls: [], patternsHit: [], candidateCounts:{} };
  const fromHtml = await htmlCandidates(pc, diag);
  return fromHtml.map(c => c.link).filter(Boolean);
}

/* ---------- Compatibility exports ---------- */
export default runScan;
export { runScan as runscan };
export { runScan as run_scan };
