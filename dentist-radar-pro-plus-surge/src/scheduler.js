import cron from 'node-cron';
import { getDb } from './db.js';
import { runPostcodeScan } from './scraper/index.js';

export function scheduleAll(){
  if (String(process.env.SCHEDULER_ENABLED||'true') !== 'true'){ console.log('[Scheduler] disabled'); return; }
  const expr = process.env.CRON_SCHEDULE || '*/15 * * * *';
  console.log('[Scheduler] CRON:', expr);
  cron.schedule(expr, async () => {
    try{
      const db = getDb();
      const watches = db.prepare(`SELECT * FROM watches WHERE active=1`).all();
      for (const w of watches){
        const contact = JSON.parse(w.contact||'{}');
        const channels = JSON.parse(w.channels||'[]');
        await runPostcodeScan(db, w.region, w.postcode, w.radius_miles, channels, contact);
        db.prepare(`UPDATE watches SET last_run_at=datetime('now') WHERE id=?`).run(w.id);
      }
    }catch(e){ console.error('[Scheduler]', e); }
  }, { timezone:'Europe/London' });
}
