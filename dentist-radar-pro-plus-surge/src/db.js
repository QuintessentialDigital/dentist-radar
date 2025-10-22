import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { runPostcodeScan } from './scraper/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data.sqlite');

let db;
export function ensureDb(){
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      region TEXT NOT NULL DEFAULT 'england',
      postcode TEXT NOT NULL,
      radius_miles INTEGER NOT NULL,
      frequency_minutes INTEGER NOT NULL DEFAULT 60,
      channels TEXT NOT NULL DEFAULT '[]',
      contact TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS practices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT NOT NULL,
      nhs_url TEXT NOT NULL,
      name TEXT,
      UNIQUE(region, nhs_url)
    );
    CREATE TABLE IF NOT EXISTS practice_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      practice_id INTEGER NOT NULL,
      status_text TEXT,
      accepting_flag INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
export function getDb(){ return db; }
export function upsertUserByEmail(email){
  db.prepare(`INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).run(email);
  return db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
}
export function setUserPlan(email, plan){
  db.prepare(`UPDATE users SET plan=? WHERE email=?`).run(plan, email);
  return db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
}
export function countWatchesForUser(userId){
  const r = db.prepare(`SELECT COUNT(*) as c FROM watches WHERE user_id=?`).get(userId);
  return r?.c || 0;
}
export function createWatch({ user_id=null, region, postcode, radius_miles, frequency_minutes, channels, contact }){
  const info = db.prepare(`INSERT INTO watches (user_id,region,postcode,radius_miles,frequency_minutes,channels,contact) VALUES (?,?,?,?,?,?,?)`)
    .run(user_id, region, postcode, radius_miles, frequency_minutes, JSON.stringify(channels||[]), JSON.stringify(contact||{}));
  return { id: info.lastInsertRowid, region, postcode, radius_miles, frequency_minutes, channels, contact };
}
export function listWatches(){
  const rows = db.prepare(`SELECT * FROM watches ORDER BY id DESC`).all();
  return rows.map(r => ({ id:r.id, region:r.region, postcode:r.postcode, radius_miles:r.radius_miles, frequency_minutes:r.frequency_minutes, channels:JSON.parse(r.channels||'[]'), contact:JSON.parse(r.contact||'{}'), active:!!r.active, last_run_at:r.last_run_at, created_at:r.created_at }));
}
export async function triggerRunForWatch(id){
  const w = db.prepare(`SELECT * FROM watches WHERE id=?`).get(id);
  if (!w) throw new Error('watch not found');
  const contact = JSON.parse(w.contact||'{}');
  const channels = JSON.parse(w.channels||'[]');
  const result = await runPostcodeScan(db, w.region, w.postcode, w.radius_miles, channels, contact);
  db.prepare(`UPDATE watches SET last_run_at=datetime('now') WHERE id=?`).run(id);
  return result;
}


export function listUsers(){
  return db.prepare(`SELECT id, email, plan, created_at FROM users ORDER BY id DESC`).all();
}
export function setPlanByUserId(userId, plan){
  db.prepare(`UPDATE users SET plan=? WHERE id=?`).run(plan, userId);
  return db.prepare(`SELECT id, email, plan FROM users WHERE id=?`).get(userId);
}
export function listAllWatches(){
  const rows = db.prepare(`SELECT w.*, u.email as user_email FROM watches w LEFT JOIN users u ON u.id=w.user_id ORDER BY w.id DESC`).all();
  return rows.map(r=>({ id:r.id, user_id:r.user_id, user_email:r.user_email, region:r.region, postcode:r.postcode, radius_miles:r.radius_miles, frequency_minutes:r.frequency_minutes, channels: JSON.parse(r.channels||'[]'), contact: JSON.parse(r.contact||'{}'), active: !!r.active, created_at:r.created_at }));
}
export function createApiKey(userId, label='default'){
  const key = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  db.prepare(`INSERT INTO api_keys (user_id, key, label) VALUES (?,?,?)`).run(userId, key, label);
  return db.prepare(`SELECT * FROM api_keys WHERE key=?`).get(key);
}
export function listApiKeys(userId){
  return db.prepare(`SELECT * FROM api_keys WHERE user_id=? ORDER BY id DESC`).all(userId);
}
export function deleteApiKey(id){
  db.prepare(`DELETE FROM api_keys WHERE id=?`).run(id);
}
