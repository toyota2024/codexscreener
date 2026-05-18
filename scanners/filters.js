function hardVeto(symbol, metrics, config) {
  const reasons = [];
  const filters = config.filters;
  if (!metrics || metrics.candles.length < filters.minHistoryBars) reasons.push('historial insuficiente');
  if (!Number.isFinite(metrics.close) || metrics.close < filters.minPrice) reasons.push('precio bajo');
  if (!Number.isFinite(metrics.avgVolume20) || metrics.avgVolume20 < filters.minAvgVolume20) reasons.push('volumen bajo');
  if (!Number.isFinite(metrics.atr14) || metrics.atr14 <= 0) reasons.push('ATR no disponible');
  if (Number.isFinite(metrics.atr14) && metrics.close && metrics.atr14 / metrics.close > filters.maxAtrPct) {
    reasons.push('volatilidad diaria extrema');
  }
  if (!Number.isFinite(metrics.sma50) || !Number.isFinite(metrics.sma200) || !Number.isFinite(metrics.rsi14)) {
    reasons.push('indicadores incompletos');
  }
  if (/[\^=]/.test(symbol)) reasons.push('ticker no accionable');
  return { passed: reasons.length === 0, reasons };
}

module.exports = { hardVeto };
