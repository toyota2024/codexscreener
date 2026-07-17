const path = require('path');
const { httpsJson } = require('../utils/http');
const { withCache } = require('../utils/cache');
const { readLines, uniq, round, writeJson, readJson } = require('../utils/helpers');
const { log } = require('../utils/logger');
const { enrichCandles } = require('./indicators');
const { hardVeto } = require('./filters');
const { scoreCandidate } = require('./scoreEngine');
const { detectMarketRegime } = require('./marketRegime');
const { getMarketSession } = require('../utils/marketHours');
const { updateScanHistory } = require('./historyStore');

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

async function runScan(config, options = {}) {
  const startedAt = Date.now();
  const errors = [];
  const rejectionCounts = {};
  const rejectionSamples = [];
  const funnel = {
    universe: 0,
    dataValid: 0,
    trendValid: 0,
    pullbackValid: 0,
    relativeStrengthValid: 0,
    rrValid: 0,
    scoreSufficient: 0,
    candidateFinal: 0
  };
  const tierCounts = { DETECTADO: 0, VALIDADO: 0, MONITOREO: 0, PRIORIZADO: 0 };
  const session = getMarketSession();
  const universe = options.universeOverride || await buildUniverse(config, errors);
  funnel.universe = universe.length;
  const indexMetrics = await loadIndexMetrics(config, errors);
  const market = await detectMarketRegime(indexMetrics.spy, indexMetrics.qqq);
  const buscarLongs = !market.blockLong;
  const buscarShorts = Boolean(market.shortAllowed);
  const spy20 = Number.isFinite(indexMetrics.spy?.returns20d) ? indexMetrics.spy.returns20d : null;
  const qqq20 = Number.isFinite(indexMetrics.qqq?.returns20d) ? indexMetrics.qqq.returns20d : null;
  const sectorMetricCache = new Map();
  const coreUniverse = loadCoreUniverse();
  const metricBySymbol = new Map();
  const deferScoring = config.relativeStrengthMode === 'sectorPercentile';
  const shadowDiagnostics = {
    score75to79: 0,
    score75to79Items: [],
    liquidityDisagreements: 0,
    currentVolumeOnly: 0,
    dollarVolumeOnly: 0,
    liquidityDisagreementItems: []
  };

  const analyzed = [];
  const validationSeries = {};
  await mapLimit(universe, config.scan.requestConcurrency, async symbol => {
    try {
      const metrics = await loadSymbolMetrics(symbol, config);
      metrics.symbol = symbol;
      metrics.coreUniverse = coreUniverse.has(symbol);
      metrics.rsVsSpy20d = Number.isFinite(metrics.returns20d) && Number.isFinite(spy20)
        ? metrics.returns20d - spy20
        : null;
      metrics.rsVsQqq20d = Number.isFinite(metrics.returns20d) && Number.isFinite(qqq20)
        ? metrics.returns20d - qqq20
        : null;
      const dollarVolume20 = Number.isFinite(metrics.avgVolume20) && Number.isFinite(metrics.close)
        ? metrics.avgVolume20 * metrics.close
        : null;
      const currentVolumePass = Number.isFinite(metrics.avgVolume20) && metrics.avgVolume20 >= config.filters.minAvgVolume20;
      const dollarVolumePass = Number.isFinite(dollarVolume20) && dollarVolume20 >= (config.filters.minDollarVolume20 || 20e6);
      if (currentVolumePass !== dollarVolumePass) {
        shadowDiagnostics.liquidityDisagreements++;
        if (currentVolumePass) shadowDiagnostics.currentVolumeOnly++;
        if (dollarVolumePass) shadowDiagnostics.dollarVolumeOnly++;
        shadowDiagnostics.liquidityDisagreementItems.push({
          ticker: symbol,
          avgVolume20: metrics.avgVolume20,
          price: metrics.close,
          dollarVolume20,
          currentVolumePass,
          dollarVolumePass
        });
      }
      const veto = hardVeto(symbol, metrics, config);
      if (!veto.passed) {
        recordRejections(rejectionCounts, rejectionSamples, symbol, veto.codes, veto.reasons);
        analyzed.push({ ticker: symbol, veto: veto.reasons, vetoCodes: veto.codes });
        return;
      }
      funnel.dataValid++;
      const profile = await loadSymbolProfile(symbol, config);
      metrics.marketCap = profile.marketCap;
      const sectorContext = await loadSectorContext(profile.sector, config, sectorMetricCache);
      metrics.sector = sectorContext.sector;
      metrics.sectorEtf = sectorContext.etf;
      metrics.sectorTrend = sectorContext.trend;
      metrics.rsVsSector20d = Number.isFinite(metrics.returns20d) && Number.isFinite(sectorContext.returns20d)
        ? metrics.returns20d - sectorContext.returns20d
        : null;
      metricBySymbol.set(symbol, metrics);
      if (deferScoring) {
        analyzed.push({ ticker: symbol, price: round(metrics.close), metrics });
        return;
      }
      const scored = scoreCandidate(symbol, metrics, market, config, { buscarLongs, buscarShorts });
      if (scored.long || scored.short) {
        validationSeries[symbol] = metrics.candles.map(c => ({
          date: c.date,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close
        }));
      }
      observeScoredSides(symbol, scored, config, funnel, rejectionCounts, rejectionSamples);
      analyzed.push({
        ticker: symbol,
        price: round(metrics.close),
        long: scored.long,
        short: scored.short,
        diagnostics: scored.diagnostics
      });
    } catch (error) {
      errors.push({ ticker: symbol, error: error.message });
      recordRejections(rejectionCounts, rejectionSamples, symbol, ['MISSING_DATA'], [error.message]);
      analyzed.push({ ticker: symbol, error: error.message });
    }
  });

  if (deferScoring) {
    applySectorPercentiles(analyzed, metricBySymbol, config, market, { buscarLongs, buscarShorts }, validationSeries, funnel, rejectionCounts, rejectionSamples);
  }

  const allScored = analyzed
    .flatMap(item => [item.long, item.short].filter(Boolean));
  shadowDiagnostics.score75to79 = allScored.filter(item => item.score >= 75 && item.score < 80).length;
  shadowDiagnostics.score75to79Items = allScored
    .filter(item => item.score >= 75 && item.score < 80)
    .map(item => ({ ticker: item.ticker, bias: item.bias, score: item.score, riskReward: item.riskReward }));

  const isPrimary = item => item.score >= config.scan.minScore && item.riskReward >= config.filters.minRR;

  const longs = analyzed
    .map(item => item.long)
    .filter(Boolean)
    .filter(isPrimary)
    .sort(preferredScoreSort)
    .slice(0, config.scan.maxResultsPerSide);

  const shorts = analyzed
    .map(item => item.short)
    .filter(Boolean)
    .filter(isPrimary)
    .sort(preferredScoreSort)
    .slice(0, config.scan.maxResultsPerSide);
  const eligibleLongPool = allScored
    .filter(item => item.bias === 'LONG')
    .filter(isPrimary)
    .sort(preferredScoreSort);
  const eligibleShortPool = allScored
    .filter(item => item.bias === 'SHORT')
    .filter(isPrimary)
    .sort(preferredScoreSort);

  const primaryKeys = new Set([...longs, ...shorts].map(item => `${item.ticker}:${item.bias}`));
  const monitoringCandidates = allScored
    .filter(item => item.score >= 70)
    .filter(item => !primaryKeys.has(`${item.ticker}:${item.bias}`))
    .sort((a, b) => b.score - a.score || b.riskReward - a.riskReward)
    .slice(0, 12);

  for (const item of allScored) {
    const rsAndRiskOk = !(item.observability?.rejectionCodes || [])
      .some(code => code === 'RELATIVE_STRENGTH_LOW' || code === 'MISSING_DATA' || code === 'RR_INSUFFICIENT');
    item.tier = item.score >= config.scan.minScore && item.riskReward >= config.filters.minRR && rsAndRiskOk
      ? 'PRIORIZADO'
      : item.score >= 70
        ? 'MONITOREO'
        : item.riskReward >= config.filters.minRR
          ? 'VALIDADO'
          : 'DETECTADO';
    tierCounts[item.tier]++;
  }
  tierCounts.DETECTADO += analyzed
    .flatMap(item => Object.values(item.diagnostics || {}).flat())
    .filter(code => code === 'INVALID_SUPPORT' || code === 'EMA_DISTANCE_TOO_HIGH').length;
  funnel.candidateFinal = longs.length + shorts.length;

  const nearMisses = analyzed
    .flatMap(item => [item.long, item.short].filter(Boolean))
    .filter(item => item.score < config.scan.minScore)
    .sort(preferredScoreSort)
    .slice(0, 8);

  const result = {
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    session,
    market,
    universeSize: universe.length,
    universeSymbols: universe,
    validationSeries,
    analyzedCount: analyzed.filter(item => item.long || item.short).length,
    vetoedCount: analyzed.filter(item => item.veto).length,
    errorCount: errors.length,
    longCandidates: longs,
    shortCandidates: shorts,
    monitoringCandidates,
    ...(options.useFullHistoryPool ? {
      historyCandidates: [...eligibleLongPool, ...eligibleShortPool],
      shadowPool: {
        eligibleLong: eligibleLongPool.length,
        eligibleShort: eligibleShortPool.length,
        total: eligibleLongPool.length + eligibleShortPool.length,
        top5Long: longs.length,
        top5Short: shorts.length
      }
    } : {}),
    nearMisses,
    validationPrices: analyzed
      .filter(item => item.price)
      .map(item => ({ ticker: item.ticker, price: item.price })),
    errors: errors.slice(0, 20),
    shadowDiagnostics,
    funnel,
    rejectionSummary: {
      counts: rejectionCounts,
      samples: rejectionSamples.slice(0, 40)
    },
    tierCounts,
    marketFallback: {
      vixDataAvailable: Number.isFinite(market.vix) && Number.isFinite(market.sma20Vix),
      shortAllowed: market.shortAllowed,
      behavior: Number.isFinite(market.vix) && Number.isFinite(market.sma20Vix)
        ? 'VIX rules active'
        : market.regime !== 'BULLISH' ? 'fallback permits SHORT' : 'fallback blocks SHORT'
    },
    disclaimer: 'Este screener genera candidatos para analisis manual y educativo. No constituye recomendacion financiera.'
  };

  const history = options.writeHistory === false ? { records: [], updatedAt: result.timestamp } : updateScanHistory(result, config, options.historyPath);
  result.history = {
    records: history.records.length,
    updatedAt: history.updatedAt
  };
  if (options.persistLastScan !== false) writeJson(path.join(ROOT, 'data', 'last-scan.json'), result);
  if (!options.skipShadow && config.shadow?.enabled !== false) {
    result.shadow = await runShadowScans(result, config);
  }
  log('info', 'Scan completed', {
    longs: longs.length,
    shorts: shorts.length,
    monitoring: monitoringCandidates.length,
    universe: universe.length,
    elapsedMs: result.elapsedMs
  });
  return result;
}

function observeScoredSides(symbol, scored, config, funnel, rejectionCounts, rejectionSamples) {
  for (const bias of ['LONG', 'SHORT']) {
    const candidate = scored[bias.toLowerCase()];
    const codes = scored.diagnostics?.[bias] || [];
    recordRejections(rejectionCounts, rejectionSamples, symbol, codes);
    if (!candidate) continue;
    if (candidate.scoreBreakdown?.trend > 0) funnel.trendValid++;
    funnel.pullbackValid++;
    if (!codes.includes('RELATIVE_STRENGTH_LOW') && !codes.includes('MISSING_DATA')) funnel.relativeStrengthValid++;
    if (candidate.riskReward >= config.filters.minRR) funnel.rrValid++;
    if (candidate.score >= config.scan.minScore) funnel.scoreSufficient++;
  }
}

function applySectorPercentiles(analyzed, metricBySymbol, config, market, options, validationSeries, funnel, rejectionCounts, rejectionSamples) {
  const bySector = new Map();
  for (const metrics of metricBySymbol.values()) {
    const sector = metrics.sector || 'UNKNOWN';
    if (!Number.isFinite(metrics.rsVsSector20d)) continue;
    if (!bySector.has(sector)) bySector.set(sector, []);
    bySector.get(sector).push(metrics.rsVsSector20d);
  }
  for (const item of analyzed) {
    const metrics = metricBySymbol.get(item.ticker);
    if (!metrics) continue;
    const values = bySector.get(metrics.sector || 'UNKNOWN') || [];
    metrics.rsPercentileSector = Number.isFinite(metrics.rsVsSector20d) && values.length
      ? (values.filter(value => value <= metrics.rsVsSector20d).length / values.length) * 100
      : null;
    const scored = scoreCandidate(item.ticker, metrics, market, config, options);
    item.long = scored.long;
    item.short = scored.short;
    item.diagnostics = scored.diagnostics;
    if (scored.long || scored.short) {
      validationSeries[item.ticker] = metrics.candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close }));
    }
    observeScoredSides(item.ticker, scored, config, funnel, rejectionCounts, rejectionSamples);
  }
}

function recordRejections(counts, samples, ticker, codes = [], reasons = []) {
  for (const code of [...new Set(codes)]) {
    counts[code] = (counts[code] || 0) + 1;
    if (samples.length < 100) samples.push({ ticker, code, reason: reasons[codes.indexOf(code)] || null });
  }
}

function loadCoreUniverse() {
  return new Set([
    ...readLines(path.join(ROOT, 'universes', 'nasdaq100.txt')),
    ...readLines(path.join(ROOT, 'universes', 'sp500.txt'))
  ]);
}

function preferredScoreSort(a, b) {
  const aBand = a.score >= 85 && a.score <= 90 ? 1 : 0;
  const bBand = b.score >= 85 && b.score <= 90 ? 1 : 0;
  if (aBand !== bBand) return bBand - aBand;
  return b.score - a.score;
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
    return {
      sector: normalizeSector(quote.sector || quote.sectorDisp || ''),
      marketCap: Number.isFinite(quote.marketCap) ? quote.marketCap : null
    };
  } catch {
    return { sector: '', marketCap: null };
  }
}

async function loadSectorContext(sector, config, cache) {
  const normalized = normalizeSector(sector);
  const etf = SECTOR_ETFS[normalized] || '';
  if (!normalized || !etf) return { sector: normalized, etf, trend: '' };
  if (!cache.has(etf)) {
    cache.set(etf, loadSymbolMetrics(etf, config)
      .then(metrics => ({
        trend: metrics.close > metrics.sma50 ? 'Alcista ✅' : 'Bajista ⚠️',
        returns20d: metrics.returns20d
      }))
      .catch(() => ({ trend: '', returns20d: null })));
  }
  const context = await cache.get(etf);
  return {
    sector: normalized,
    etf,
    trend: context.trend,
    returns20d: context.returns20d
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

const SHADOW_VARIANTS = [
  { id: 'minScore80', patch: {} },
  { id: 'minScore75', patch: { scan: { minScore: 75 } } },
  { id: 'volumeCurrent', patch: {} },
  { id: 'dollarVolume20', patch: { filters: { liquidityMode: 'dollar', minDollarVolume20: 20e6 } } },
  { id: 'atrFlat', patch: { filters: { atrMode: 'flat' } } },
  { id: 'atrByCap', patch: { filters: { atrMode: 'capProfile' } } },
  { id: 'rsCutoff30', patch: { relativeStrengthMode: 'cutoff' } },
  { id: 'rsPercentileSector', patch: { relativeStrengthMode: 'sectorPercentile' } }
];

async function runShadowScans(productionResult, config) {
  const universe = productionResult.universeSymbols || [];
  const variants = await Promise.all(SHADOW_VARIANTS.map(async variant => {
    const variantConfig = mergeVariantConfig(config, variant.patch);
    const historyPath = path.join(ROOT, 'data', `shadow-history-${variant.id}.json`);
    const result = await runScan(variantConfig, {
      universeOverride: universe,
      persistLastScan: false,
      skipShadow: true,
      historyPath,
      useFullHistoryPool: true
    });
    const history = readJson(historyPath, { records: [], scans: [] });
    const completeWindows = (history.records || []).reduce((count, record) => count +
      Object.values(record.validations || {}).filter(validation => validation?.sampleStatus === 'COMPLETE').length, 0);
    log('info', 'Shadow scan completed', {
      variant: variant.id,
      thresholds: {
        minScore: variantConfig.scan.minScore,
        liquidityMode: variantConfig.filters.liquidityMode || 'shares',
        minAvgVolume20: variantConfig.filters.minAvgVolume20,
        minDollarVolume20: variantConfig.filters.minDollarVolume20 || null,
        atrMode: variantConfig.filters.atrMode || 'flat',
        maxAtrPct: variantConfig.filters.maxAtrPct,
        relativeStrengthMode: variantConfig.relativeStrengthMode || 'cutoff'
      },
      longs: result.longCandidates.length,
      shorts: result.shortCandidates.length,
      monitoring: result.monitoringCandidates.length,
      completeWindows,
      pool: result.shadowPool || {
        eligibleLong: result.longCandidates.length,
        eligibleShort: result.shortCandidates.length,
        total: result.longCandidates.length + result.shortCandidates.length,
        top5Long: result.longCandidates.length,
        top5Short: result.shortCandidates.length
      },
      diagnostics: result.shadowDiagnostics,
      errorCount: result.errorCount
    });
    return {
      id: variant.id,
      historyPath: path.relative(ROOT, historyPath),
      universeSymbols: universe.length,
      timestamp: result.timestamp,
      long: result.longCandidates.length,
      short: result.shortCandidates.length,
      monitoring: result.monitoringCandidates.length,
      completeWindows,
      pool: result.shadowPool || {
        eligibleLong: result.longCandidates.length,
        eligibleShort: result.shortCandidates.length,
        total: result.longCandidates.length + result.shortCandidates.length,
        top5Long: result.longCandidates.length,
        top5Short: result.shortCandidates.length
      },
      thresholds: {
        minScore: variantConfig.scan.minScore,
        liquidityMode: variantConfig.filters.liquidityMode || 'shares',
        minAvgVolume20: variantConfig.filters.minAvgVolume20,
        minDollarVolume20: variantConfig.filters.minDollarVolume20 || null,
        atrMode: variantConfig.filters.atrMode || 'flat',
        maxAtrPct: variantConfig.filters.maxAtrPct,
        relativeStrengthMode: variantConfig.relativeStrengthMode || 'cutoff'
      },
      diagnostics: result.shadowDiagnostics,
      errorCount: result.errorCount,
      errorTickers: result.errors.map(error => error.ticker).sort()
    };
  }));
  const baselineErrors = JSON.stringify(variants[0]?.errorTickers || []);
  return {
    mode: 'forward-shadow',
    minimumCompleteMarketDays: config.shadow?.minimumCompleteMarketDays || 30,
    minimumCompleteWindows: config.shadow?.minimumCompleteWindows || 20,
    errorsIdentical: variants.every(variant => JSON.stringify(variant.errorTickers || []) === baselineErrors),
    variants
  };
}

function mergeVariantConfig(base, patch) {
  return {
    ...base,
    scan: { ...base.scan, ...(patch.scan || {}) },
    filters: { ...base.filters, ...(patch.filters || {}) },
    ...(patch.relativeStrengthMode ? { relativeStrengthMode: patch.relativeStrengthMode } : {})
  };
}

async function loadHistory(symbol, config) {
  const urlPath = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${config.scan.historyRange}&interval=${config.scan.historyInterval}&includePrePost=false&events=div%2Csplits`;
  const { value } = await withCache(`chart:${symbol}:${config.scan.historyRange}:${config.scan.historyInterval}`, config.cacheTtlSeconds.chart, () =>
    httpsJson('query1.finance.yahoo.com', urlPath)
  );
  const result = value?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const adjClose = result?.indicators?.adjclose?.[0]?.adjclose || [];
  const timestamps = result?.timestamp || [];
  if (!result || !quote || !timestamps.length) throw new Error('Yahoo chart sin datos');
  const candles = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    ...adjustedOhlc(quote, adjClose, i),
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

function adjustedOhlc(quote, adjClose, i) {
  const close = quote.close?.[i];
  const adjustedClose = adjClose?.[i];
  const ratio = Number.isFinite(close) && close !== 0 && Number.isFinite(adjustedClose)
    ? adjustedClose / close
    : 1;
  return {
    open: quote.open?.[i] * ratio,
    high: quote.high?.[i] * ratio,
    low: quote.low?.[i] * ratio,
    close: Number.isFinite(adjustedClose) ? adjustedClose : close
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

module.exports = { runScan, loadHistory, runShadowScans };
