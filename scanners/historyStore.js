const path = require('path');
const { readJson, writeJson, round } = require('../utils/helpers');

const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.json');

function updateScanHistory(scanResult, config) {
  const history = readJson(HISTORY_PATH, { records: [] });
  const records = Array.isArray(history.records) ? history.records : [];
  const scanTs = Date.parse(scanResult.timestamp);
  const windowMs = (config.history?.dedupeWindowMinutes || 60) * 60 * 1000;
  const validationWindows = config.history?.validationWindowsDays || [5, 15, 30];
  const neutralBand = config.history?.neutralBandPct || 2;
  const candidates = [
    ...(scanResult.longCandidates || []),
    ...(scanResult.shortCandidates || [])
  ];

  for (const candidate of candidates) {
    const key = makeRecordKey(candidate, scanTs, windowMs);
    const existing = records.find(record => record.key === key);
    const payload = buildRecord(candidate, scanResult, key, validationWindows);
    if (existing) {
      if (candidate.score > existing.score) Object.assign(existing, payload);
      existing.seenCount = (existing.seenCount || 1) + 1;
      existing.lastSeenAt = scanResult.timestamp;
    } else {
      records.push(payload);
    }
  }

  validateRecords(records, scanResult, validationWindows, neutralBand);
  history.records = records
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 1000);
  history.updatedAt = scanResult.timestamp;
  writeJson(HISTORY_PATH, history);
  return history;
}

function makeRecordKey(candidate, scanTs, windowMs) {
  const bucket = Math.floor(scanTs / windowMs) * windowMs;
  return `${candidate.ticker}:${candidate.bias}:${bucket}`;
}

function buildRecord(candidate, scanResult, key, validationWindows) {
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
    bias: candidate.bias,
    score: candidate.score,
    setup: candidate.setup,
    entryPrice: candidate.metrics?.price || null,
    spyPriceAtScan: spy.price || null,
    spyWeeklyReturnAtScan: spy.returns5d || null,
    spyWeeklyStateAtScan: getSpyWeeklyState(spy.returns5d),
    marketBiasAtScan: scanResult.market?.bias || 'NEUTRAL',
    coreSatellite: candidate.coreSatellite || null,
    distEma20Pct: candidate.metrics?.distEma20Pct ?? null,
    validations
  };
}

function validateRecords(records, scanResult, validationWindows, neutralBand) {
  const current = new Map();
  for (const item of scanResult.validationPrices || []) {
    current.set(item.ticker, item.price);
  }
  const spyPrice = scanResult.market?.spy?.price;
  const now = Date.parse(scanResult.timestamp);
  for (const record of records) {
    const ageDays = (now - Date.parse(record.timestamp)) / 86400000;
    const price = current.get(record.ticker);
    if (!price || !record.entryPrice) continue;
    for (const days of validationWindows) {
      if (ageDays < days) continue;
      const key = `${days}D`;
      if (record.validations?.[key]) continue;
      const candidateReturn = ((price - record.entryPrice) / record.entryPrice) * 100;
      const directionalReturn = record.bias === 'SHORT' ? -candidateReturn : candidateReturn;
      const spyReturn = record.spyPriceAtScan && spyPrice ? ((spyPrice - record.spyPriceAtScan) / record.spyPriceAtScan) * 100 : null;
      const alpha = spyReturn == null ? null : directionalReturn - spyReturn;
      record.validations[key] = {
        candidateReturnPct: round(candidateReturn, 2),
        directionalReturnPct: round(directionalReturn, 2),
        spyReturnPct: round(spyReturn, 2),
        alphaPct: round(alpha, 2),
        outcome: Math.abs(directionalReturn) <= neutralBand ? 'NEUTRAL' : directionalReturn > 0 ? 'WIN' : 'LOSS',
        validatedAt: scanResult.timestamp
      };
    }
  }
}

function getSpyWeeklyState(value) {
  if (!Number.isFinite(value)) return 'UNKNOWN';
  if (value > 0) return 'UP';
  if (value < 0) return 'DOWN';
  return 'FLAT';
}

module.exports = { updateScanHistory };
