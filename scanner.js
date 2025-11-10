import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* Tunables */
const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);
const CACHE_TTL_DISCOVERY_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_TTL_DETAIL_MS    = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);
function envInt(k, d){ const v=parseInt(process.env[k]||`${d}`,10); return Number.isNaN(v)?d:v; }

/* TTL cache */
class TTLCache{ constructor(){this.store=new Map();} get(k){const h=this.store.get(k); if(!h)return; if(Date.now()>h.expires){this.store.delete(k);return;} return h.value;} set(k,v,ttl){this.store.set(k,{value:v,expires:Date.now()+ttl});}}
const cache=new TTLCache();

/* HTTP */
async function fetchText(url, tries=0){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),TIMEOUT_MS);
  try{
    const r=await fetch(url,{method:"GET",redirect:"follow",signal:ctrl.signal,headers:{
      "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 DentistRadar/7.1",
      "accept-language":"en-GB,en;q=0.9","accept":"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch(e){ if(tries<2){await sleep(100+Math.random()*200); return fetchText(url,tries+1);} throw e; }
  finally{ clearTimeout(t); }
}

function normalizeUrl(h){ if(!h) return null; if(h.startsWith("http")) return h; if(h.startsWith("//")) return `https:${h}`; if(h.startsWith("/")) return `https://www.nhs.uk${h}`; return null; }

/* Discovery */
async function discoverPracticeLinks(postcode, radiusMiles){
  const url=`https://www.nhs.uk/service-search/find-a-dentist/locationsearch/3?postcode=${encodeURIComponent(postcode)}&distance=${encodeURIComponent(radiusMiles)}`;
  console.log(`[DISCOVERY_URL] ${url}`);
  const key=`discover:${url}`;
  const cached=cache.get(key); if(cached) return {url,links:cached,cached:true};

  const html=await fetchText(url);
  const $=cheerio.load(html);

  let links=$("a.nhsuk-action-link__link").map((_,el)=>$(el).attr("href")).get()
    .map(normalizeUrl).filter(Boolean).filter(h=>h.includes("/services/dentists/"));

  if(!links.length){
    links=$("a.nhsuk-card__link").map((_,el)=>$(el).attr("href")).get()
      .map(normalizeUrl).filter(Boolean).filter(h=>h.includes("/services/dentists/"));
  }

  cache.set(key,links,CACHE_TTL_DISCOVERY_MS);
  return {url,links,cached:false};
}

/* Appointments parsing */
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

/* Detail & evaluate */
async function fetchDetailHtml(url){ const key=`detail:${url}`; const c=cache.get(key); if(c) return c; await sleep(40+Math.random()*60); const html=await fetchText(url); cache.set(key,html,CACHE_TTL_DETAIL_MS); return html; }

async function evaluatePractice(url){
  try{
    const html=await fetchDetailHtml(url);
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

/* Concurrency */
async function mapWithConcurrency(items, limit, worker){
  const results=new Array(items.length); let i=0;
  const runners=new Array(Math.min(limit,items.length)).fill(0).map(async()=>{ while(true){ const idx=i++; if(idx>=items.length) return; try{ results[idx]=await worker(items[idx],idx);}catch(e){results[idx]=e;} } });
  await Promise.all(runners); return results;
}

/* Public API */
export async function scanPostcode(postcodeInput, radiusInput){
  const postcode = String(postcodeInput ?? "").trim();
  const radiusMiles = (() => { const n=parseInt(radiusInput ?? "25",10); if(Number.isNaN(n)) return 25; return Math.max(1,Math.min(100,n)); })();

  console.log(`DentistRadar scanner v7.1`);
  console.log(`--- Scan: ${postcode} (${radiusMiles} miles) ---`);

  if (!postcode) throw new Error("postcode is empty/invalid");

  const t0=Date.now();
  const discovery=await discoverPracticeLinks(postcode, radiusMiles);
  console.log(`[DISCOVERY] detail URLs = ${discovery.links.length}${discovery.cached?" (cache)":""}`);

  if(!discovery.links.length){
    const out=[{postcode,radiusMiles,accepting:0,childOnly:0}];
    console.log("[INFO] No practice detail URLs discovered for this query.");
    console.log("[DONE]", JSON.stringify(out,null,2));
    return out;
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
  console.log("[DONE]", JSON.stringify([summary], null, 2));

  return { summary,
    accepting: accepting.map(({url,title,excerpt})=>({url,title,excerpt})),
    childOnly: childOnly.map(({url,title,excerpt})=>({url,title,excerpt})),
    errors
  };
}

export async function runScan(pc, r){ return scanPostcode(pc, r); }
export default scanPostcode;

/* CLI */
if (import.meta.url === `file://${process.argv[1]}`){
  const postcode=process.argv[2]||"RG41 4UW";
  const radius=Math.max(1,Math.min(100,parseInt(process.argv[3]||"25",10)));
  scanPostcode(postcode,radius).catch(err=>{ console.error("[FATAL]",err?.message||err); process.exit(1); });
}
