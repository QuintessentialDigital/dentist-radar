import got from 'got';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENT_FETCHES || 4);
const PER_HOST_DELAY_MS = Number(process.env.PER_HOST_DELAY_MS || 800);
const PRACTICE_CACHE_TTL_MS = Number(process.env.PRACTICE_CACHE_TTL_MS || 600000);
const UA = process.env.USER_AGENT || 'DentistRadarBot/0.4';

const hostQueues = new Map(); // host -> { last: number, running: number, queue: Array<fn> }
const cache = new Map(); // url -> { ts, body }
let totalQueued = 0;

function getHost(url){
  try { return new URL(url).host; } catch { return 'default'; }
}

async function runNext(host){
  const q = hostQueues.get(host);
  if (!q) return;
  if (q.running >= MAX_CONCURRENCY) return;
  const item = q.queue.shift();
  if (!item) return;
  q.running++;
  const gap = Math.max(0, PER_HOST_DELAY_MS - (Date.now() - q.last));
  await delay(gap);
  q.last = Date.now();
  try {
    const res = await item();
    return res;
  } finally {
    q.running--;
    if (q.queue.length) runNext(host);
  }
}

export function getMetrics(){
  let queued = 0, running = 0;
  for (const [,q] of hostQueues){
    queued += q.queue.length; running += q.running;
  }
  return { queued, running, cacheSize: cache.size };
}

export async function fetchCached(url){
  // cache
  const now = Date.now();
  const c = cache.get(url);
  if (c && (now - c.ts) < PRACTICE_CACHE_TTL_MS) return c.body;

  const host = getHost(url);
  if (!hostQueues.has(host)) hostQueues.set(host, { last: 0, running: 0, queue: [] });
  const q = hostQueues.get(host);

  totalQueued++;
  const body = await new Promise((resolve, reject) => {
    q.queue.push(async () => {
      try {
        const res = await got(url, {
          headers: { 'user-agent': UA, 'accept': 'text/html' },
          http2: true,
          timeout: { request: 15000 }
        });
        cache.set(url, { ts: Date.now(), body: res.body });
        resolve(res.body);
      } catch (e) {
        reject(e);
      }
    });
    runNext(host);
  });
  return body;
}
