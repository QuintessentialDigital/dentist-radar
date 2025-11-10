/**
 * DentistRadar Scanner v7.4
 * - Compatible with server.js v1.8.7 call: runScan({ postcode, includeChildOnly, overrideRecipients })
 * - Native fetch (Node 20+), no external HTTP deps
 * - Correct NHS discovery URL (UK-edge)
 * - Appointments-only parsing
 * - Defensive input coercion + light UK postcode normalisation
 * - Returns an object (so server.js can res.json(result) unchanged)
 *
 * Exports:
 *   - export async function runScan(argsOrPostcode)    // accepts string or object
 *   - export async function scanPostcode(postcode, radiusMiles = 25)
 *   - export default scanPostcode
 */

import * as cheerio from "cheerio";
import { setTimeout as sleep } from "timers/promises";

/* ----------------------------- Tunables ----------------------------- */
const MAX_PRACTICES = envInt("DR_MAX_PRACTICES", 200);
const CONCURRENCY   = envInt("DR_CONCURRENCY", 6);
const TIMEOUT_MS    = envInt("DR_TIMEOUT_MS", 15000);
const CACHE_TTL_DISCOVERY_MS = envInt("DR_CACHE_TTL_DISCOVERY_MS", 6 * 60 * 60 * 1000);
const CACHE_TTL_DETAIL_MS    = envInt("DR_CACHE_TTL_DETAIL_MS",    3 * 60 * 60 * 1000);

function envInt(k, d){ const v=parseInt(process.env[k]||`${d}`,10); return Number.isNaN(v)?d:v; }

/* ----------------------------- Input guards ----------------------------- */
function coercePostcode(input){
  // Accept: raw string or objects like { value: "..." } or { postcode: "..." }
  let raw = input;
  if (typeof raw === "object" && raw !== null) {
    raw = raw.value ?? raw.postcode ?? JSON.stringify(raw);
  }
  raw = String(raw ?? "").trim();
  // Light UK normalisation: uppercase, keep A-Z/0-9/space, collapse spaces
  const normal = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normal) return "";
  // If no space and looks UK-ish (≥5), insert space before inward code
  const compact = normal.replace(/\s+/g,"");
  if (!normal.includes(" ") && compact.length >= 5) {
    return compact.slice(0, compact.length - 3) + " " + compact.slice(-3);
  }
  return normal;
}

function coerceRadius(input, def=25){
  let r = input;
  if (typeof r === "object" && r !== null) r = r.value ?? r.radius;
  const n = parseInt(r ?? def, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(1, Math.min(100, n));
}

/* ----------------------------- TTL Cache ----------------------------- */
class TTLCache{
  constructor(){ this.store = new Map(); }
  get(k){ const h = this.store.get(k); if (!h) return; if (Date.now() > h.expires){ this.store.delete(k); return; } return h.value; }
  set(k,v,ttl){ this.store.set(k,{ value:v, expires: Date.now() + ttl }); }
}
const cache = new TTLCache();

/* ----------------------------- HTTP helpers ----------------------------- */
async function fetchText(url, tries=0){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try{
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36 DentistRadar/7.4",
        "accept-language": "en-GB,en;q=0.9",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch(e){
    if (tries < 2){ await sleep(120 + Math.random()*240); return fetchText(url, tries+1); }
