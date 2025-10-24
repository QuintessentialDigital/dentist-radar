// Stub for future NHS parsing
import { listWatchesAdmin } from './db.js';
import { sendAvailability } from './alerts.js';

export async function runScan(){
  const accepting = [];
  const watches = listWatchesAdmin();
  let matched=0, sent=0;
  for(const a of accepting){
    for(const w of watches){
      if((a.postcode||'').startsWith((w.postcode||''))){
        matched++;
        try{ await sendAvailability(String(w.email).trim(), { practice:a.name, postcode:w.postcode, link:a.link }); sent++; }catch{}
      }
    }
  }
  return { matched, sent };
}
