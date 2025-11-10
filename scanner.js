/**
 * DentistRadar Scanner v7.9
 * - Discovery tries YOUR confirmed NHS endpoints and paginates a few pages
 * - Triple-strategy link extraction:
 *     (1) Anchors  (CSS for /services/dentist/ and /services/dentists/)
 *     (2) JSON-LD  (itemListElement etc.)
 *     (3) Raw regex fallback across HTML text
 * - Appointments-only parsing
 * - Native fetch (Node 20+), Cheerio for parsing
 * - Fully compatible with server.js v1.8.7 (runScan({ postcode, includeChildOnly, radius? }))
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ------------------------------------------------------------------ */
/* CONFIG */
/* ------------------------------------------------------------------ */

const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);

const CACHE_DISC_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_DET_MS  = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);
const MAX_PAGES     = envInt("DR_MAX_DISCOVERY_PAGES", 3);

function envInt(k, d){ const n = parseInt(process.env[k] ?? d, 10); return Number.isNaN(n) ? d : n; }

/* ------------------------------------------------------------------ */
/* NORMALISATION */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* TTL CACHE */
/* ------------------------------------------------------------------ */

class TTLCache{
  constructor(){ this.map = new Map(); }
  get(k){ const h = this.map.get(k); if (!h) return; if (Date.now() > h.expires){ this.map.delete(k); return; } return h.value; }
  set(k,v,ttl){ this.map.set(k,{ value:v, expires:Date.now()+ttl }); }
}
const cache = new TTLCache();

/* ------------------------------------------------------------------ */
/* HTTP */
/* ------------------------------------------------------------------ */

async function fetchText(url, tries=0){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 DentistRadar/7.9",
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

/* ------------------------------------------------------------------ */
/* DISCOVERY URLS */
/* ------------------------------------------------------------------ */

function buildDiscoveryUrls(pc, radius){
  const base = "https://www.nhs.uk/service-search/find-a-dentist";
  const encPC = encodeURIComponent(pc);
  const encR  = encodeURIComponent(radius);
  return [
    `${base}/results/postcode=${encPC}&distance=${encR}`,      // your confirmed format
    `${base}/results?postcode=${encPC}&distance=${encR}`,      // query-style fallback
    `${base}/locationsearch/3?postcode=${encPC}&distance=${encR}` // legacy fallback
  ];
}

function injectPage(url, page){
  if (page <= 1) return [url];
  const hasQ = url.includes("?");
  const sep  = hasQ ? "&" : "?";
  // NHS sometimes uses 'page' or 'p'
  return [ `${url}${sep}page=${page}`, `${url}${sep}p=${page}` ];
}

/* ------------------------------------------------------------------ */
/* DISCOVERY STRATEGIES */
/* ------------------------------------------------------------------ */

function extractByAnchors($){
  const selector = 'a[href*="/services/dentist/"], a[href*="/services/dentists/"], a[href*="/services/dental-"]';
  const hrefs = $(selector).map((_,el)=>$(el).attr("href")).get();
  return hrefs.map(normalizeUrl).filter(Boolean);
}

function extractByJsonLd($){
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try{
      const data = JSON.parse(raw);
      // handle object or array of objects
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes){
        collectJsonLdUrls(node, out);
      }
    }catch{}
  });
  return out;
}

function collectJsonLdUrls(node, out){
  if (!node || typeof node !== "object") return;
  // Look for itemListElement, url, mainEntityOfPage, sameAs etc.
  if (Array.isArray(node.itemListElement)){
    for (const it of node.itemListElement){
      const url = normalizeUrl(it?.url || it?.item?.url);
      if (url && url.includes("/services/dentist/")) out.push(url);
    }
  }
  const direct = normalizeUrl(node.url || node.mainEntityOfPage);
  if (direct && direct.includes("/services/dentist/")) out.push(direct);

  // Recurse through properties
  for (const k of Object.keys(node)){
    const v = node[k];
    if (Array.isArray(v)) v.forEach(x => collectJsonLdUrls(x, out));
    else if (v && typeof v === "object") collectJsonLdUrls(v, out);
  }
}

function extractByRegex(html){
  const out = [];
  const rx = /https?:\/\/www\.nhs\.uk\/services\/dentist\/[A-Za-z0-9-/%?=_.]+/g;
  let m;
  while ((m = rx.exec(html)) !== null){
    out.push(m[0]);
  }
  return out;
}

function uniqStable(arr){
  const seen = new Set(); const out = [];
  for (const x of arr){ if (!seen.has(x)){ seen.add(x); out.push(x); } }
  return out;
}

async function discoverPracticeLinks(pc, radius){
  const bases = buildDiscoveryUrls(pc, radius);
  let all = [];

  for (const b of bases){
    for (let p=1; p<=MAX_PAGES; p++){
      const urls = injectPage(b, p);
      for (const u of urls){
        console.log(`[DISCOVERY_URL] ${u}`);
        const key = `DISC:${u}`;
        const cached = cache.get(key);
        if (cached){ if (cached.length) all = all.concat(cached); continue; }

        const html = await fetchText(u);
        const $ = cheerio.load(html);

        // 1) Anchor strategy
        const a1 = extractByAnchors($);

        // 2) JSON-LD strategy
        const a2 = extractByJsonLd($);

        // 3) Regex fallback
        const a3 = extractByRegex(html);

        const merged = uniqStable([...a1, ...a2, ...a3]);
        console.log(`[DISCOVERY_COUNTS] anchors=${a1.length} jsonld=${a2.length} regex=${a3.length} merged=${merged.length}`);

        cache.set(key, merged, CACHE_DISC_MS);

        if (merged.length){
          if (merged.length) console.log("[DISCOVERY_SAMPLE]", merged.slice(0,3));
          all = all.concat(merged);
        } else if (p > 1){
          break; // no more pages for this base
        }
      }
    }
    if (all.length) break; // stop at first base yielding results
  }

  return uniqStable(all);
}

/* ------------------------------------------------------------------ */
/* APPOINTMENTS PARSING */
/* ------------------------------------------------------------------ */

function extractAppointmentsHtml($){
  const sec = $("#appointments").first();
  if (sec && sec.length) return cheerio.load(sec.html() || "");

  const anchor = $("a").map((_, el) => $(el).attr("href") || "").get()
    .find((h) => h && h.includes("#appointments"));
  if (anchor){
    const node = $(anchor);
    if (node && node.length) return cheerio.load(node.html() || "");
  }
  return $;
}

const POSITIVE = [
  /currently\s*accept(?:ing)?\s*new\s*nhs\s*patients/gi,
  /accept(?:ing)?\s*new\s*nhs\s*patients/gi,
  /taking\s*new\s*nhs\s*patients/gi,
  /open\s*to\s*new\s*nhs\s*patients/gi,
  /we\s*are\s*taking\s*new\s*nhs\s*patients/gi,
];

const CHILD_ONLY = [
  /children\s*only/gi,
  /child(?:ren)?\s*only/gi,
  /nhs\s*patients.*(?:under|below)\s*\d+/gi,
  /only\s*accept(?:ing)?\s*(?:nhs\s*)?children/gi,
];

const NEGATIVE = [
  /not\s*accept(?:ing)?\s*new\s*nhs\s*patients/gi,
  /no\s*longer\s*accept(?:ing)?\s*nhs\s*patients/gi,
  /nhs\s*list\s*closed/gi,
  /we\s*are\s*not\s*taking\s*nhs\s*patients/gi,
];

function scanAppointmentsHtml($){
  const nodes = [
    ...$("section#appointments").toArray(),
    ...$("#appointments").toArray(),
    ...$("h2,h3,h4,p,li,div").toArray(),
  ];
  let text = "";
  for (const el of nodes){
    const s = cheerio.load(el).root().text();
    if (!s) continue;
    if (/appointment|register|accept|nhs|taking|list|join/i.test(s)) text += "\n" + s.trim();
  }
  const summary = text.replace(/\s+/g," ").trim();
  const positive = POSITIVE.some(rx => rx.test(summary));
  const childOnly = CHILD_ONLY.some(rx => rx.test(summary));
  const negative = NEGATIVE.some(rx => rx.test(summary));
  return { positive, childOnly, negative, excerpt: summary.slice(0, 400) };
}

/* ------------------------------------------------------------------ */
/* DETAIL */
/* ------------------------------------------------------------------ */

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

    const _$a = extractAppointmentsHtml($);
    const r   = scanAppointmentsHtml(_$a);

    let status = "unknown";
    if (r.negative && !r.positive) status = "not_accepting";
    else if (r.childOnly && !r.positive) status = "child_only";
    else if (r.positive && !r.negative) status = "accepting";
    else if (r.positive && r.childOnly) status = "child_only";
    else if (r.positive && r.negative) status = "mixed";

    return { url, title, status, excerpt: r.excerpt };
  } catch (e){
    return { url, title:"", status:"error", error: e?.message || String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* CONCURRENCY */
/* ------------------------------------------------------------------ */

async function mapLimit(arr, n, fn){
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array(Math.min(n, arr.length)).fill(0).map(async () => {
    while (true){
      const idx = i++; if (idx >= arr.length) return;
      try{ out[idx] = await fn(arr[idx], idx); }
      catch(e){ out[idx] = { status:"error", error:e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* PUBLIC API */
/* ------------------------------------------------------------------ */

export async function scanPostcode(pc, radiusMiles = 25){
  pc = coercePostcode(pc); radiusMiles = coerceRadius(radiusMiles);
  console.log(`DentistRadar v7.9`);
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

/* ------------------------------------------------------------------ */
/* CLI TEST */
/* ------------------------------------------------------------------ */

if (import.meta.url === `file://${process.argv[1]}`){
  const pc = coercePostcode(process.argv[2] || "RG41 4UW");
  const radius = coerceRadius(process.argv[3] || process.env.DEFAULT_RADIUS || process.env.SCAN_RADIUS || 25);
  runScan({ postcode: pc, radius, includeChildOnly: true })
    .then(r => console.log(JSON.stringify(r.summary, null, 2)))
    .catch(e => { console.error("[FATAL]", e?.message || e); process.exit(1); });
}
