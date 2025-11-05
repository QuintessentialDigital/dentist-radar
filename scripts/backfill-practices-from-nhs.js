// scripts/backfill-practices-from-nhs.js
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import * as cheerio from 'cheerio';
import { connectMongo, disconnectMongo, Practice } from '../models.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

async function httpGet(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-GB,en;q=0.9' },
    timeout: 15000
  });
  return data;
}

function normalizeText(s){ return String(s||'').replace(/\s+/g,' ').trim(); }

async function discover(postcode, radiusMiles) {
  const q = encodeURIComponent(postcode);
  const url = `https://www.nhs.uk/service-search/find-a-dentist/results/${q}?distance=${encodeURIComponent(radiusMiles)}`;
  const html = await httpGet(url);
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="/services/dentists/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    try {
      const abs = new URL(href, 'https://www.nhs.uk').toString();
      if (/https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs) && !/\/appointments/i.test(abs)) {
        out.push(abs);
      }
    } catch(_) {}
  });
  return Array.from(new Set(out));
}

async function main() {
  const pc = process.argv[2];
  const radius = Number(process.argv[3] || 25);
  if (!pc) throw new Error('Usage: node scripts/backfill-practices-from-nhs.js "RG41 4UW" [radiusMiles]');

  await connectMongo(process.env.MONGO_URI);

  const urls = await discover(pc, radius);
  console.log('found urls:', urls.length);

  let upserts = 0;
  for (const u of urls) {
    const res = await Practice.updateOne(
      { $or: [{ detailsUrl: u }, { nhsUrl: u }, { url: u }] },
      { $setOnInsert: { detailsUrl: u, name: null, postcode: null } },
      { upsert: true }
    );
    if (res.upsertedCount) upserts++;
  }
  console.log('upserted:', upserts);

  await disconnectMongo();
}

main().catch(e => { console.error(e); process.exit(1); });
