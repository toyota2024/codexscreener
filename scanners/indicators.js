const { round } = require('../utils/helpers');

function sma(values, period) {
  const out = Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) continue;
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    if (i >= period - 1) out[i] = prev;
  }
  return out;
}

function rsi(values, period = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const signal = Array(values.length).fill(null);
  const k = 2 / (signalPeriod + 1);
  let prev = null;
  for (let i = 0; i < line.length; i++) {
    if (line[i] == null) continue;
    prev = prev == null ? line[i] : line[i] * k + prev * (1 - k);
    signal[i] = prev;
  }
  const histogram = line.map((value, i) => value != null && signal[i] != null ? value - signal[i] : null);
  return { line, signal, histogram };
}

function atr(candles, period = 14) {
  const out = Array(candles.length).fill(null);
  let prevAtr = null;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i < period) continue;
    if (i === period) {
      let sum = 0;
      for (let j = 1; j <= period; j++) {
        const cj = candles[j];
        const pj = candles[j - 1];
        sum += Math.max(cj.high - cj.low, Math.abs(cj.high - pj.close), Math.abs(cj.low - pj.close));
      }
      prevAtr = sum / period;
    } else {
      prevAtr = (prevAtr * (period - 1) + tr) / period;
    }
    out[i] = prevAtr;
  }
  return out;
}

function bollinger(values, period = 20, stdev = 2) {
  const mid = sma(values, period);
  const upper = Array(values.length).fill(null);
  const lower = Array(values.length).fill(null);
  const bandwidth = Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdev * sd;
    lower[i] = mean - stdev * sd;
    bandwidth[i] = mean ? (upper[i] - lower[i]) / mean : null;
  }
  return { mid, upper, lower, bandwidth };
}

function enrichCandles(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const e20 = ema(closes, 20);
  const r14 = rsi(closes, 14);
  const m = macd(closes);
  const a = atr(candles, 14);
  const b = bollinger(closes, 20, 2);
  const av20 = sma(volumes, 20);
  const i = candles.length - 1;
  return {
    candles,
    close: closes[i],
    volume: volumes[i],
    sma20: s20[i],
    sma50: s50[i],
    sma200: s200[i],
    ema20: e20[i],
    rsi14: r14[i],
    macd: m.line[i],
    macdSignal: m.signal[i],
    macdHistogram: m.histogram[i],
    atr14: a[i],
    bollingerUpper: b.upper[i],
    bollingerLower: b.lower[i],
    bollingerBandwidth: b.bandwidth[i],
    avgVolume20: av20[i],
    rvol: av20[i] ? volumes[i] / av20[i] : null,
    returns5d: closes.length > 6 ? ((closes[i] - closes[i - 5]) / closes[i - 5]) * 100 : null,
    returns20d: closes.length > 21 ? ((closes[i] - closes[i - 20]) / closes[i - 20]) * 100 : null,
    high20Prev: Math.max(...candles.slice(Math.max(0, i - 20), i).map(c => c.high)),
    low20Prev: Math.min(...candles.slice(Math.max(0, i - 20), i).map(c => c.low)),
    high10Prev: Math.max(...candles.slice(Math.max(0, i - 10), i).map(c => c.high)),
    low10Prev: Math.min(...candles.slice(Math.max(0, i - 10), i).map(c => c.low)),
    bbBandwidthAvg60: average(b.bandwidth.slice(Math.max(0, i - 60), i).filter(Number.isFinite)),
    atrAvg20: average(a.slice(Math.max(0, i - 20), i).filter(Number.isFinite)),
    atrAvg5: average(a.slice(Math.max(0, i - 5), i).filter(Number.isFinite)),
    range10Pct: rangePct(candles.slice(Math.max(0, i - 10), i + 1)),
    values: {
      sma20: round(s20[i]),
      sma50: round(s50[i]),
      sma200: round(s200[i]),
      ema20: round(e20[i]),
      rsi14: round(r14[i], 1),
      macd: round(m.line[i], 3),
      macdSignal: round(m.signal[i], 3),
      atr14: round(a[i]),
      bollingerBandwidth: round(b.bandwidth[i] * 100, 2),
      avgVolume20: Math.round(av20[i] || 0),
      rvol: round(av20[i] ? volumes[i] / av20[i] : null, 2)
    }
  };
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rangePct(candles) {
  if (!candles.length) return null;
  const high = Math.max(...candles.map(c => c.high));
  const low = Math.min(...candles.map(c => c.low));
  const close = candles[candles.length - 1].close;
  return close ? (high - low) / close : null;
}

module.exports = { sma, ema, rsi, macd, atr, bollinger, enrichCandles };
