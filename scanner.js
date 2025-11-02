// scanner.js – safe patch for "non json response" (keeps everything else stable)

import mongoose from "mongoose";
import fetch from "node-fetch";

const NHS_URL =
  process.env.NHS_BASE || "https://api.nhs.uk/service-search/organisations";
const NHS_KEY = process.env.NHS_KEY || "";
const NHS_VERSION = process.env.NHS_VERSION || "2";
const NHS_FALLBACK = "https://www.nhs.uk/service-search/find-a-dentist/results";
const MAX_PCS = Number(process.env.SCAN_MAX_PCS || 20);

// --- simple delay helper ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- json detector ---
function isJSON(res) {
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json");
}

// --- attempt to read JSON, tolerate HTML ---
async function fetchMaybeJSON(url, headers) {
  const res = await fetch(url, { headers, redirect: "follow" });
  const text = await res.text();

  if (!res.ok) throw new Error(`http_${res.status}`);

  // not JSON? return a marker instead of throwing
  if (!isJSON(res)) {
    return { nonJSON: true, raw: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { nonJSON: true, raw: text };
  }
}

// --- html fallback minimal parse ---
function parseCardsFromHTML(html) {
  const cards = [];
  const re = /<a[^>]+href="(\/services\/dentist\/[^"]+)"[^>]*>(.*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    cards.push({
      name: m[2].replace(/<[^>]+>/g, " ").trim(),
      link: "https://www.nhs.uk" + m[1],
    });
  }
  return cards;
}

// --- main scan function ---
export async function runScan() {
  const watches = await mongoose.connection
    .collection("watches")
    .find({})
    .limit(MAX_PCS)
    .toArray();

  const postcodes = [
    ...new Set(
      watches
        .map((w) => String(w.postcode || "").split(/[,;]+/))
        .flat()
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ].slice(0, MAX_PCS);

  let checked = 0,
    found = 0,
    alertsSent = 0,
    errors = [];

  for (const pc of postcodes) {
    try {
      const url = `${NHS_URL}?api-version=${NHS_VERSION}&search=${encodeURIComponent(
        pc
      )}&filter=ServiceType:dentist`;

      const headers = NHS_KEY
        ? { "subscription-key": NHS_KEY, Accept: "application/json" }
        : { Accept: "application/json" };

      const j = await fetchMaybeJSON(url, headers);

      let cards = [];
      if (j.nonJSON) {
        // fallback scrape
        const html = await fetch(`${NHS_FALLBACK}/${encodeURIComponent(pc)}?distance=30`);
        const text = await html.text();
        cards = parseCardsFromHTML(text);
      } else if (Array.isArray(j.value)) {
        cards = j.value.map((v) => ({
          name: v.name || v.title || "Dentist",
          link: v.url || v.websiteUrl || "",
        }));
      }

      checked++;
      found += cards.length;
      await sleep(800);
    } catch (e) {
      errors.push({ pc, error: String(e.message || e) });
    }
  }

  return { ok: true, checked, found, alertsSent, errors };
}
