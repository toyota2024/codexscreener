const path = require('path');
const { httpsJson } = require('../utils/http');
const { withCache } = require('../utils/cache');
const { readLines, uniq, round, writeJson } = require('../utils/helpers');
const { log } = require('../utils/logger');
const { enrichCandles } = require('./indicators');
const { hardVeto } = require('./filters');
const { scoreCandidate } = require('./scoreEngine');
const { detectMarketRegime } = require('./marketRegime');
const { getMarketSession } = require('../utils/marketHours');

const ROOT = path.join(__dirname, '..');
const SECTOR_ETFS = {
  Technology: 'XLK',
  Healthcare: 'XLV',
  Financials: 'XLF',
  Energy: 'XLE',
  Utilities: 'XLU',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  Industrials: 'XLI',
  Materials: 'XLB',
  'Real Estate': 'XLRE',
  Communication: 'XLC'
};

async function runScan(config) {
  const startedAt = Date.now();
  const errors = [];
  const session = getMarketSession();
  const universe = await buildUniverse(config, errors);
  const indexMetrics = await loadIndexMetrics(config, errors);
  const market = detectMarketRegime(indexMetrics.spy, indexMetrics.qqq);
  const spy20 = indexMetrics.spy?.returns20d || 0;
  const qqq20 = indexMetrics.qqq?.returns20d || 0;
  const sectorMetricCache = new Map();

  const analyzed = [];
  await mapLimit(universe, config.scan.requestConcurrency, async symbol => {
    try {
      const metrics = await loadSymbolMetrics(symbol, config);
      metrics.symbol = symbol;
      metrics.rsVsSpy20d = (metrics.returns20d || 0) - spy20;
      metrics.rsVsQqq20d = (metrics.returns20d || 0) - qqq20;
      const veto = hardVeto(symbol, metrics, config);
      if (!veto.passed) {
        analyzed.push({ ticker: symbol, veto: veto.reasons });
        return;
      }
      const profile = await loadSymbolProfile(symbol, config);
      const sectorContext = await loadSectorContext(profile.sector, config, sectorMetricCache);
      metrics.sector = sectorContext.sector;
      metrics.sectorEtf = sectorContext.etf;
      metrics.sectorTrend = sectorContext.trend;
      const scored = scoreCandidate(symbol, metrics, market, config);
      analyzed.push({
        ticker: symbol,
        price: round(metrics.close),
        long: scored.long,
        short: scored.short
      });
    } catch (error) {
      errors.push({ ticker: symbol, error: error.message });
      analyzed.push({ ticker: symbol, error: error.message });
    }
  });

  const allScored = analyzed
    .flatMap(item => [item.long, item.short].filter(Boolean));

  const isPrimary = item => item.score >= config.scan.minScore && item.riskReward >= config.filters.minRR;

  const longs = analyzed
    .map(item => item.long)
    .filter(Boolean)
    .filter(isPrimary)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.scan.maxResultsPerSide);

  const shorts = analyzed
    .map(item => item.short)
    .filter(Boolean)
    .filter(isPrimary)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.scan.maxResultsPerSide);

  const primaryKeys = new Set([...longs, ...shorts].map(item => `${item.ticker}:${item.bias}`));
  const monitoringCandidates = allScored
    .filter(item => item.score >= 70)
    .filter(item => !primaryKeys.has(`${item.ticker}:${item.bias}`))
    .sort((a, b) => b.score - a.score || b.riskReward - a.riskReward)
    .slice(0, 12);

  const nearMisses = analyzed
    .flatMap(item => [item.long, item.short].filter(Boolean))
    .filter(item => item.score < config.scan.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const result = {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    session,
    market,
    universeSize: universe.length,
    analyzedCount: analyzed.filter(item => item.long || item.short).length,
    vetoedCount: analyzed.filter(item => item.veto).length,
    errorCount: errors.length,
    longCandidates: longs,
    shortCandidates: shorts,
    monitoringCandidates,
    nearMisses,
    errors: errors.slice(0, 20),
    disclaimer: 'Este screener genera candidatos para analisis manual y educativo. No constituye recomendacion financiera.'
  };

  writeJson(path.join(ROOT, 'data', 'last-scan.json'), result);
  log('info', 'Scan completed', {
    longs: longs.length,
    shorts: shorts.length,
    monitoring: monitoringCandidates.length,
    universe: universe.length,
    elapsedMs: result.elapsedMs
  });
  return result;
}

async function buildUniverse(config, errors) {
  const movers = await loadYahooMovers(config, errors);
  const staticUniverse = [
    ...readLines(path.join(ROOT, 'universes', 'nasdaq100.txt')),
    ...readLines(path.join(ROOT, 'universes', 'sp500.txt')),
    ...readLines(path.join(ROOT, 'universes', 'liquid.txt'))
  ];
  return uniq([...movers, ...staticUniverse, 'SPY', 'QQQ'])
    .filter(symbol => symbol !== 'BRK-B')
    .filter(symbol => !(config.excludeCandidateSymbols || []).includes(symbol))
    .slice(0, config.scan.maxUniverseSize);
}

async function loadYahooMovers(config, errors) {
  const scrIds = ['day_gainers', 'day_losers', 'most_actives'];
  const symbols = [];
  for (const id of scrIds) {
    try {
      const pathName = `/v1/finance/screener/predefined/saved?scrIds=${id}&count=30`;
      const { value } = await withCache(`movers:${id}`, config.cacheTtlSeconds.movers, () =>
        httpsJson('query1.finance.yahoo.com', pathName)
      );
      const quotes = value?.finance?.result?.[0]?.quotes || [];
      symbols.push(...quotes.map(q => q.symbol));
    } catch (error) {
      errors.push({ source: `yahoo:${id}`, error: error.message });
    }
  }
  try {
    const { value } = await withCache('movers:trending', config.cacheTtlSeconds.movers, () =>
      httpsJson('query1.finance.yahoo.com', '/v1/finance/trending/US?count=30')
    );
    symbols.push(...(value?.finance?.result?.[0]?.quotes || []).map(q => q.symbol));
  } catch (error) {
    errors.push({ source: 'yahoo:trending', error: error.message });
  }
  return uniq(symbols).filter(symbol => /^[A-Z.-]{1,8}$/.test(symbol));
}

async function loadIndexMetrics(config, errors) {
  const out = {};
  for (const symbol of ['SPY', 'QQQ']) {
    try {
      out[symbol.toLowerCase()] = await loadSymbolMetrics(symbol, config);
      out[symbol.toLowerCase()].symbol = symbol;
    } catch (error) {
      errors.push({ ticker: symbol, error: error.message });
    }
  }
  return out;
}

async function loadSymbolMetrics(symbol, config) {
  const history = await loadHistory(symbol, config);
  const metrics = enrichCandles(history.candles);
  metrics.name = history.name;
  return metrics;
}

async function loadSymbolProfile(symbol, config) {
  try {
    const ttl = config.cacheTtlSeconds.profile || 86400;
    const pathName = `/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=5&newsCount=0`;
    const { value } = await withCache(`profile:${symbol}`, ttl, () =>
      httpsJson('query1.finance.yahoo.com', pathName)
    );
    const quote = (value?.quotes || []).find(item => item.symbol === symbol) || value?.quotes?.[0] || {};
    return { sector: normalizeSector(quote.sector || quote.sectorDisp || '') };
  } catch {
    return { sector: '' };
  }
}

async function loadSectorContext(sector, config, cache) {
  const normalized = normalizeSector(sector);
  const etf = SECTOR_ETFS[normalized] || '';
  if (!normalized || !etf) return { sector: normalized, etf, trend: '' };
  if (!cache.has(etf)) {
    cache.set(etf, loadSymbolMetrics(etf, config)
      .then(metrics => metrics.close > metrics.sma50 ? 'Alcista ✅' : 'Bajista ⚠️')
      .catch(() => ''));
  }
  return {
    sector: normalized,
    etf,
    trend: await cache.get(etf)
  };
}

function normalizeSector(sector) {
  const value = String(sector || '').trim();
  const map = {
    'Financial Services': 'Financials',
    'Consumer Cyclical': 'Consumer Discretionary',
    'Consumer Defensive': 'Consumer Staples',
    'Communication Services': 'Communication',
    'Basic Materials': 'Materials'
  };
  return map[value] || value;
}

async function loadHistory(symbol, config) {
  const urlPath = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${config.scan.historyRange}&interval=${config.scan.historyInterval}&includePrePost=false&events=div%2Csplits`;
  const { value } = await withCache(`chart:${symbol}:${config.scan.historyRange}:${config.scan.historyInterval}`, config.cacheTtlSeconds.chart, () =>
    httpsJson('query1.finance.yahoo.com', urlPath)
  );
  const result = value?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!result || !quote || !timestamps.length) throw new Error('Yahoo chart sin datos');
  const candles = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: quote.open?.[i],
    high: quote.high?.[i],
    low: quote.low?.[i],
    close: quote.close?.[i],
    volume: quote.volume?.[i]
  })).filter(c =>
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume)
  );
  if (candles.length < 30) throw new Error('historial insuficiente');
  const meta = result.meta || {};
  return {
    candles,
    name: meta.longName || meta.shortName || meta.displayName || ''
  };
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}

module.exports = { runScan, loadHistory };
