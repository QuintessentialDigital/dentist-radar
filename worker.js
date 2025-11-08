/**
 * DentistRadar Discovery Worker
 * Version: v1.0
 * Purpose: Fetch NHS dentist search results (HTML) and extract dentist detail URLs.
 * Endpoint: POST /  →  body: { "postcode": "RG41 4UW", "radius": 25 }
 * Returns: { "urls": [ "https://www.nhs.uk/services/dentists/..." ] }
 */

export default {
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("Only POST allowed", { status: 405 });
    }

    let body = {};
    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const postcode = encodeURIComponent((body.postcode || "").trim());
    const radius = Number(body.radius || 10);
    if (!postcode) return new Response("Missing postcode", { status: 400 });

    const pages = 6;
    const sizes = [24, 48, 96];
    const base = "https://www.nhs.uk";
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

    const headers = {
      "User-Agent": ua,
      "Accept-Language": "en-GB,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": "nhsuk-cookie-consent=accepted",
      "Cache-Control": "no-cache",
      "sec-ch-ua": '"Chromium";v="121", "Not=A?Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"'
    };

    // Build all NHS search URLs to cover variants
    const buildUrls = () => {
      const urls = [];
      for (let p = 1; p <= pages; p++) {
        urls.push(`${base}/service-search/find-a-dentist/results/${postcode}?distance=${radius}${p>1?`&page=${p}`:""}`);
        for (const sz of sizes)
          urls.push(`${base}/service-search/find-a-dentist/results/${postcode}?distance=${radius}${p>1?`&page=${p}`:""}&results=${sz}`);
      }
      for (let p = 1; p <= pages; p++)
        urls.push(`${base}/service-search/find-a-dentist/results/${postcode}&distance=${radius}${p>1?`&page=${p}`:""}`);
      for (let p = 1; p <= pages; p++) {
        urls.push(`${base}/service-search/find-a-dentist/results?postcode=${postcode}&distance=${radius}${p>1?`&page=${p}`:""}`);
        for (const sz of sizes)
          urls.push(`${base}/service-search/find-a-dentist/results?postcode=${postcode}&distance=${radius}${p>1?`&page=${p}`:""}&results=${sz}`);
      }
      for (let p = 1; p <= pages; p++)
        urls.push(`${base}/service-search/other-services/Dentists/Location/${postcode}?results=24&distance=${radius}${p>1?`&page=${p}`:""}`);
      return Array.from(new Set(urls));
    };

    const urlsToTry = buildUrls();
    const out = new Set();
    const rx = /https:\/\/www\.nhs\.uk\/services\/dentists\/[A-Za-z0-9\-/%?_.#=]+/g;

    // Loop through pages (stop early if enough found)
    for (const u of urlsToTry) {
      const r = await fetch(u, { headers });
      if (!r.ok) continue;

      const html = await r.text();
      if (!html || html.length < 200) continue;

      const matches = html.match(rx);
      if (matches) matches.forEach((m) => out.add(m.split("#")[0]));

      // safety: stop after enough hits
      if (out.size >= 150) break;
      await new Promise((res) => setTimeout(res, 100));
    }

    return new Response(
      JSON.stringify({ urls: Array.from(out) }, null, 2),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
};
