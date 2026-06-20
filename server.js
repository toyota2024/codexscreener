const http = require('http');
const fs = require('fs');
const path = require('path');
const { httpsJson } = require('./utils/http');
const { readJson, writeJson, round } = require('./utils/helpers');
const { log } = require('./utils/logger');
const { runScan } = require('./scanners/scanEngine');
const { readHistoryEntries } = require('./scanners/historyStore');
const { sendCandidates, getTelegramConfig } = require('./telegram/telegramBot');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');
const HISTORY_PATH = path.join(ROOT, 'data', 'history.json');
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

function readHistory() {
  return readJson(HISTORY_PATH, []);
}

function saveHistoryEntry(result) {
  const history = readHistory();
  const allCandidates = [
    ...(result.longCandidates || []),
    ...(result.shortCandidates || []),
    ...(result.monitoringCandidates || [])
  ];
  const entry = {
    id: result.timestamp,
    fecha: result.timestamp,
    mercado: result.market?.bias || 'NEUTRAL',
    candidatos: allCandidates.map(c => ({
      ticker: c.ticker,
      nombre: c.name || '',
      sector: c.sector || '',
      bias: c.bias,
      score: c.score,
      riskReward: c.riskReward,
      entrada: c.metrics?.price || null,
      stop: parseFloat(String(c.stopIdea || '').replace(/[^\d.-]/g, '')) || null,
      target: parseFloat(c.targetIdea) || null,
      setup: c.setup || '',
      resultado_5d: null,
      resultado_15d: null,
      resultado_30d: null
    }))
  };
  history.push(entry);
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const filtered = history.filter(e => new Date(e.fecha).getTime() > cutoff);
  writeJson(HISTORY_PATH, filtered);
}

async function fetchCurrentPrice(symbol) {
  try {
    const data = await httpsJson('query1.finance.yahoo.com',
      `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d&includePrePost=false`);
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

async function updateHistoryResults() {
  const history = readHistory();
  let count = 0;
  const now = Date.now();
  for (const entry of history) {
    const entryTime = new Date(entry.fecha).getTime();
    const daysSince = (now - entryTime) / 86400000;
    for (const c of entry.candidatos) {
      const needs5 = c.resultado_5d === null && daysSince >= 5;
      const needs15 = c.resultado_15d === null && daysSince >= 15;
      const needs30 = c.resultado_30d === null && daysSince >= 30;
      if ((needs5 || needs15 || needs30) && c.entrada) {
        const price = await fetchCurrentPrice(c.ticker);
        if (price) {
          const ret = c.bias === 'SHORT'
            ? round(((c.entrada - price) / c.entrada) * 100, 2)
            : round(((price - c.entrada) / c.entrada) * 100, 2);
          if (needs5) { c.resultado_5d = ret; count++; }
          if (needs15) { c.resultado_15d = ret; count++; }
          if (needs30) { c.resultado_30d = ret; count++; }
        }
      }
    }
  }
  if (count > 0) writeJson(HISTORY_PATH, history);
  return { updated: count };
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

    if (url.pathname === '/api/history') {
      return sendJson(res, 200, readHistoryEntries());
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

    if (url.pathname === '/api/update-results') {
      const result = await updateHistoryResults();
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
