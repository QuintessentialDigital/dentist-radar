import { savePractice, getPracticeByUrl, insertStatus, touchWatch } from './db.js';
import { searchUrl, fetchHtml, parseList, parseStatus } from './scraper.js';
import { sendEmail } from './alerts.js';

const MAX = Number(process.env.MAX_PRACTICES_PER_SCAN || 50);
const DELAY = Number(process.env.REQUEST_DELAY_MS || 700);
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

export async function runScan(watch){
  const listHtml = await fetchHtml(searchUrl(watch.postcode, watch.radius_miles));
  const items = parseList(listHtml).slice(0, MAX);
  let alerts = 0;
  for (const p of items){
    try{
      const html = await fetchHtml(p.url);
      const { statusText, acceptingFlag } = parseStatus(html);
      savePractice(p.url, p.name);
      const pr = getPracticeByUrl(p.url);
      insertStatus(pr.id, statusText, acceptingFlag);
      if (acceptingFlag === 1 && watch.contact_email){
        await sendEmail(
          watch.contact_email,
          `Dentist Radar: "${p.name}" may be accepting NHS patients`,
          `"${p.name}" appears to be accepting new NHS patients (per the NHS page). Please call to confirm.\nLink: ${p.url}\n\n— Dentist Radar`
        );
        alerts++;
      }
    }catch(e){
      console.error('[scan error]', p.url, e.message);
    }
    await sleep(DELAY);
  }
  if (watch?.id) try{ touchWatch(watch.id); }catch(e){}
  return { scanned: items.length, alerts };
}
