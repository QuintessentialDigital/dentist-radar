/**
 * DentistRadar Scanner v8.7
 * - Discovery unchanged (confirmed NHS endpoints + fallbacks, early-stop)
 * - Classification order (for BOTH main and /appointments pages):
 *    1) NHS status tags (.nhsuk-tag) → accept / not accept
 *    2) Structured headings (“Who can use/register this service” and variants)
 *       → next <ul><li> → adults / children
 *    3) Regex over scoped section
 *    4) Regex over whole page
 * - Broadened containers searched: #appointments, .nhsuk-accordion, .nhsuk-card,
 *   .nhsuk-details, main, article
 * - Expanded negatives & positives, robust whitespace normalisation
 * - /appointments page fetched with Referer
 * - Clear debug for unknown pages (content length + sample)
 * - Node 20+ native fetch, Cheerio; compatible with server.js v1.8.7
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ------------------------------ Config ------------------------------ */
const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);
const CACHE_DISC_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_DET_MS  = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);
const CACHE_APPT_MS = envInt("DR_CACHE_TTL_APPT_MS",      2 * 60 * 60 * 1000);
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
function cleanText(s){
  return (s || "")
    .replace(/\u00A0/g, " ")                 // nbsp
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // smart quotes
    .replace(/[•·▪‣]/g, "-")                 // bullets to dash
    .replace(/\s+/g, " ")
    .trim();
}
function textify($root){ return cleanText($root.text()); }

/* ------------------------------- HTTP ------------------------------- */
function buildHeaders(referer = ""){
  return {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) DentistRadar/8.7",
    "accept-language": "en-GB,en;q=0.9",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "cache-control": "no-cache",
    "pragma": "no-cache",
    ...(referer ? { "referer": referer } : {})
  };
}
async function fetchText(url, tries=0, referer=""){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: buildHeaders(referer) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e){
    if (tries < 2){ await sleep(150 + Math.random()*250); return fetchText(url, tries+1, referer); }
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

/* ------------------------------ Discovery -------------------------- */
function buildDiscoveryUrls(pc, radius){
  const base = "https://www.nhs.uk/service-search/find-a-dentist";
  const encPC = encodeURIComponent(pc);
  const encR  = encodeURIComponent(radius);
  return [
    `${base}/results/postcode=${encPC}&distance=${encR}`,         // confirmed
    `${base}/results?postcode=${encPC}&distance=${encR}`,         // fallback
    `${base}/locationsearch/3?postcode=${encPC}&distance=${encR}` // legacy fallback
  ];
}
function injectPage(url, page){
  if (page <= 1) return [url];
  const hasQ = url.includes("?");
  const sep  = hasQ ? "&" : "?";
  return [ `${url}${sep}page=${page}`, `${url}${sep}p=${page}` ];
}
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
      if (p > 1 && pageAdded === 0) break; // early stop
    }
    if (baseAdded > 0) break; // stop at first base that yields
  }
  return all;
}

/* -------------------------- Pattern Libraries ---------------------- */
/* STRICT positive banner (more variants) */
const RX_STRICT_POS = /\bthis\s+(?:service|practice|dentist|dental\s+practice)\s+(?:is\s+)?currently\s+accept(?:ing|s)?\s+new\s+nhs\s+patients\b/i;
/* Loose positive (gated by absence of negatives) */
const RX_LOOSE_POS  = /\b(?:is\s+)?currently\s+accept(?:ing|s)?\s+new\s+nhs\s+patients\b/i;
/* Adult/Child bullets */
const RX_ADULT_POS = [
  /\badults?\s+(?:aged\s*)?(?:18|1[89]|[2-9]\d)\s*(?:\+|or\s+over)?\b/i,
  /\badults?\s+entitled\s+to\s+free\s+routine\s+dental\s+care\b/i,
  /\badult\s+nhs\s+patients?\b/i
];
const RX_CHILD_POS = [
  /\bchildren\s+(?:aged\s*)?(?:\d{1,2}\s*or\s*under|under\s*18|1?\d\s*or\s*under|17\s*or\s*under)\b/i,
  /\bchild(?:ren)?\s+nhs\s+patients?\b/i,
  /\bchildren\s+only\b/i,
  /\bonly\s+accept(?:ing|s)?\s+(?:nhs\s+)?children\b/i
];
/* NEGATIVE phrases (expanded) */
const RX_NEG_STRICT = [
  /\bdoes\s+not\s+(?:currently\s+)?accept\s+new\s+nhs\s+patients\b/i,
  /\bnot\s+(?:currently\s+)?accept(?:ing|s)?\s+new\s+nhs\s+patients\b/i,
  /\bno\s+capacity\s+for\s+nhs\s+patients\b/i,
  /\bnhs\s+list\s+closed\b/i,
  /\bwe\s+are\s+not\s+taking\s+nhs\s+patients\b/i,
  /\bwe\s+do\s+not\s+provide\s+nhs\s+dental\s+treatment\b/i,
  /\bwe(?:\s*are|'re)?\s*currently\s*unable\s*to\s*accept\s*new\s*nhs\s*patients\b/i,
  /\bclosed\s*to\s*new\s*nhs\s*patients\b/i
];

const WHO_HEADINGS_RX = /who\s+can\s+(use|register)|who\s+can\s+use\s+this\s+service|who\s+can\s+get\s+routine\s+nhs\s+dental\s+care/i;
const CONTAINERS = ['#appointments', '.nhsuk-accordion', '.nhsuk-card', '.nhsuk-details', 'main', 'article'];

function some(rxList, text){ return rxList.some(rx => rx.test(text)); }

/* NHS status chips */
function parseByTags($){
  const tags = $('.nhsuk-tag').map((_,el)=> cleanText(cheerio.load(el).root().text()).toLowerCase()).get();
  if (!tags.length) return null;
  const joined = tags.join(" | ");
  const neg = /\bnot\s+accept(?:ing|s)?\s+new\s+nhs\s+patients\b/.test(joined) || /\bnhs\s+list\s+closed\b/.test(joined) || /\bclosed\s*to\s*new\s*nhs\s*patients\b/.test(joined);
  const pos = /\baccept(?:ing|s)?\s+new\s+nhs\s+patients\b/.test(joined);
  if (neg && !pos) return { status:"not_accepting", reason:"tag_negative", text: joined };
  if (pos && !neg) return { status:"accepting", reason:"tag_positive", text: joined };
  return null;
}

/* Find the next <ul> after a heading */
function nextUl($, $start){
  let n = $start.next();
  for (let i=0; i<10 && n && n.length; i++){
    if (n.is("ul")) return n;
    n = n.next();
  }
  return null;
}

/* Structured bullets search across multiple containers */
function parseStructuredAnywhere($){
  for (const sel of CONTAINERS) {
    const root = $(sel);
    if (!root.length) continue;
    const hSel = 'h2,h3,h4';
    let adult=false, child=false, seen=false;

    root.find(hSel).each((_, el) => {
      const t = cleanText($(el).text()).toLowerCase();
      if (!WHO_HEADINGS_RX.test(t)) return;
      const $ul = nextUl($, $(el));
      if ($ul && $ul.length){
        $ul.find("li").each((__, li) => {
          const s = cleanText($(li).text());
          seen = true;
          if (some(RX_ADULT_POS, s)) adult = true;
          if (some(RX_CHILD_POS, s)) child = true;
        });
      }
    });

    if (seen) {
      const txt = textify(root);
      if (adult) return { status:'accepting', reason:`structured_any_adult@${sel}`, text: txt };
      if (!adult && child) return { status:'child_only', reason:`structured_any_child@${sel}`, text: txt };
      // if seen but no signals, fall through to regex
      const txt2 = textify(root);
      const analyzed = analyzeText(txt2, `structured_any@${sel}`);
      if (analyzed.status !== 'unknown') return analyzed;
    }
  }
  return null;
}

/* Analyze a text with precedence rules */
function analyzeText(text, scope){
  const strictPos = RX_STRICT_POS.test(text);
  const loosePos  = RX_LOOSE_POS.test(text);
  const adultPos  = some(RX_ADULT_POS, text);
  const childPos  = some(RX_CHILD_POS, text);
  const negative  = some(RX_NEG_STRICT, text);

  if (strictPos){
    if (adultPos) return { status:"accepting", reason:`${scope}_strict+adult`, text };
    if (!adultPos && childPos) return { status:"child_only", reason:`${scope}_strict+child`, text };
    return { status:"accepting", reason:`${scope}_strict_only`, text };
  }
  if (negative){
    if (!adultPos && childPos) return { status:"child_only", reason:`${scope}_neg+child_only`, text };
    return { status:"not_accepting", reason:`${scope}_negative`, text };
  }
  if (loosePos){
    if (adultPos) return { status:"accepting", reason:`${scope}_loose+adult`, text };
    if (!adultPos && childPos) return { status:"child_only", reason:`${scope}_loose+child`, text };
    return { status:"accepting", reason:`${scope}_loose_only`, text };
  }
  return { status:"unknown", reason:`${scope}_inconclusive`, text };
}

/* Parse a cheerio document: tags → structured-anywhere → regex on #appointments → regex on page */
function parseCheerio($, scopeLabel){
  // 1) NHS status tags
  const t = parseByTags($);
  if (t) return t;

  // 2) Structured bullets in many containers
  const structured = parseStructuredAnywhere($);
  if (structured) return structured;

  // 3) Regex over #appointments if present
  const $ap = $("#appointments");
  if ($ap.length){
    const ar = analyzeText(textify($ap), `${scopeLabel}_appointments`);
    if (ar.status !== "unknown") return ar;
  }

  // 4) Regex over whole page
  return analyzeText(textify($.root()), `${scopeLabel}_page`);
}

/* ------------------------------ Detail ----------------------------- */
async function fetchDetailHtml(url){
  const key = `DET:${url}`; const c = cache.get(key); if (c) return c;
  await sleep(40 + Math.random()*60);
  const html = await fetchText(url);
  cache.set(key, html, CACHE_DET_MS);
  return html;
}
async function fetchAppointmentsHtml(url){
  const apptUrl = url.endsWith("/") ? `${url}appointments` : `${url}/appointments`;
  const key = `APPT:${apptUrl}`; const c = cache.get(key); if (c) return { html: c, url: apptUrl };
  await sleep(30 + Math.random()*50);
  const html = await fetchText(apptUrl, 0, url /* Referer */);
  cache.set(key, html, CACHE_APPT_MS);
  return { html, url: apptUrl };
}

function extractTitle($){
  return $("h1.nhsuk-heading-l").first().text().trim() || $("h1").first().text().trim() || "";
}
function extractTitleFromUrl(u){
  try{
    const seg = new URL(u).pathname.split("/").filter(Boolean);
    const name = seg[seg.length-2] || "";
    return decodeURIComponent(name).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }catch{ return ""; }
}

async function evaluatePractice(url){
  try{
    // 1) Try /appointments FIRST
    const { html: apptHtml, url: apptUrl } = await fetchAppointmentsHtml(url);
    if (apptHtml){
      const $a = cheerio.load(apptHtml);
      const ra = parseCheerio($a, "APPT");
      if (ra && ra.status !== "unknown"){
        console.log(`[DETAIL] (APPT) → ${ra.status} (${ra.reason}) ${apptUrl}`);
        return { url, title: extractTitle($a) || extractTitleFromUrl(url), status: ra.status, excerpt: (ra.text || "").slice(0, 400) };
      } else {
        const t = textify($a.root());
        console.log(`[DETAIL] (APPT) → unknown (${ra ? ra.reason : "no_parse"}) len=${t.length} url=${apptUrl}`);
        if (t.length < 800) console.log("[DEBUG_SAMPLE_APPT]", t.slice(0, 300));
      }
    } else {
      console.log(`[DETAIL] (APPT) → empty ${url}/appointments`);
    }

    // 2) Fall back to MAIN detail page
    const mainHtml = await fetchDetailHtml(url);
    if (!mainHtml) return { url, title:"", status:"error", error:"empty_html" };
    const $ = cheerio.load(mainHtml);

    const rm = parseCheerio($, "MAIN");
    const title = extractTitle($) || extractTitleFromUrl(url);
    if (rm.status === "unknown"){
      const all = textify($.root());
      console.log(`[DETAIL] (MAIN) → unknown (${rm.reason}) len=${all.length} url=${url}`);
      if (all.length < 1200) console.log("[DEBUG_SAMPLE_MAIN]", all.slice(0, 400));
    } else {
      console.log(`[DETAIL] (MAIN) → ${rm.status} (${rm.reason}) ${url}`);
    }
    return { url, title, status: rm.status, excerpt: (rm.text || "").slice(0, 400) };

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
  console.log(`DentistRadar v8.7`);
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
  const mixed        = results.filter(x => x.status === "mixed");
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

/* --------------------------------- Cache ---------------------------- */
class TTLCache{
  constructor(){ this.map = new Map(); }
  get(k){ const h = this.map.get(k); if (!h) return; if (Date.now() > h.expires){ this.map.delete(k); return; } return h.value; }
  set(k,v,ttl){ this.map.set(k,{ value:v, expires:Date.now()+ttl }); }
}
const cache = new TTLCache();

/* --------------------------------- CLI ------------------------------ */
if (import.meta.url === `file://${process.argv[1]}`){
  const pc = coercePostcode(process.argv[2] || "RG41 4UW");
  const radius = coerceRadius(process.env.DEFAULT_RADIUS || process.env.SCAN_RADIUS || 25);
  runScan({ postcode: pc, radius, includeChildOnly: true })
    .then(r => console.log(JSON.stringify(r.summary, null, 2)))
    .catch(e => { console.error("[FATAL]", e?.message || e); process.exit(1); });
}
