/**
 * DentistRadar Scanner v7.5
 * - Compatible with server.js v1.8.7: runScan({ postcode, includeChildOnly, radius? })
 * - Discovery tries multiple NHS endpoints + simple pagination
 * - Robust selectors: any <a href*="/services/dentists/">
 * - Appointments-only parsing; native fetch; no extra deps
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ----------------------------- Tunables ----------------------------- */
const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);
const CACHE_TTL_DISCOVERY_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_TTL_DETAIL_MS    = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);
const MAX_DISCOVERY_PAGES    = envInt("DR_MAX_DISCOVERY_PAGES", 3); // paginate results?p=2,3,...

function envInt(k, d){ const v=parseInt(process.env[k]||`${d}`,10); return Number.isNaN(v)?d:v; }

/* ----------------------------- Input guards ----------------------------- */
function coercePostcode(input){
  let raw = input;
  if (typeof raw === "object" && raw !== null) raw = raw.value ?? raw.postcode ?? JSON.stringify(raw);
  raw = String(raw ?? "").trim();
  const normal = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normal) return "";
  const compact = normal.replace(/\s+/g,"");
  if (!normal.includes(" ") && compact.length >= 5) return compact.slice(0, compact.length - 3) + " " + compact.slice(-3);
  return normal;
}
function coerceRadius(input, def=25){
  let r = input; if (typeof r === "object" && r !== null) r = r.value ?? r.radius;
  const n = parseInt(r ?? def, 10); if (Number.isNaN(n)) return def;
  return Math.max(1, Math.min(100, n));
}

/* ----------------------------- TTL Cache ----------------------------- */
class TTLCache{ constructor(){this.store=new Map();} get(k){const h=this.store.get(k); if(!h)return; if(Date.now()>h.expires){this.store.delete(k); return;} return h.value;} set(k,v,ttl){this.store.set(k,{value:v,expires:Date.now()+ttl});}}
const cache=new TTLCache();

/* ----------------------------- HTTP helpers ----------------------------- */
async function fetchText(url, tries=0){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),TIMEOUT_MS);
  try{
    const r=await fetch(url,{
      method:"GET", redirect:"follow", signal:ctrl.signal,
      headers:{
        "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 DentistRadar/7.5",
        "accept-language":"en-GB,en;q=0.9",
        "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch(e){
    if (tries < 2){ await sleep(120 + Math.random()*240); return fetchText(url, tries+1); }
    return "";
  } finally { clearTimeout(t); }
}

function normalizeUrl(h){ if(!h) return null; if(h.startsWith("http")) return h; if(h.startsWith("//")) return `https:${h}`; if(h.startsWith("/")) return `https://www.nhs.uk${h}`; return null; }

/* ----------------------------- Discovery ----------------------------- */
/**
 * New strategy:
 *  - Try multiple endpoints, in order.
 *  - For each endpoint, try simple pagination: page=1..MAX_DISCOVERY_PAGES (handles ?page or ?p in url)
 *  - Use broad selector: a[href*="/services/dentists/"]
 */
function buildDiscoveryCandidates(postcode, radius){
  const base = "https://www.nhs.uk/service-search/find-a-dentist";
  const qs = (p, r) => `?postcode=${encodeURIComponent(p)}&distance=${encodeURIComponent(r)}`;
  return [
    // previously-seen paths
    `${base}/results${qs(postcode, radius)}`,
    `${base}/locationsearch/3${qs(postcode, radius)}`,
  ];
}

function injectPageParam(url, page){
  if (page <= 1) return url;
  // Try to append page or p param; preserve existing params
  const hasQuery = url.includes("?");
  const sep = hasQuery ? "&" : "?";
  // NHS sometimes uses 'page', sometimes 'p'; try both by returning two variants
  return [ `${url}${sep}page=${page}`, `${url}${sep}p=${page}` ];
}

function extractPracticeLinks(html){
  if (!html) return [];
  const $=cheerio.load(html);
  // broad & resilient
  const hrefs = $('a[href*="/services/dentists/"]')
    .map((_,el)=>$(el).attr("href"))
    .get()
    .map(normalizeUrl)
    .filter(Boolean);

  // unique & stable order
  const seen=new Set(); const out=[];
  for (const h of hrefs){ if(!seen.has(h)){ seen.add(h); out.push(h); } }
  return out;
}

async function discoverPracticeLinks(postcode, radiusMiles){
  const candidates = buildDiscoveryCandidates(postcode, radiusMiles);
  let allLinks = [];

  for (const baseUrl of candidates){
    // page 1 + a couple more pages
    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++){
      const urls = Array.isArray(injectPageParam(baseUrl, page)) ? injectPageParam(baseUrl, page) : [injectPageParam(baseUrl, page)];
      for (const url of urls){
        const cacheKey = `discover:${url}`;
        const cached = cache.get(cacheKey);
        if (cached) {
          if (cached.length) allLinks = allLinks.concat(cached);
          continue;
        }

        console.log(`[DISCOVERY_URL] ${url}`);
        const html = await fetchText(url);
        const links = extractPracticeLinks(html);
        cache.set(cacheKey, links, CACHE_TTL_DISCOVERY_MS);

        if (links.length) {
          allLinks = allLinks.concat(links);
        } else {
          // If page>1 returns empty, likely no further pagination; break inner-most URL loop and next page
          if (page > 1) break;
        }
      }
    }
    if (allLinks.length) break; // stop at first endpoint that yields results
  }

  // unique & truncate
  const uniq = Array.from(new Set(allLinks));
  return { links: uniq, cached: false };
}

/* ----------------------------- Appointments parsing ----------------------------- */
function extractAppointmentsHtml($){
  const sec=$("#appointments").first(); if(sec && sec.length) return cheerio.load(sec.html()||"");
  const anchor=$("a").map((_,el)=>{const txt=(($(el).text())||"").toLowerCase(); const href=$(el).attr("href")||""; if(href.includes("#appointments")) return href; if(txt.includes("appointments")) return href; return null;}).get().find(Boolean);
  if(anchor && anchor.startsWith("#appointments")){ const node=$(anchor); if(node && node.length) return cheerio.load(node.html()||""); }
  return $;
}

const POSITIVE=[/currently\s*accept(?:ing)?\s*new\s*nhs\s*patients/gi,/accept(?:ing)?\s*new\s*nhs\s*patients/gi,/taking\s*new\s*nhs\s*patients/gi,/open\s*to\s*new\s*nhs\s*patients/gi,/this dentist currently accepts new nhs patients/gi];
const CHILD_ONLY=[/children\s*only/gi,/child(?:ren)?\s*only/gi,/accept(?:ing)?\s*nhs\s*patients\s*(?:aged)?\s*(?:under|below)\s*\d+/gi,/currently\s*accept(?:ing)?\s*nhs\s*patients\s*aged\s*\d+\s*and\s*under/gi,/accept(?:ing)?\s*nhs\s*patients\s*for\s*children/gi,/only\s*accept(?:ing)?\s*children/gi];
const NEGATIVE=[/not\s*accept(?:ing)?\s*new\s*nhs\s*patients/gi,/no\s*longer\s*accept(?:ing)?\s*nhs\s*patients/gi,/we\s*are\s*not\s*taking\s*nhs\s*patients/gi,/nhs\s*list\s*closed/gi];

function scanAppointmentsHtml($){
  const nodes=[...$("section#appointments").toArray(), ...$("#appointments").toArray(), ...$("h2,h3,h4,p,li,div").toArray()];
  let text=""; for(const el of nodes){ const s=cheerio.load(el).root().text(); if(!s) continue; if(/appointment|register|accept/i.test(s)||/nhs\s*patients/i.test(s)||/taking|list|join/i.test(s)){ text+="\n"+s.trim(); } }
  const summary=text.replace(/\s+/g," ").trim();
  const positive=POSITIVE.some(rx=>rx.test(summary));
  const childOnly=CHILD_ONLY.some(rx=>rx.test(summary));
  const negative=NEGATIVE.some(rx=>rx.test(summary));
  return {positive,childOnly,negative,excerpt:summary.slice(0,400)};
}

/* ----------------------------- Detail & evaluate ----------------------------- */
async function fetchDetailHtml(url){ const key=`detail:${url}`; const c=cache.get(key); if(c) return c; await sleep(40+Math.random()*60); const html=await fetchText(url); cache.set(key,html,CACHE_TTL_DETAIL_MS); return html; }

async function evaluatePractice(url){
  try{
    const html=await fetchDetailHtml(url);
    if (!html) return { url, title:"", status:"error", error:"empty_html" };
    const $=cheerio.load(html);
    const title=$("h1.nhsuk-heading-l").first().text().trim()||$("h1").first().text().trim()||"";
    const _$a=extractAppointmentsHtml($);
    const r=scanAppointmentsHtml(_$a);
    let status="unknown";
    if(r.negative && !r.positive) status="not_accepting";
    else if(r.childOnly && !r.positive) status="child_only";
    else if(r.positive && !r.negative) status="accepting";
    else if(r.positive && r.childOnly) status="child_only";
    else if(r.positive && r.negative) status="mixed";
    return {url,title,status,positive:r.positive,childOnly:r.childOnly,negative:r.negative,excerpt:r.excerpt};
  }catch(e){ return {url,title:"",status:"error",error:e?.message||String(e)}; }
}

/* ----------------------------- Concurrency ----------------------------- */
async function mapWithConcurrency(items, limit, worker){
  const results=new Array(items.length); let i=0;
  const runners=new Array(Math.min(limit,items.length)).fill(0).map(async()=>{ while(true){ const idx=i++; if(idx>=items.length) return; try{ results[idx]=await worker(items[idx],idx);}catch(e){results[idx]=e;} } });
  await Promise.all(runners); return results;
}

/* ----------------------------- Public APIs ----------------------------- */
export async function scanPostcode(postcode, radiusMiles = 25){
  console.log(`DentistRadar scanner v7.5`);
  console.log(`--- Scan: ${postcode || "(empty)"} (${radiusMiles} miles) ---`);

  if (!postcode) {
    return {
      ok: true,
      summary: { postcode:"", radiusMiles, accepting:0, childOnly:0, notAccepting:0, mixed:0, scanned:0, tookMs:0 },
      accepting: [], childOnly: [], errors: []
    };
  }

  const t0=Date.now();
  const discovery=await discoverPracticeLinks(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${discovery.links.length}`);

  if(!discovery.links.length){
    const summary={ postcode, radiusMiles, accepting:0, childOnly:0, notAccepting:0, mixed:0, scanned:0, tookMs:Date.now()-t0 };
    return { ok:true, summary, accepting:[], childOnly:[], errors:[] };
  }

  const target=discovery.links.slice(0,MAX_PRACTICES);
  const results=await mapWithConcurrency(target, CONCURRENCY, evaluatePractice);

  const accepting=results.filter(r=>r.status==="accepting");
  const childOnly=results.filter(r=>r.status==="child_only"||(r.positive && r.childOnly));
  const notAccepting=results.filter(r=>r.status==="not_accepting");
  const mixed=results.filter(r=>r.status==="mixed");
  const errors=results.filter(r=>r.status==="error");

  const summary={ postcode, radiusMiles, accepting:accepting.length, childOnly:childOnly.length, notAccepting:notAccepting.length, mixed:mixed.length, scanned:results.length, tookMs:Date.now()-t0 };

  console.log(`[STATS] scanned=${results.length} ok=${results.length-errors.length} errors=${errors.length}`);
  console.log(`[HITS] accepting=${accepting.length} childOnly=${childOnly.length} notAccepting=${notAccepting.length} mixed=${mixed.length}`);

  return { ok:true, summary,
    accepting: accepting.map(({url,title,excerpt})=>({url,title,excerpt})),
    childOnly: childOnly.map(({url,title,excerpt})=>({url,title,excerpt})),
    errors
  };
}

/**
 * High-level function your server calls:
 *   runScan({ postcode, includeChildOnly, radius? })  OR  runScan("RG41 4UW")
 */
export async function runScan(argsOrPostcode){
  let postcodeInput, includeChildOnly=false, radiusInput;
  if (typeof argsOrPostcode === "object" && argsOrPostcode !== null){
    postcodeInput    = argsOrPostcode.postcode;
    includeChildOnly = !!argsOrPostcode.includeChildOnly;
    radiusInput      = argsOrPostcode.radius;
  } else {
    postcodeInput = argsOrPostcode;
  }
  const postcode = coercePostcode(postcodeInput || process.env.DEFAULT_POSTCODE || process.env.SCAN_POSTCODE || "");
  const radius   = coerceRadius(radiusInput || process.env.DEFAULT_RADIUS || process.env.SCAN_RADIUS || 25, 25);

  const base = await scanPostcode(postcode, radius);
  const accepting = base.accepting || [];
  const childOnly = base.childOnly  || [];

  return {
    ok: true,
    checked: base.summary?.scanned ?? (accepting.length + childOnly.length),
    found: accepting.length + (includeChildOnly ? childOnly.length : 0),
    alertsSent: 0,
    summary: base.summary,
    accepting,
    childOnly: includeChildOnly ? childOnly : [],
    errors: base.errors || []
  };
}

export default scanPostcode;

/* ----------------------------- CLI ----------------------------- */
if (import.meta.url === `file://${process.argv[1]}`){
  const postcode = coercePostcode(process.argv[2] || process.env.DEFAULT_POSTCODE || process.env.SCAN_POSTCODE || "RG41 4UW");
  const radius   = coerceRadius(process.argv[3] || process.env.DEFAULT_RADIUS || process.env.SCAN_RADIUS || 25);
  runScan({ postcode, radius, includeChildOnly: true }).then(r => {
    console.log(JSON.stringify(r.summary, null, 2));
  }).catch(err => {
    console.error("[FATAL]", err?.message || err);
    process.exit(1);
  });
}
