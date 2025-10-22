import got from 'got';
import { fetchCached } from '../../net.js';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { sendAlerts } from '../../alerts.js';

const BASE = 'https://www.nhs.uk';
const UA = process.env.USER_AGENT || 'DentistRadarBot/0.3';
const sleep = ms => new Promise(r=>setTimeout(r, ms));
const hash = t => crypto.createHash('sha1').update(t||'').digest('hex');

function normalizeStatus(text){
  const t = (text||'').toLowerCase();
  const accepting = t.includes('accepting new nhs patients') || (t.includes('accepting') && t.includes('nhs'));
  return { accepting_flag: accepting ? 1 : 0, normalized: t };
}
function searchUrl(postcode, radiusMiles){
  const km = Math.max(1, Math.round(radiusMiles*1.60934));
  return `${BASE}/service-search/find-a-dentist/results/${encodeURIComponent(postcode)}?distance=${km}`;
}
async function fetchHtml(url){
  return await fetchCached(url);
}

export async function scanEngland(db, postcode, radiusMiles, channels, contact){
  const url = searchUrl(postcode, radiusMiles);
  let html; try{ html = await fetchHtml(url);}catch(e){ return {ok:false, error:e.message}; }
  const $ = cheerio.load(html);
  const cards = $('article.nhsuk-card, li.nhsuk-grid-column-list__item, div.dentist-result');
  const found = [];
  cards.each((i,el)=>{
    const name = $(el).find('h2, h3, a.nhsuk-card__link').first().text().trim();
    let link = $(el).find('a').first().attr('href')||'';
    if (link && !link.startsWith('http')) link = BASE + link;
    if (name && link) found.push({ name, link });
  });
  const alerts = [];
  for (const p of found.slice(0,60)){
    await sleep(500);
    try{
      const body = await fetchCached(p.link);
      const $$ = cheerio.load(body);
      let statusText = $$('p:contains("accepting")').first().text().trim() || $$('li:contains("accepting")').first().text().trim();
      const { accepting_flag } = normalizeStatus(statusText);
      const up = db.prepare(`INSERT INTO practices (region,nhs_url,name) VALUES ('england',?,?) ON CONFLICT(region, nhs_url) DO UPDATE SET name=excluded.name`);
      up.run(p.link, p.name);
      const pr = db.prepare(`SELECT id FROM practices WHERE region='england' AND nhs_url=?`).get(p.link);
      const h = hash(statusText);
      db.prepare(`INSERT INTO practice_status (practice_id,status_text,accepting_flag,hash) VALUES (?,?,?,?)`).run(pr.id, statusText, accepting_flag, h);
      const lastTwo = db.prepare(`SELECT accepting_flag FROM practice_status WHERE practice_id=? ORDER BY id DESC LIMIT 2`).all(pr.id);
      if ((lastTwo.length===1 && accepting_flag===1) || (lastTwo.length===2 && lastTwo[0].accepting_flag===1 && lastTwo[1].accepting_flag===0)){
        const msg = `"${p.name}" now shows accepting NHS patients. Call asap. Link: ${p.link}`;
        const r = await sendAlerts({ to: contact||{}, message: msg, brand: process.env.BRAND_NAME });
        alerts.push({ practice:p.name, link:p.link, channels:r });
      }
    }catch(e){ console.error('[ENG] fetch failed', p.link, e.message); }
  }
  return { ok:true, region:'england', scanned: found.length, alerts: alerts.length, sent: alerts };
}
