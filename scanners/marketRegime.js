const { httpsJson } = require('../utils/http');
const { withCache } = require('../utils/cache');

async function detectMarketRegime(spy, qqq) {
  const parts = [scoreIndex(spy), scoreIndex(qqq)].filter(Boolean);
  const avg = parts.length ? parts.reduce((sum, x) => sum + x.score, 0) / parts.length : 0;
  const vixData = await loadVixData();
  const vix = vixData.vix;
  const sma20Vix = vixData.sma20Vix;
  let regime = 'NEUTRAL';
  if (avg >= 2) regime = 'BULLISH';
  if (avg <= -2) regime = 'BEARISH';
  if (Number.isFinite(vix) && Number.isFinite(sma20Vix)) {
    if (vix < 16 && vix < sma20Vix && avg >= 0) {
      regime = 'BULLISH';
    }
    if (vix > 22) {
      regime = 'BEARISH';
    }
  }
  const blockLong = Number.isFinite(vix) && vix > 28;
  if (blockLong) regime = 'BEARISH';
  const shortAllowed = Number.isFinite(vix) && Number.isFinite(sma20Vix)
    ? vix > 20 && vix > sma20Vix
    : regime !== 'BULLISH';
  return {
    regime,
    bias: regime,
    score: avg,
    vix,
    sma20Vix,
    blockLong,
    shortAllowed,
    spy: parts.find(p => p.symbol === 'SPY') || null,
    qqq: parts.find(p => p.symbol === 'QQQ') || null,
    note: regime === 'BULLISH'
      ? 'SPY/QQQ favorecen setups LONG.'
      : regime === 'BEARISH'
        ? 'SPY/QQQ favorecen setups SHORT.'
        : 'Mercado mixto: priorizar calidad y esperar confirmacion.'
  };
}

async function loadVixData() {
  try {
    const { value } = await withCache('chart:^VIX:1mo:1d', 900, () =>
      httpsJson('query1.finance.yahoo.com', '/v8/finance/chart/%5EVIX?range=1mo&interval=1d')
    );
    const result = value?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const closes = (quote?.close || []).filter(Number.isFinite);
    if (!closes.length) return { vix: null, sma20Vix: null };
    const current = Number(result?.meta?.regularMarketPrice);
    const vix = Number.isFinite(current) ? current : closes[closes.length - 1];
    const last20 = closes.slice(-20);
    const sma20Vix = last20.length ? last20.reduce((sum, value) => sum + value, 0) / last20.length : null;
    return { vix, sma20Vix };
  } catch {
    return { vix: null, sma20Vix: null };
  }
}

function scoreIndex(metrics) {
  if (!metrics) return null;
  let score = 0;
  if (metrics.close > metrics.sma50) score += 1;
  else score -= 1;
  if (metrics.close > metrics.sma200) score += 1;
  else score -= 1;
  if (metrics.sma50 > metrics.sma200) score += 1;
  else score -= 1;
  if ((metrics.returns5d || 0) > 0) score += 1;
  else score -= 1;
  return {
    symbol: metrics.symbol,
    score,
    price: metrics.close,
    returns5d: metrics.returns5d,
    returns20d: metrics.returns20d,
    trend: score >= 2 ? 'UP' : score <= -2 ? 'DOWN' : 'MIXED'
  };
}

module.exports = { detectMarketRegime };
