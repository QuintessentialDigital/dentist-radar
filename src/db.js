import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'data.sqlite');

let db;

export function ensureDb() {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      plan TEXT NOT NULL DEFAULT 'free',
      welcomed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      email TEXT NOT NULL,
      postcode TEXT NOT NULL,
      radius_miles INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS watches_email_postcode
      ON watches (email, postcode);
  `);
}

export function upsertUser(email){
  const em = String(email).trim();
  db.prepare(`INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).run(em);
  return db.prepare(`SELECT * FROM users WHERE email=?`).get(em);
}

export function setPlan(email, plan){
  db.prepare(`UPDATE users SET plan=? WHERE email=?`).run(plan, String(email).trim());
}

export function markWelcomed(email){
  db.prepare(`UPDATE users SET welcomed=1 WHERE email=?`).run(String(email).trim());
}

export function getUser(email){
  return db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email).trim());
}

export function createWatch(email, postcode, radius) {
  const user = upsertUser(email);
  const em = String(email).trim();
  const pc = String(postcode).toUpperCase().replace(/\s+/g, '');
  const rad = Number(radius);
  db.prepare(
    `INSERT OR IGNORE INTO watches (user_id, email, postcode, radius_miles) VALUES (?,?,?,?)`
  ).run(user.id, em, pc, rad);
  return db.prepare(`SELECT * FROM watches WHERE email=? AND postcode=?`).get(em, pc);
}

export function listWatchesPublic() {
  return db.prepare(`SELECT id, postcode, radius_miles, created_at FROM watches ORDER BY id DESC`).all();
}

export function listWatchesAdmin() {
  return db.prepare(`SELECT * FROM watches ORDER BY id DESC`).all();
}
