const path = require('path');
const { readJson, writeJson, round } = require('../utils/helpers');

const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'data', 'scan-history.json');

function updateScanHistory(scanResult, config) {
  const history = readJson(HISTORY_PATH, { records: [] });
  const records = Array.isArray(history.records) ? history.records : [];
  const scans = Array.isArray(history.scans) ? history.scans : [];
  const scanTs = Date.parse(scanResult.timestamp);
  const windowMs = (config.history?.dedupeWindowMinutes || 60) * 60 * 1000;
  const validationWindows = config.history?.validationWindowsDays || [5, 15, 30];
  const neutralBand = config.history?.neutralBandPct || 2;
  const candidates = [
    ...(scanResult.longCandidates || []),
    ...(scanResult.shortCandidates || [])
  ];

  const candidateKeys = [];
  for (const candidate of candidates) {
    const key = makeRecordKey(candidate, scanTs, windowMs);
    candidateKeys.push(key);
    const existing = records.find(record => record.key === key);
    const payload = buildRecord(candidate, scanResult, key, validationWindows);
    if (existing) {
      const timestamp = existing.timestamp;
      const validations = existing.validations || payload.validations;
      const seenCount = (existing.seenCount || 1) + 1;
      Object.assign(existing, payload, {
        timestamp,
        validations,
        seenCount,
        lastSeenAt: scanResult.timestamp
      });
    } else {
      records.push(payload);
    }
  }

  const scanKey = String(Math.floor(scanTs / windowMs) * windowMs);
  const existingScan = scans.find(scan => scan.key === scanKey);
  const scanPayload = {
    key: scanKey,
    timestamp: scanResult.timestamp,
    marketBias: scanResult.market?.bias || 'NEUTRAL',
    candidateKeys
  };
  if (existingScan) {
    existingScan.timestamp = scanResult.timestamp;
    existingScan.marketBias = scanPayload.marketBias;
    existingScan.candidateKeys = candidateKeys;
  } else {
    scans.push(scanPayload);
  }

  validateRecords(records, scanResult, validationWindows, neutralBand);
  history.records = records
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 1000);
  history.scans = scans
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 250);
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
    name: candidate.name || '',
    bias: candidate.bias,
    score: candidate.score,
    riskReward: candidate.riskReward ?? null,
    setup: candidate.setup,
    entryPrice: candidate.entryPrice ?? candidate.metrics?.price ?? null,
    stopPrice: candidate.stopPrice ?? null,
    targetPrice: candidate.targetPrice ?? null,
    spyPriceAtScan: spy.price || null,
    spyWeeklyReturnAtScan: spy.returns5d || null,
    spyWeeklyStateAtScan: getSpyWeeklyState(spy.returns5d),
    marketBiasAtScan: scanResult.market?.bias || 'NEUTRAL',
    coreSatellite: candidate.coreSatellite || null,
    distEma20Pct: candidate.metrics?.distEma20Pct ?? null,
    validations
  };
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
  return {
    ticker: record.ticker,
    nombre: record.name || '',
    bias: record.bias,
    score: record.score,
    riskReward: record.riskReward ?? null,
    entrada: record.entryPrice,
    setup: record.setup || '',
    resultado_5d: result(5),
    resultado_15d: result(15),
    resultado_30d: result(30)
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

module.exports = { updateScanHistory, readHistoryEntries };
