function hardVeto(symbol, metrics, config) {
  const reasons = [];
  const codes = [];
  const filters = config.filters;
  if (!metrics || !Array.isArray(metrics.candles)) {
    reasons.push('datos ausentes');
    codes.push('MISSING_DATA');
  } else if (metrics.candles.length < filters.minHistoryBars) {
    reasons.push('historial insuficiente');
    codes.push('MISSING_DATA');
  }
  if (metrics?.close == null || !Number.isFinite(metrics.close)) {
    reasons.push('precio ausente');
    codes.push('MISSING_DATA');
  } else if (metrics.close < filters.minPrice) {
    reasons.push('precio bajo');
    codes.push('PRICE_TOO_LOW');
  }
  const useDollarVolume = filters.liquidityMode === 'dollar';
  const dollarVolume20 = Number.isFinite(metrics?.avgVolume20) && Number.isFinite(metrics?.close)
    ? metrics.avgVolume20 * metrics.close
    : null;
  if (useDollarVolume && dollarVolume20 == null) {
    reasons.push('dollar volume ausente');
    codes.push('MISSING_DATA');
  } else if (!useDollarVolume && (metrics?.avgVolume20 == null || !Number.isFinite(metrics.avgVolume20))) {
    reasons.push('volumen ausente');
    codes.push('MISSING_DATA');
  } else if (useDollarVolume && dollarVolume20 < (filters.minDollarVolume20 || 20e6)) {
    reasons.push('dollar volume bajo');
    codes.push('LIQUIDITY_TOO_LOW');
  } else if (!useDollarVolume && metrics.avgVolume20 < filters.minAvgVolume20) {
    reasons.push('volumen bajo');
    codes.push('LIQUIDITY_TOO_LOW');
  }
  if (metrics?.atr14 == null || !Number.isFinite(metrics.atr14) || metrics.atr14 <= 0) {
    reasons.push('ATR no disponible');
    codes.push('MISSING_DATA');
  }
  const atrLimit = getAtrLimit(metrics, filters);
  if (Number.isFinite(metrics?.atr14) && metrics?.close && metrics.atr14 / metrics.close > atrLimit) {
    reasons.push('volatilidad diaria extrema');
    codes.push('ATR_TOO_HIGH');
  }
  if (metrics?.sma50 == null || metrics?.sma200 == null || metrics?.rsi14 == null ||
      !Number.isFinite(metrics.sma50) || !Number.isFinite(metrics.sma200) || !Number.isFinite(metrics.rsi14)) {
    reasons.push('indicadores incompletos');
    codes.push('MISSING_DATA');
  }
  if (/[\^=]/.test(symbol)) {
    reasons.push('ticker no accionable');
    codes.push('INVALID_SYMBOL');
  }
  return { passed: reasons.length === 0, reasons, codes: [...new Set(codes)] };
}

function getAtrLimit(metrics, filters) {
  if (filters.atrMode !== 'capProfile') return filters.maxAtrPct;
  if (!Number.isFinite(metrics?.marketCap)) return filters.maxAtrPct;
  if (metrics.marketCap >= 10e9) return 0.08;
  if (metrics.marketCap >= 2e9) return 0.10;
  return 0.15;
}

module.exports = { hardVeto };
