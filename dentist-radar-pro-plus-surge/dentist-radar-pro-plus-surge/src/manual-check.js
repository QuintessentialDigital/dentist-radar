import { ensureDb, getDb } from './db.js';
import { runPostcodeScan } from './scraper/index.js';
function arg(name, def=null){ const v=process.argv.find(a=>a.startsWith(`--${name}=`)); return v? v.split('=')[1]: def; }
const region = (arg('region','england')+'').toLowerCase();
const postcode = arg('postcode'); const radius = Number(arg('radius', 10));
if(!postcode){ console.log('Usage: npm run check -- --region=england --postcode=RG41 --radius=10'); process.exit(1); }
ensureDb(); const db = getDb();
const result = await runPostcodeScan(db, region, postcode.toUpperCase(), radius, ['email'], { email:'demo@example.com' });
console.log(JSON.stringify(result,null,2));
