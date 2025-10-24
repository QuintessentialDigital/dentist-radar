// Minimal scanner stub — replace with real NHS parsing later
import { listWatchesAdmin } from './db.js';
import { sendAvailability } from './alerts.js';

export async function runScan() {
  // TODO: Replace with real fetch/parsing of NHS listings
  const accepting = []; // [{ name:'Smile Dental', postcode:'RG41', link:'https://...' }]
  const watches = listWatchesAdmin();
  let matched = 0, sent = 0;

  for (const a of accepting) {
    for (const w of watches) {
      if ((a.postcode || '').startsWith((w.postcode || ''))) {
        matched++;
        try {
          await sendAvailability(String(w.email).trim(), { practice: a.name, postcode: w.postcode, link: a.link });
          sent++;
        } catch {}
      }
    }
  }
  return { matched, sent };
}
