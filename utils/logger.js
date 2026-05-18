const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'screener.log');
const MAX_BYTES = 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, `screener-${Date.now()}.log`));
    }
  } catch {}
}

function log(level, message, meta = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  rotateIfNeeded();
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...meta }) + '\n';
  fs.appendFileSync(LOG_FILE, line);
  if (level === 'error') console.error(message);
  else console.log(message);
}

module.exports = { log };
