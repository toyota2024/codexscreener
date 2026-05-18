function detectMarketRegime(spy, qqq) {
  const parts = [scoreIndex(spy), scoreIndex(qqq)].filter(Boolean);
  const avg = parts.length ? parts.reduce((sum, x) => sum + x.score, 0) / parts.length : 0;
  let bias = 'NEUTRAL';
  if (avg >= 2) bias = 'BULLISH';
  if (avg <= -2) bias = 'BEARISH';
  return {
    bias,
    score: avg,
    spy: parts.find(p => p.symbol === 'SPY') || null,
    qqq: parts.find(p => p.symbol === 'QQQ') || null,
    note: bias === 'BULLISH'
      ? 'SPY/QQQ favorecen setups LONG.'
      : bias === 'BEARISH'
        ? 'SPY/QQQ favorecen setups SHORT.'
        : 'Mercado mixto: priorizar calidad y esperar confirmacion.'
  };
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
