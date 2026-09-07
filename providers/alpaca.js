const path = require('path');
const fs = require('fs');
const { httpsJson } = require('../utils/http');
const { withCache } = require('../utils/cache');

const ROOT = path.join(__dirname, '..');
const DATA_HOST = 'data.alpaca.markets';
const API_HOST = 'api.alpaca.markets';
const MIN_REQUEST_INTERVAL_MS = 200;
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  return Object.fromEntries(fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }));
}

function getCredentials() {
  const env = loadEnv();
  const keyId = process.env.APCA_API_KEY_ID || env.APCA_API_KEY_ID;
  const secretKey = process.env.APCA_API_SECRET_KEY || env.APCA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    throw new Error('Faltan APCA_API_KEY_ID o APCA_API_SECRET_KEY en .env');
  }
  return {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secretKey
  };
}

function formatAlpacaError(error, operation) {
  const status = String(error?.message || '').match(/HTTP\s+(401|403|429)\b/)?.[1];
  if (status === '401') return new Error(`Alpaca ${operation}: credenciales inválidas o ausentes (HTTP 401)`);
  if (status === '403') return new Error(`Alpaca ${operation}: acceso denegado para este recurso/feed (HTTP 403)`);
  if (status === '429') return new Error(`Alpaca ${operation}: límite de solicitudes excedido (HTTP 429)`);
  return new Error(`Alpaca ${operation}: ${error?.message || 'error de solicitud'}`);
}

async function request(hostname, requestPath, operation) {
  let credentials;
  try {
    credentials = getCredentials();
  } catch (error) {
    throw formatAlpacaError(error, operation);
  }
  const queuedRequest = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
    return httpsJson(hostname, requestPath, credentials);
  });
  requestQueue = queuedRequest.catch(() => {});
  try {
    return await queuedRequest;
  } catch (error) {
    throw formatAlpacaError(error, operation);
  }
}

async function getHistoricalBars(symbol, limit) {
  const safeSymbol = encodeURIComponent(String(symbol).trim().toUpperCase());
  const safeLimit = Math.max(1, Number(limit) || 1);
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - safeLimit * 3);
  const startDateStr = startDate.toISOString().slice(0, 10);
  const endDateStr = endDate.toISOString().slice(0, 10);
  const query = new URLSearchParams({
    timeframe: '1Day',
    limit: String(safeLimit),
    start: startDateStr,
    end: endDateStr,
    adjustment: 'all',
    feed: 'iex',
    sort: 'desc'
  });
  const data = (await withCache(
    `alpaca:historical:v2:${safeSymbol}:${safeLimit}:${startDateStr}:${endDateStr}`,
    60 * 60,
    () => request(
      DATA_HOST,
      `/v2/stocks/${safeSymbol}/bars?${query.toString()}`,
      `histórico de ${symbol}`
    )
  )).value;
  const candles = (Array.isArray(data?.bars) ? data.bars : [])
    .map(bar => ({
      date: new Date(bar.t).toISOString().slice(0, 10),
      open: Number(bar.o),
      high: Number(bar.h),
      low: Number(bar.l),
      close: Number(bar.c),
      volume: Number(bar.v)
    }))
    .filter(candle =>
      Number.isFinite(Date.parse(`${candle.date}T00:00:00Z`)) &&
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close) &&
      Number.isFinite(candle.volume)
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  return { candles, name: '' };
}

async function getLatestPrice(symbol) {
  try {
    const safeSymbol = encodeURIComponent(String(symbol).trim().toUpperCase());
    const data = (await withCache(
      `alpaca:latest:${safeSymbol}`,
      30,
      () => request(
        DATA_HOST,
        `/v2/stocks/${safeSymbol}/bars/latest?feed=iex`,
        `precio actual de ${symbol}`
      )
    )).value;
    const price = Number(data?.bar?.c);
    return Number.isFinite(price) ? price : null;
  } catch (error) {
    console.warn(error.message);
    return null;
  }
}

async function getAssetName(symbol) {
  try {
    const safeSymbol = encodeURIComponent(String(symbol).trim().toUpperCase());
    const data = (await withCache(
      `alpaca:asset:${safeSymbol}`,
      24 * 60 * 60,
      () => request(
        API_HOST,
        `/v2/assets/${safeSymbol}`,
        `nombre de activo ${symbol}`
      )
    )).value;
    return typeof data?.name === 'string' ? data.name : '';
  } catch (error) {
    console.warn(error.message);
    return '';
  }
}

async function getCloseAtDate(symbol, targetDateStr) {
  try {
    const safeSymbol = encodeURIComponent(String(symbol).trim().toUpperCase());
    const startDate = new Date(targetDateStr);
    startDate.setUTCDate(startDate.getUTCDate() - 7);
    const query = new URLSearchParams({
      timeframe: '1Day',
      start: startDate.toISOString().slice(0, 10),
      end: targetDateStr,
      adjustment: 'all',
      feed: 'iex',
      limit: '10'
    });
    const data = (await withCache(
      `alpaca:closeAt:${safeSymbol}:${targetDateStr}`,
      24 * 60 * 60,
      () => request(
        DATA_HOST,
        `/v2/stocks/${safeSymbol}/bars?${query.toString()}`,
        `precio histórico ${symbol} a ${targetDateStr}`
      )
    )).value;
    const bars = (Array.isArray(data?.bars) ? data.bars : [])
      .map(b => ({ date: b.t.slice(0, 10), close: Number(b.c) }))
      .filter(b => Number.isFinite(b.close) && b.date <= targetDateStr)
      .sort((a, b) => b.date.localeCompare(a.date));
    return bars[0]?.close ?? null;
  } catch {
    return null;
  }
}

async function getBarsInRange(symbol, startDateStr, endDateStr) {
  try {
    const safeSymbol = encodeURIComponent(String(symbol).trim().toUpperCase());
    const query = new URLSearchParams({
      timeframe: '1Day',
      start: startDateStr,
      end: endDateStr,
      adjustment: 'all',
      feed: 'iex',
      limit: '60'
    });
    const data = (await withCache(
      `alpaca:range:${safeSymbol}:${startDateStr}:${endDateStr}`,
      24 * 60 * 60,
      () => request(
        DATA_HOST,
        `/v2/stocks/${safeSymbol}/bars?${query.toString()}`,
        `barras ${symbol} ${startDateStr} a ${endDateStr}`
      )
    )).value;
    return (Array.isArray(data?.bars) ? data.bars : [])
      .map(b => ({
        date: b.t.slice(0, 10),
        open: Number(b.o),
        high: Number(b.h),
        low: Number(b.l),
        close: Number(b.c),
        volume: Number(b.v)
      }))
      .filter(c =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
      );
  } catch {
    return [];
  }
}

module.exports = {
  getHistoricalBars,
  getLatestPrice,
  getAssetName,
  getCloseAtDate,
  getBarsInRange
};
