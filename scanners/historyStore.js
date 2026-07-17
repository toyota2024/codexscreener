const path = require('path');
const { readJson, writeJson, round } = require('../utils/helpers');

const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.json');

function updateScanHistory(scanResult, config, historyPath = HISTORY_PATH) {
  const history = readJson(historyPath, { records: [] });
  const records = Array.isArray(history.records) ? history.records : [];
  const scans = Array.isArray(history.scans) ? history.scans : [];
  const scanTs = Date.parse(scanResult.timestamp);
  const windowMs = (config.history?.dedupeWindowMinutes || 60) * 60 * 1000;
  const validationWindows = config.history?.validationWindowsDays || [5, 15, 30];
  const neutralBand = config.history?.neutralBandPct || 2;
  const historyCandidates = Array.isArray(scanResult.historyCandidates)
    ? scanResult.historyCandidates
    : [
      ...(scanResult.longCandidates || []),
      ...(scanResult.shortCandidates || []),
      ...(scanResult.monitoringCandidates || [])
    ];
  const candidates = historyCandidates.map(candidate => ({
    candidate,
    historyType: candidate.bias === 'SHORT' ? 'SHORT' : candidate.bias === 'LONG' ? 'LONG' : 'MONITOR'
  }));

  const candidateKeys = [];
  const updatedRecordKeysThisScan = new Set();
  for (const { candidate, historyType } of candidates) {
    const key = makeRecordKey(candidate, scanTs, windowMs);
    const existing = records.find(record => record.key === key);
    const payload = buildRecord(candidate, scanResult, key, validationWindows, historyType);
    if (existing) {
      candidateKeys.push(existing.key);
      updateExistingRecord(existing, payload, scanResult.timestamp, updatedRecordKeysThisScan);
      continue;
    }

    const similar = findRecentSimilarRecord(records, candidate, historyType, scanResult.timestamp, config);
    if (similar) {
      candidateKeys.push(similar.key);
      updateSignalSeen(similar, scanResult.timestamp, updatedRecordKeysThisScan);
    } else {
      candidateKeys.push(key);
      records.push(payload);
    }
  }

  const scanKey = String(Math.floor(scanTs / windowMs) * windowMs);
  const existingScan = scans.find(scan => scan.key === scanKey);
  const scanPayload = {
    key: scanKey,
    timestamp: scanResult.timestamp,
    marketBias: scanResult.market?.bias || 'NEUTRAL',
    universeSymbols: Array.isArray(scanResult.universeSymbols) ? scanResult.universeSymbols : [],
    candidateKeys,
    candidatePoolSize: candidates.length,
    topCandidateCount: (scanResult.longCandidates || []).length +
      (scanResult.shortCandidates || []).length,
    reportedCandidateCount: (scanResult.longCandidates || []).length +
      (scanResult.shortCandidates || []).length + (scanResult.monitoringCandidates || []).length
  };
  if (existingScan) {
    existingScan.timestamp = scanResult.timestamp;
    existingScan.marketBias = scanPayload.marketBias;
    existingScan.universeSymbols = scanPayload.universeSymbols;
    existingScan.candidateKeys = candidateKeys;
  } else {
    scans.push(scanPayload);
  }

  validateRecords(records, scanResult, validationWindows, neutralBand, scanResult.validationSeries || {});
  history.records = records
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 1000);
  history.scans = scans
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 250);
  history.updatedAt = scanResult.timestamp;
  writeJson(historyPath, history);
  return history;
}

function makeRecordKey(candidate, scanTs, windowMs) {
  const bucket = Math.floor(scanTs / windowMs) * windowMs;
  return `${candidate.ticker}:${candidate.bias}:${bucket}`;
}

function updateExistingRecord(record, payload, nowIso, updatedRecordKeysThisScan) {
  const timestamp = record.timestamp;
  const validations = record.validations || payload.validations;
  const seenCount = record.seenCount;
  Object.assign(record, payload, {
    timestamp,
    validations,
    seenCount
  });
  updateSignalSeen(record, nowIso, updatedRecordKeysThisScan);
}

function updateSignalSeen(record, nowIso, updatedRecordKeysThisScan) {
  if (!updatedRecordKeysThisScan.has(record.key)) {
    record.seenCount = (record.seenCount || 1) + 1;
    updatedRecordKeysThisScan.add(record.key);
  }
  record.lastSeenAt = nowIso;
  record.signalDurationHours = getSignalDurationHours(record, nowIso);
}

function normalizeSetup(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasSetup(value) {
  return normalizeSetup(value).length > 0;
}

function getSignalDurationHours(record, nowIso) {
  const start = Date.parse(record.timestamp);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return null;
  return round((now - start) / 3600000, 1);
}

function findRecentSimilarRecord(records, candidate, historyType, nowIso, config) {
  const now = Date.parse(nowIso);
  const historyConfig = config.history || {};
  const windowHours = historyConfig.extendedDedupeWindowHours ?? 48;
  const priceThresholdPct = historyConfig.extendedDedupePriceThresholdPct ?? 2;
  const scoreThreshold = historyConfig.extendedDedupeScoreThreshold ?? 8;
  const windowMs = windowHours * 60 * 60 * 1000;

  const candidateEntry = Number(candidate.entryPrice ?? candidate.metrics?.price);
  const candidateScore = Number(candidate.score);
  const candidateSetup = normalizeSetup(candidate.setup);
  if (!hasSetup(candidate.setup)) return null;

  return records.find(record => {
    if (record.ticker !== candidate.ticker) return false;
    if (record.bias !== candidate.bias) return false;
    if (record.historyType !== historyType) return false;
    if (!hasSetup(record.setup)) return false;

    const lastSeen = Date.parse(record.lastSeenAt || record.timestamp);
    if (!Number.isFinite(lastSeen)) return false;
    if (now - lastSeen > windowMs) return false;

    const recordEntry = Number(record.entryPrice);
    const recordScore = Number(record.score);
    const recordSetup = normalizeSetup(record.setup);

    const priceChangePct = Number.isFinite(candidateEntry) && Number.isFinite(recordEntry) && recordEntry
      ? Math.abs((candidateEntry - recordEntry) / recordEntry) * 100
      : Infinity;

    const scoreChange = Number.isFinite(candidateScore) && Number.isFinite(recordScore)
      ? Math.abs(candidateScore - recordScore)
      : Infinity;

    return (
      priceChangePct < priceThresholdPct &&
      scoreChange < scoreThreshold &&
      candidateSetup === recordSetup
    );
  }) || null;
}

function buildRecord(candidate, scanResult, key, validationWindows, historyType) {
  const spy = scanResult.market?.spy || {};
  const validations = {};
  for (const days of validationWindows) {
    validations[`${days}D`] = null;
  }
  return {
    key,
    timestamp: scanResult.timestamp,
    lastSeenAt: scanResult.timestamp,
    seenCount: 1,
    ticker: candidate.ticker,
    name: candidate.name || '',
    bias: candidate.bias,
    historyType,
    score: candidate.score,
    riskReward: candidate.riskReward ?? null,
    setup: candidate.setup,
    setupCategory: classifySetup(candidate.setup),
    capCategory: classifyCap(candidate.metrics?.marketCap),
    entryPrice: candidate.entryPrice ?? candidate.metrics?.price ?? null,
    stopPrice: candidate.stopPrice ?? null,
    targetPrice: candidate.targetPrice ?? null,
    spyPriceAtScan: spy.price || null,
    spyWeeklyReturnAtScan: spy.returns5d || null,
    spyWeeklyStateAtScan: getSpyWeeklyState(spy.returns5d),
    marketBiasAtScan: scanResult.market?.bias || 'NEUTRAL',
    coreSatellite: candidate.coreSatellite || null,
    distEma20Pct: candidate.metrics?.distEma20Pct ?? null,
    signalDurationHours: 0,
    validations
  };
}

function readWinRateSummary(neutralBand = 2) {
  const history = readJson(HISTORY_PATH, { records: [] });
  const records = Array.isArray(history.records) ? history.records : [];
  return calculateWinRate(records, neutralBand);
}

function calculateWinRate(records, neutralBand = 2) {
  const types = ['LONG', 'SHORT', 'MONITOR'];
  const windows = ['5D', '15D', '30D'];
  const firstRecordByTicker = new Map();
  const chronologicalRecords = [...records].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const record of chronologicalRecords) {
    const ticker = String(record.ticker || '').trim().toUpperCase();
    if (ticker && !firstRecordByTicker.has(ticker)) firstRecordByTicker.set(ticker, record);
  }
  const summary = Object.fromEntries(types.map(type => [
    type,
    Object.fromEntries(windows.map(window => [window, { wins: 0, losses: 0, total: 0, winRate: null }]))
  ]));

  for (const record of firstRecordByTicker.values()) {
    const type = types.includes(record.historyType) ? record.historyType : record.bias;
    if (!summary[type]) continue;
    for (const window of windows) {
      const validation = record.validations?.[window];
      if (!validation || classifyValidation(validation) !== 'COMPLETE') continue;
      let result = validation.candidateReturnPct;
      if (!Number.isFinite(result) && Number.isFinite(validation.directionalReturnPct)) {
        result = record.bias === 'SHORT' ? -validation.directionalReturnPct : validation.directionalReturnPct;
      }
      if (!Number.isFinite(result) || Math.abs(result) <= neutralBand) continue;
      const win = record.bias === 'SHORT' ? result < -neutralBand : result > neutralBand;
      if (win) summary[type][window].wins++;
      else summary[type][window].losses++;
    }
  }

  for (const type of types) {
    for (const window of windows) {
      const cell = summary[type][window];
      cell.total = cell.wins + cell.losses;
      cell.winRate = cell.total ? round((cell.wins / cell.total) * 100, 1) : null;
    }
  }
  summary.segments = {
    setup: calculateSegmentSummary(firstRecordByTicker.values(), 'setupCategory', neutralBand),
    cap: calculateSegmentSummary(firstRecordByTicker.values(), 'capCategory', neutralBand),
    bias: calculateSegmentSummary(firstRecordByTicker.values(), 'bias', neutralBand)
  };
  summary.sampleStatusCounts = countSampleStatuses(records);
  return summary;
}

function classifyValidation(validation) {
  if (!validation || !Number.isFinite(validation.excursionBars)) return 'INSUFFICIENT_SAMPLE';
  if (validation.excursionBars >= 5) return 'COMPLETE';
  if (validation.excursionBars > 0) return 'PARTIAL';
  return 'INSUFFICIENT_SAMPLE';
}

function countSampleStatuses(records) {
  const counts = Object.fromEntries(['5D', '15D', '30D'].map(window => [window, {
    COMPLETE: 0,
    PARTIAL: 0,
    INSUFFICIENT_SAMPLE: 0
  }]));
  for (const record of records) {
    for (const window of Object.keys(counts)) {
      counts[window][classifyValidation(record.validations?.[window])]++;
    }
  }
  return counts;
}

function calculateSegmentSummary(records, field, neutralBand) {
  const result = {};
  for (const record of records) {
    const key = record[field] || 'UNKNOWN';
    result[key] ||= Object.fromEntries(['5D', '15D', '30D'].map(window => [window, { wins: 0, losses: 0, total: 0, winRate: null }]));
    for (const window of ['5D', '15D', '30D']) {
      const validation = record.validations?.[window];
      if (!validation || classifyValidation(validation) !== 'COMPLETE') continue;
      const value = Number.isFinite(validation.candidateReturnPct)
        ? validation.candidateReturnPct
        : validation.directionalReturnPct;
      if (!Number.isFinite(value) || Math.abs(value) <= neutralBand) continue;
      const win = record.bias === 'SHORT' ? value < -neutralBand : value > neutralBand;
      if (win) result[key][window].wins++;
      else result[key][window].losses++;
    }
  }
  for (const cells of Object.values(result)) {
    for (const cell of Object.values(cells)) {
      cell.total = cell.wins + cell.losses;
      cell.winRate = cell.total ? round((cell.wins / cell.total) * 100, 1) : null;
    }
  }
  return result;
}

function readHistoryEntries() {
  const history = readJson(HISTORY_PATH, { records: [], scans: [] });
  const records = Array.isArray(history.records) ? history.records : [];
  const byKey = new Map(records.map(record => [record.key, record]));
  let scans = Array.isArray(history.scans) ? history.scans : [];

  // Older files did not have scan metadata. Recover entries from record buckets.
  if (!scans.length && records.length) {
    const recovered = new Map();
    for (const record of records) {
      const key = String(record.key || '').split(':').pop() || record.timestamp;
      const scan = recovered.get(key) || {
        key,
        timestamp: record.timestamp,
        marketBias: record.marketBiasAtScan || 'NEUTRAL',
        candidateKeys: []
      };
      scan.candidateKeys.push(record.key);
      if (Date.parse(record.lastSeenAt || record.timestamp) > Date.parse(scan.timestamp)) {
        scan.timestamp = record.lastSeenAt || record.timestamp;
      }
      recovered.set(key, scan);
    }
    scans = [...recovered.values()];
  }

  return scans
    .map(scan => ({
      id: scan.key,
      fecha: scan.timestamp,
      mercado: scan.marketBias || 'NEUTRAL',
      candidatos: (scan.candidateKeys || [])
        .map(key => byKey.get(key))
        .filter(Boolean)
        .map(toUiCandidate)
    }))
    .sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha));
}

function toUiCandidate(record) {
  const result = days => record.validations?.[`${days}D`]?.directionalReturnPct ?? null;
  const excursion = days => record.validations?.[`${days}D`] || {};
  const status = days => classifyValidation(record.validations?.[`${days}D`]);
  return {
    ticker: record.ticker,
    nombre: record.name || '',
    bias: record.bias,
    score: record.score,
    riskReward: record.riskReward ?? null,
    entrada: record.entryPrice,
    setup: record.setup || '',
    setupCategory: record.setupCategory || 'UNKNOWN',
    capCategory: record.capCategory || 'UNKNOWN',
    resultado_5d: result(5),
    resultado_15d: result(15),
    resultado_30d: result(30),
    mae_5d: excursion(5).maePct ?? null,
    mfe_5d: excursion(5).mfePct ?? null,
    mae_15d: excursion(15).maePct ?? null,
    mfe_15d: excursion(15).mfePct ?? null,
    mae_30d: excursion(30).maePct ?? null,
    mfe_30d: excursion(30).mfePct ?? null,
    sampleStatus_5d: status(5),
    sampleStatus_15d: status(15),
    sampleStatus_30d: status(30)
  };
}

function validateRecords(records, scanResult, validationWindows, neutralBand, validationSeries) {
  const current = new Map();
  for (const item of scanResult.validationPrices || []) {
    current.set(item.ticker, item.price);
  }
  const spyPrice = scanResult.market?.spy?.price;
  const now = Date.parse(scanResult.timestamp);
  for (const record of records) {
    const ageDays = (now - Date.parse(record.timestamp)) / 86400000;
    const price = current.get(record.ticker);
    if (price == null || record.entryPrice == null) continue;
    for (const days of validationWindows) {
      if (ageDays < days) continue;
      const key = `${days}D`;
      const existing = record.validations?.[key];
      const series = validationSeries[record.ticker] || [];
      const excursion = calculateExcursion(record, series, days);
      if (existing && !excursion) continue;
      const candidateReturn = ((price - record.entryPrice) / record.entryPrice) * 100;
      const directionalReturn = record.bias === 'SHORT' ? -candidateReturn : candidateReturn;
      const spyReturn = record.spyPriceAtScan && spyPrice ? ((spyPrice - record.spyPriceAtScan) / record.spyPriceAtScan) * 100 : null;
      const alpha = spyReturn == null ? null : directionalReturn - spyReturn;
      record.validations[key] = {
        ...(existing || {}),
        candidateReturnPct: round(candidateReturn, 2),
        directionalReturnPct: round(directionalReturn, 2),
        spyReturnPct: round(spyReturn, 2),
        alphaPct: round(alpha, 2),
        outcome: Math.abs(directionalReturn) <= neutralBand ? 'NEUTRAL' : directionalReturn > 0 ? 'WIN' : 'LOSS',
        validatedAt: scanResult.timestamp,
        sampleStatus: classifyValidation(excursion),
        expectedBars: 5,
        ...(excursion || {})
      };
    }
  }
}

function calculateExcursion(record, series, days) {
  if (!Array.isArray(series) || !series.length || record.entryPrice == null) return null;
  const start = Date.parse(record.timestamp);
  if (!Number.isFinite(start)) return null;
  const end = start + days * 86400000;
  const candles = series.filter(c => {
    const ts = Date.parse(c.date);
    return Number.isFinite(ts) && ts >= start && ts <= end &&
      Number.isFinite(c.high) && Number.isFinite(c.low);
  });
  if (!candles.length) return null;
  const entry = Number(record.entryPrice);
  if (!Number.isFinite(entry) || entry === 0) return null;
  const directional = record.bias === 'SHORT'
    ? candles.map(c => ({ favorable: ((entry - c.low) / entry) * 100, adverse: ((entry - c.high) / entry) * 100 }))
    : candles.map(c => ({ favorable: ((c.high - entry) / entry) * 100, adverse: ((c.low - entry) / entry) * 100 }));
  return {
    maePct: round(Math.min(...directional.map(x => x.adverse)), 2),
    mfePct: round(Math.max(...directional.map(x => x.favorable)), 2),
    excursionBars: candles.length,
    sampleStatus: candles.length >= 5 ? 'COMPLETE' : 'PARTIAL'
  };
}

function classifySetup(setup) {
  const value = normalizeSetup(setup);
  if (!value) return 'UNKNOWN';
  if (value.includes('breakout') || value.includes('breakdown')) return 'breakout';
  if (value.includes('reversal') || value.includes('rebote')) return 'reversal';
  if (value.includes('pullback')) return 'pullback';
  if (value.includes('continuation') || value.includes('compression') || value.includes('momentum')) return 'momentum';
  return 'UNKNOWN';
}

function classifyCap(marketCap) {
  if (!Number.isFinite(marketCap)) return 'UNKNOWN';
  if (marketCap >= 10e9) return 'large_cap';
  if (marketCap >= 2e9) return 'mid_cap';
  return 'small_cap';
}

function getSpyWeeklyState(value) {
  if (!Number.isFinite(value)) return 'UNKNOWN';
  if (value > 0) return 'UP';
  if (value < 0) return 'DOWN';
  return 'FLAT';
}

module.exports = { updateScanHistory, readHistoryEntries, readWinRateSummary, calculateWinRate, calculateExcursion };
