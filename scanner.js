/**
 * DentistRadar Scanner v8.2
 * - Discovery:
 *    /results/postcode=PC&distance=R (confirmed by you)
 *    /results?postcode=PC&distance=R (fallback)
 *    /locationsearch/3?postcode=PC&distance=R (fallback)
 *   with pagination that EARLY-STOPS when a page yields no new links.
 * - Detail links: /services/dentist/... (singular) + tolerant variants.
 * - Acceptance parsing (Appointments-first, Full-page fallback):
 *    • Detects “This dentist currently accepts new NHS patients …”
 *    • Adults/Children bullets (e.g., “adults aged 18 or over”, “children 17 or under”)
 *    • Strict negatives (not accepting / list closed / no capacity)
 * - Logs concise debug line per practice: title, status, reason.
 * - Native fetch (Node 20+), Cheerio only. Compatible with server.js v1.8.7.
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ------------------------------ Config ------------------------------ */
const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);
const CACHE_DISC_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_DET_MS  = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);
const MAX_PAGES     = envInt("DR_MAX_DISCOVERY_PAGES", 3);

function envInt(k, d){ const n = parseInt(process.env[k] ?? d, 10); return Number.isNaN(n) ? d : n; }

/* --------------------------- Normalisation -------------------------- */
function coercePostcode(x){
  let raw = x;
  if (typeof raw === "object" && raw !== null) raw = raw.value ?? raw.postcode ?? JSON.stringify(raw);
  raw = String(raw ?? "").trim();
  if (!raw) return "";
  const up = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const compact = up.replace(/\s+/g, "");
  if (!up.includes(" ") && compact.length >= 5) return compact.slice(0, -3) + " " + compact.slice(-3);
  return up;
}
function coerceRadius(x, def=25){
  let r = x; if (typeof r === "object" && r !== null) r = r.value ?? r.radius;
  r = parseInt(r ?? def, 10); if (Number.isNaN(r)) return def;
  return Math.max(1, Math.min(100, r));
}

/* -------------------------------- Cache ----------------------------- */
class TTLCache{
  constructor(){ this.map = new Map(); }
  get(k){ const h = this.map.get(k); if (!h) return; if (Date.now() > h.expires){ this.map.delete(k); return; } return h.value; }
  set(k,v,ttl){ this.map.set(k,{ value:v, expires:Date.now()+ttl }); }
}
const cache = new TTLCache();

/* -------------------------------- HTTP ------------------------------ */
async function fetchText(url, tries=0){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 DentistRadar/8.2",
        "accept-language": "en-GB,en;q=0.9",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e){
    if (tries < 2){ await sleep(120 + Math.random()*240); return fetchText(url, tries+1); }
    return "";
  } finally { clearTimeout(timer); }
}
function normalizeUrl(h){
  if (!h) return null;
  if (h.startsWith("http")) return h;
  if (h.startsWith("//"))  return `https:${h}`;
  if (h.startsWith("/"))   return `https://www.nhs.uk${h}`;
  return null;
}

/* -------------------------- Discovery URLs -------------------------- */
function buildDiscoveryUrls(pc, radius){
  const base = "https://www.nhs.uk/service-search/find-a-dentist";
  const encPC = encodeURIComponent(pc);
  const encR  = encodeURIComponent(radius);
  return [
    `${base}/results/postcode=${encPC}&distance=${encR}`,         // confirmed by you
    `${base}/results?postcode=${encPC}&distance=${encR}`,         // query fallback
    `${base}/locationsearch/3?postcode=${encPC}&distance=${encR}` // legacy fallback
  ];
}
function injectPage(url, page){
  if (page <= 1) return [url];
  const hasQ = url.includes("?");
  const sep  = hasQ ? "&" : "?";
  return [ `${url}${sep}page=${page}`, `${url}${sep}p=${page}` ];
}

/* ----------------------- Discovery (with early stop) ---------------- */
function extractPracticeLinks(html){
  if (!html) return [];
  const $ = cheerio.load(html);
  const selector = 'a[href*="/services/dentist/"], a[href*="/services/dentists/"], a[href*="/services/dental-"]';
  const raw = $(selector).map((_, el) => $(el).attr("href")).get().map(normalizeUrl).filter(Boolean);
  const seen = new Set(); const out = [];
  for (const u of raw){ if (!seen.has(u)){ seen.add(u); out.push(u); } }
  if (out.length) console.log("[DISCOVERY_SAMPLE]", out.slice(0,3));
  return out;
}
async function discoverPracticeLinks(pc, radius){
  const bases = buildDiscoveryUrls(pc, radius);
  const globalSeen = new Set();
  let all = [];
  for (const b of bases){
    let baseAdded = 0;
    for (let p=1; p<=MAX_PAGES; p++){
      const urls = injectPage(b, p);
      let pageAdded = 0;
      for (const u of urls){
        console.log(`[DISCOVERY_URL] ${u}`);
        const key = `DISC:${u}`;
        const cached = cache.get(key);
        let links;
        if (cached){ links = cached; }
        else {
          const html  = await fetchText(u);
          links = extractPracticeLinks(html);
          cache.set(key, links, CACHE_DISC_MS);
        }
        for (const link of links){
          if (!globalSeen.has(link)){
            globalSeen.add(link);
            all.push(link);
            baseAdded++; pageAdded++;
          }
        }
      }
      if (p > 1 && pageAdded === 0) break; // early stop for this base
    }
    if (baseAdded > 0) break; // stop at first base that yields
  }
  return all;
}

/* ----------------------- Acceptance parsing ------------------------ */
function textify($root){ return ($root.text() || "").replace(/\s+/g," ").trim(); }

/* explicit anchors inside Appointments */
const RX_GENERIC_ACCEPT = /\bthis\s+dentist\s+currently\s+accepts?\s+new\s+nhs\s+patients\b/i;
const RX_ACCEPTING      = /\baccept(?:ing)?\s+new\s+nhs\s+patients\b/i;

const RX_ADULT_POS = [
  /\badults?\s+(?:aged\s*)?(?:18|1[89]|[2-9]\d)\s*(?:\+|or\s+over)?\b/i,
  /\badults?\s+entitled\s+to\s+free\s+routine\s+dental\s+care\b/i,
  /\badult\s+nhs\s+patients?\b/i
];
const RX_CHILD_POS = [
  /\bchildren\s+(?:aged\s*)?(?:\d{1,2}\s*or\s*under|under\s*18|1?\d\s*or\s*under|17\s*or\s*under)\b/i,
  /\bchild(?:ren)?\s+nhs\s+patients?\b/i,
  /\bchildren\s+only\b/i,
  /\bonly\s+accept(?:ing)?\s+(?:nhs\s+)?children\b/i
];

const RX_NEG_STRICT = [
  /\bnot\s+(?:currently\s+)?accept(?:ing)?\s+new\s+nhs\s+patients\b/i,
  /\bnhs\s+list\s+closed\b/i,
  /\bwe\s+are\s+not\s+taking\s+nhs\s+patients\b/i,
  /\bno\s+capacity\s+for\s+nhs\s+patients\b/i,
  /\bwe\s+do\s+not\s+provide\s+nhs\s+dental\s+treatment\b/i
];

function someMatch(rxList, text){ return rxList.some(rx => rx.test(text)); }

/** Parse #appointments with structure awareness (lists/bullets) */
function parseAppointments($){
  const $sec = $("#appointments").first();
  if (!$sec.length) return null;

  const text = textify($sec);
  const generic = RX_GENERIC_ACCEPT.test(text) || RX_ACCEPTING.test(text);
  const adult   = someMatch(RX_ADULT_POS, text);
  const child   = someMatch(RX_CHILD_POS, text);
  const negative= someMatch(RX_NEG_STRICT, text);

  // Prefer explicit Appointments logic
  if (generic && adult) return { status:"accepting", reason:"appointments_generic+adult", text };
  if (generic && !adult && child) return { status:"child_only", reason:"appointments_generic+child", text };
  if (!generic && child && !adult) return { status:"child_only", reason:"appointments_child_only", text };
  if (negative && !generic) return { status:"not_accepting", reason:"appointments_negative", text };

  // Inconclusive
  return { status:"unknown", reason:"appointments_inconclusive", text };
}

/** Fallback: scan the whole page */
function parseWholePage($){
  const text = textify($.root());
  const generic = RX_GENERIC_ACCEPT.test(text) || RX_ACCEPTING.test(text);
  const adult   = someMatch(RX_ADULT_POS, text);
  const child   = someMatch(RX_CHILD_POS, text);
  const negative= someMatch(RX_NEG_STRICT, text);

  if (generic && adult) return { status:"accepting", reason:"page_generic+adult", text };
  if (generic && !adult && child) return { status:"child_only", reason:"page_generic+child", text };
  if (!generic && child && !adult && !negative) return { status:"child_only", reason:"page_child_only", text };
  if (negative && !generic) return { status:"not_accepting", reason:"page_negative", text };
  if (generic) return { status:"accepting", reason:"page_generic_only", text };

  return { status:"unknown", reason:"page_inconclusive", text };
}

/* ------------------------------ Detail ----------------------------- */
async function fetchDetailHtml(url){
  const key = `DET:${url}`; const c = cache.get(key); if (c) return c;
  await sleep(40 + Math.random()*60);
  const html = await fetchText(url);
  cache.set(key, html, CACHE_DET_MS);
  return html;
}

async function evaluatePractice(url){
  try{
    const html = await fetchDetailHtml(url);
    if (!html) return { url, title:"", status:"error", error:"empty_html" };

    const $ = cheerio.load(html);
    const title =
      $("h1.nhsuk-heading-l").first().text().trim() ||
      $("h1").first().text().trim() || "";

    // 1) Appointments-first
    let r = parseAppointments($);

    // 2) Fallback to full page if unknown
    if (!r || r.status === "unknown") {
      r = parseWholePage($);
    }

    // Debug (compact): shows why a status was chosen
    console.log(`[DETAIL] ${title ? title.slice(0,60) : "(no title)"} → ${r.status} (${r.reason})`);

    return { url, title, status: r.status, excerpt: (r.text || "").slice(0, 400) };
  } catch (e){
    return { url, title:"", status:"error", error: e?.message || String(e) };
  }
}

/* ---------------------------- Concurrency -------------------------- */
async function mapLimit(arr, n, fn){
  const out = new Array(arr.length); let i = 0;
  const workers = Array(Math.min(n, arr.length)).fill(0).map(async () => {
    while (true){ const idx = i++; if (idx >= arr.length) return;
      try{ out[idx] = await fn(arr[idx], idx); } catch(e){ out[idx] = { status:"error", error:e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------ Public ----------------------------- */
export async function scanPostcode(pc, radiusMiles = 25){
  pc = coercePostcode(pc); radiusMiles = coerceRadius(radiusMiles);
  console.log(`DentistRadar v8.2`);
  console.log(`--- Scan: ${pc || "(empty)"} (${radiusMiles} miles) ---`);

  if (!pc){
    return { ok:true, summary:{ postcode:"", radiusMiles, accepting:0, childOnly:0, notAccepting:0, mixed:0, scanned:0, tookMs:0 }, accepting:[], childOnly:[], errors:[] };
  }

  const t0 = Date.now();
  const links = await discoverPracticeLinks(pc, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${links.length}`);

  if (!links.length){
    return { ok:true, summary:{ postcode:pc, radiusMiles, accepting:0, childOnly:0, notAccepting:0, mixed:0, scanned:0, tookMs:Date.now()-t0 }, accepting:[], childOnly:[], errors:[] };
  }

  const target  = links.slice(0, MAX_PRACTICES);
  const results = await mapLimit(target, CONCURRENCY, evaluatePractice);

  const accepting    = results.filter(x => x.status === "accepting");
  const childOnly    = results.filter(x => x.status === "child_only");
  const notAccepting = results.filter(x => x.status === "not_accepting");
  const mixed        = results.filter(x => x.status === "mixed"); // unlikely now
  const errors       = results.filter(x => x.status === "error");

  const summary = {
    postcode: pc,
    radiusMiles,
    accepting: accepting.length,
    childOnly: childOnly.length,
    notAccepting: notAccepting.length,
    mixed: mixed.length,
    scanned: results.length,
    tookMs: Date.now() - t0
  };

  return {
    ok: true,
    summary,
    accepting: accepting.map(x => ({ url:x.url, title:x.title, excerpt:x.excerpt })),
    childOnly: childOnly.map(x => ({ url:x.url, title:x.title, excerpt:x.excerpt })),
    errors
  };
}

export async function runScan(argsOrString){
  const args = typeof argsOrString === "string" ? { postcode: argsOrString } : (argsOrString || {});
  const pc     = coercePostcode(args.postcode);
  const radius = coerceRadius(args.radius ?? process.env.DEFAULT_RADIUS ?? process.env.SCAN_RADIUS ?? 25);
  const includeChildOnly = !!args.includeChildOnly;

  const base = await scanPostcode(pc, radius);

  return {
    ok: true,
    checked: base.summary.scanned,
    found: base.accepting.length + (includeChildOnly ? base.childOnly.length : 0),
    alertsSent: 0,
    summary: base.summary,
    accepting: base.accepting,
    childOnly: includeChildOnly ? base.childOnly : [],
    errors: base.errors
  };
}

export default scanPostcode;

/* --------------------------------- CLI ----------------------------- */
if (import.meta.url === `file://${process.argv[1]}`){
  const pc = coercePostcode(process.argv[2] || "RG41 4UW");
  const radius = coerceRadius(process.argv[3] || process.env.DEFAULT_RADIUS || process.env.SCAN_RADIUS || 25);
  runScan({ postcode: pc, radius, includeChildOnly: true })
    .then(r => console.log(JSON.stringify(r.summary, null, 2)))
    .catch(e => { console.error("[FATAL]", e?.message || e); process.exit(1); });
}
