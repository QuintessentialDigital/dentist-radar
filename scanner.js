/**
 * DentistRadar Scanner v8.4
 * - Discovery: confirmed NHS endpoints (+ fallbacks) with early-stop paging
 * - Detail links: /services/dentist/... (singular) + tolerant variants
 * - Acceptance parsing order:
 *    1) DOM tags: .nhsuk-tag (“Accepting new NHS patients” / “Not accepting…”)
 *    2) #appointments → “Who can use this service / Who can register” → next <ul><li> bullets (adults/children)
 *    3) Regex over #appointments (strict + loose, adult/child bullets)
 *    4) Regex over full page (strict negative precedence unless strict positive banner present)
 * - Per-practice debug shows which detector fired.
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
        "user-agent": "Mozilla/5.0 DentistRadar/8.4",
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

/* STRICT POSITIVE banner (dentist/dental practice) + variants */
const RX_STRICT_POS = /\bthis\s+(?:dentist|dental\s+practice)\s+(?:is\s+)?currently\s+accept(?:ing|s)?\s+new\s+nhs\s+patients\b/i;

/* Loose positive phrase (only used when no strict negative detected) */
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

/* NEGATIVE phrases (strict) */
const RX_NEG_STRICT = [
  /\bdoes\s+not\s+accept\s+new\s+nhs\s+patients\b/i,
  /\bnot\s+(?:currently\s+)?accept(?:ing|s)?\s+new\s+nhs\s+patients\b/i,
  /\bno\s+capacity\s+for\s+nhs\s+patients\b/i,
  /\bnhs\s+list\s+closed\b/i,
  /\bwe\s+are\s+not\s+taking\s+nhs\s+patients\b/i,
  /\bwe\s+do\s+not\s+provide\s+nhs\s+dental\s+treatment\b/i
];

function some(rxList, text){ return rxList.some(rx => rx.test(text)); }

/* 1) DOM TAGS: look for NHS status chips */
function parseByTags($){
  const tags = $('.nhsuk-tag').map((_,el)=> cheerio.load(el).root().text().trim().toLowerCase()).get();
  if (!tags.length) return null;

  const joined = tags.join(" | ");
  const neg = /\bnot\s+accept(?:ing|s)?\s+new\s+nhs\s+patients\b/.test(joined) || /\bnhs\s+list\s+closed\b/.test(joined);
  const pos = /\baccept(?:ing|s)?\s+new\s+nhs\s+patients\b/.test(joined);

  if (neg && !pos) return { status:"not_accepting", reason:"tag_negative", text: joined };
  if (pos && !neg) return { status:"accepting", reason:"tag_positive", text: joined };

  // tags contradictory → let deeper checks decide
  return null;
}

/* Helper: from a heading element, get the next UL (skipping non-ul siblings) */
function nextUl($, $start){
  let n = $start.next();
  for (let i=0; i<6 && n && n.length; i++){
    if (n.is("ul")) return n;
    n = n.next();
  }
  return null;
}

/* 2) STRUCTURED APPOINTMENTS: “Who can use this service / Who can register” bullets */
function parseAppointmentsStructured($){
  const $ap = $("#appointments");
  if (!$ap.length) return null;

  const headingSel = 'h2,h3,h4';
  let adult = false, child = false;

  $ap.find(headingSel).each((_, el) => {
    const t = cheerio.load(el).root().text().trim().toLowerCase();
    if (/who\s+can\s+(use|register)/i.test(t)){
      const $ul = nextUl($, cheerio.load(el).root());
      if ($ul && $ul.length){
        const lis = $ul.find("li").map((__, li) => cheerio.load(li).root().text().trim()).get();
        for (const li of lis){
          const s = li.replace(/\s+/g," ");
          if (some(RX_ADULT_POS, s)) adult = true;
          if (some(RX_CHILD_POS, s)) child = true;
        }
      }
    }
  });

  if (adult || child){
    // determine positive/negative context from the same section text
    const secText = textify($ap);
    const strictPos = RX_STRICT_POS.test(secText) || RX_LOOSE_POS.test(secText);
    const negative  = some(RX_NEG_STRICT, secText);

    if (strictPos || (!negative && (adult || child))){
      if (adult) return { status:"accepting", reason:"appointments_structured_adult", text: textify($ap) };
      return { status:"child_only", reason:"appointments_structured_child", text: textify($ap) };
    }
    if (negative && !adult) return { status:"not_accepting", reason:"appointments_structured_negative", text: textify($ap) };
  }

  return null;
}

/* 3) REGEX over #appointments (fallback) */
function parseAppointmentsRegex($){
  const $ap = $("#appointments");
  if (!$ap.length) return null;

  const txt = textify($ap);
  const strictPos = RX_STRICT_POS.test(txt);
  const loosePos  = RX_LOOSE_POS.test(txt);
  const adultPos  = some(RX_ADULT_POS, txt);
  const childPos  = some(RX_CHILD_POS, txt);
  const negative  = some(RX_NEG_STRICT, txt);

  if (strictPos){
    if (adultPos) return { status:"accepting", reason:"appointments_strict+adult", text: txt };
    if (!adultPos && childPos) return { status:"child_only", reason:"appointments_strict+child", text: txt };
    return { status:"accepting", reason:"appointments_strict_only", text: txt };
  }
  if (negative && !strictPos){
    if (!adultPos && childPos) return { status:"child_only", reason:"appointments_neg+child_only", text: txt };
    return { status:"not_accepting", reason:"appointments_negative", text: txt };
  }
  if (loosePos){
    if (adultPos) return { status:"accepting", reason:"appointments_loose+adult", text: txt };
    if (!adultPos && childPos) return { status:"child_only", reason:"appointments_loose+child", text: txt };
    return { status:"accepting", reason:"appointments_loose_only", text: txt };
  }

  return null;
}

/* 4) PAGE-WIDE regex (last resort) */
function parseWholePage($){
  const txt = textify($.root());
  const strictPos = RX_STRICT_POS.test(txt);
  const loosePos  = RX_LOOSE_POS.test(txt);
  const adultPos  = some(RX_ADULT_POS, txt);
  const childPos  = some(RX_CHILD_POS, txt);
  const negative  = some(RX_NEG_STRICT, txt);

  if (strictPos){
    if (adultPos) return { status:"accepting", reason:"page_strict+adult", text: txt };
    if (!adultPos && childPos) return { status:"child_only", reason:"page_strict+child", text: txt };
    return { status:"accepting", reason:"page_strict_only", text: txt };
  }
  if (negative && !strictPos){
    if (!adultPos && childPos) return { status:"child_only", reason:"page_neg+child_only", text: txt };
    return { status:"not_accepting", reason:"page_negative", text: txt };
  }
  if (loosePos){
    if (adultPos) return { status:"accepting", reason:"page_loose+adult", text: txt };
    if (!adultPos && childPos) return { status:"child_only", reason:"page_loose+child", text: txt };
    return { status:"accepting", reason:"page_loose_only", text: txt };
  }

  return { status:"unknown", reason:"page_inconclusive", text: txt };
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

    // 1) NHS status tags
    let r = parseByTags($);

    // 2) Structured appointments lists
    if (!r) r = parseAppointmentsStructured($);

    // 3) Appointments regex fallback
    if (!r) r = parseAppointmentsRegex($);

    // 4) Full page fallback
    if (!r) r = parseWholePage($);

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
  console.log(`DentistRadar v8.4`);
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
  const mixed        = results.filter(x => x.status === "mixed"); // unlikely
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
