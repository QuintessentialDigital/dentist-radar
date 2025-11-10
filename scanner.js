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
  if(anchor && anchor.startsWith("#appointments")){ const node=$(anchor); if(node
