const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', 'cache');

function cachePath(key) {
  const safe = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function getCache(key, ttlSeconds) {
  try {
    const file = cachePath(key);
    if (!fs.existsSync(file)) return null;
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((Date.now() - payload.savedAt) / 1000 > ttlSeconds) return null;
    return payload.value;
  } catch {
    return null;
  }
}

function setCache(key, value) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(key), JSON.stringify({ savedAt: Date.now(), value }));
}

async function withCache(key, ttlSeconds, fetcher) {
  const cached = getCache(key, ttlSeconds);
  if (cached) return { value: cached, cached: true };
  const value = await fetcher();
  setCache(key, value);
  return { value, cached: false };
}

module.exports = { getCache, setCache, withCache };
