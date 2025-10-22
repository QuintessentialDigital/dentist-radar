import { scanEngland } from './providers/england_nhs.js';
export async function runPostcodeScan(db, region, postcode, radiusMiles, channels, contact){
  region = (region||'england').toLowerCase();
  if (region === 'england') return scanEngland(db, postcode, radiusMiles, channels, contact);
  throw new Error('Unsupported region in this minimal build');
}
