const http = require('http');
const fs = require('fs');
const path = require('path');
const { httpsJson } = require('./utils/http');
const { readJson, writeJson } = require('./utils/helpers');
const { log } = require('./utils/logger');
const { runScan } = require('./scanners/scanEngine');
const { sendCandidates, getTelegramConfig } = require('./telegram/telegramBot');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');
const config = readJson(CONFIG_PATH, {});
const PORT = Number(process.env.PORT || config.server?.port || 3100);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJson(res, status, value) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, CORS);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.json' ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8';
  res.writeHead(200, { ...CORS, 'Content-Type': type });
  fs.createReadStream(filePath).pipe(res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  try {
    if (url.pathname === '/' || url.pathname === '/screener-ic.html') {
      return serveFile(res, path.join(ROOT, 'screener-ic.html'));
    }

    if (url.pathname === '/api/config') {
      const tg = getTelegramConfig();
      return sendJson(res, 200, {
        ...config,
        telegramConfigured: Boolean(tg.token && tg.chatId)
      });
    }

    if (url.pathname === '/api/memory') {
      return sendJson(res, 200, readJson(MEMORY_PATH, { watchlist: [], lastAlerts: {}, lastScan: null }));
    }

    if (url.pathname === '/api/watchlist' && req.method === 'POST') {
      const body = await readBody(req);
      const symbol = String(body.symbol || '').trim().toUpperCase();
      if (!symbol) return sendJson(res, 400, { error: 'Missing symbol' });
      const memory = readJson(MEMORY_PATH, { watchlist: [], lastAlerts: {}, lastScan: null });
      const current = new Set(memory.watchlist || []);
      if (body.action === 'remove') current.delete(symbol);
      else current.add(symbol);
      memory.watchlist = [...current].sort();
      writeJson(MEMORY_PATH, memory);
      return sendJson(res, 200, memory);
    }

    if (url.pathname === '/api/scan') {
      const result = await runScan(config);
      const memory = readJson(MEMORY_PATH, { watchlist: [], lastAlerts: {}, lastScan: null });
      memory.lastScan = {
        timestamp: result.timestamp,
        long: result.longCandidates.map(c => c.ticker),
        short: result.shortCandidates.map(c => c.ticker)
      };
      writeJson(MEMORY_PATH, memory);
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/api/telegram/send' && req.method === 'POST') {
      const body = await readBody(req);
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      if (!candidates.length) return sendJson(res, 400, { error: 'No candidates provided' });
      const result = await sendCandidates(candidates, config, Boolean(body.force));
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/yahoo' || url.pathname.startsWith('/yahoo/')) {
      const yahooPath = url.pathname === '/yahoo'
        ? url.searchParams.get('path')
        : url.pathname.replace(/^\/yahoo/, '') + url.search;
      if (!yahooPath) return sendJson(res, 400, { error: 'Missing Yahoo path' });
      const data = await httpsJson('query1.finance.yahoo.com', yahooPath);
      return sendJson(res, 200, data);
    }

    return serveFile(res, path.join(ROOT, url.pathname.replace(/^\/+/, '')));
  } catch (error) {
    log('error', error.message, { path: url.pathname });
    return sendJson(res, 500, { error: error.message });
  }
}

http.createServer(handle).listen(PORT, () => {
  console.log('');
  console.log('Infusion Capital Screener IC V1');
  console.log(`http://localhost:${PORT}`);
  console.log('');
});
