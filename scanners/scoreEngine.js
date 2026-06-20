const { clamp, round } = require('../utils/helpers');

function scoreCandidate(symbol, metrics, market, config) {
  const long = buildSide('LONG', symbol, metrics, market, config);
  const short = buildSide('SHORT', symbol, metrics, market, config);
  return { long, short };
}

function buildSide(bias, symbol, m, market, config) {
  const trend = scoreTrend(bias, m);
  const volume = scoreVolume(m);
  const momentum = scoreMomentum(bias, m, market);
  const structure = scoreStructure(bias, m);
  const riskReward = scoreRiskReward(bias, m, config);
  const emaPenalty = scoreEmaDistancePenalty(m);
  const total = trend.points + volume.points + momentum.points + structure.points + riskReward.points - emaPenalty.points;
  const compression = detectCompression(m);
  const setup = pickSetup(bias, structure, compression);
  const reasons = [
    ...trend.reasons,
    ...volume.reasons,
    ...momentum.reasons,
    ...structure.reasons,
    ...riskReward.reasons
  ].slice(0, 5);
  const risks = detectRisks(bias, m, market, riskReward.rr);
  return {
    ticker: symbol,
    name: m.name || '',
    sector: m.sector || '',
    sectorEtf: m.sectorEtf || '',
    sectorTrend: m.sectorTrend || '',
    bias,
    score: Math.round(clamp(total, 0, 100)),
    coreSatellite: classifyCoreSatellite(m),
    setup,
    whyItMatters: reasons.join(' + ') || 'Setup en observacion',
    entryIdea: bias === 'LONG'
      ? `Sobre ${round(Math.max(m.close, m.high20Prev || m.close))}`
      : `Bajo ${round(Math.min(m.close, m.low20Prev || m.close))}`,
    stopIdea: bias === 'LONG'
      ? `Debajo de ${round(riskReward.stop)}`
      : `Encima de ${round(riskReward.stop)}`,
    targetIdea: `${round(riskReward.target)}`,
    riskReward: round(riskReward.rr, 2),
    relativeStrength: relativeStrengthLabel(bias, m),
    volume: `${round(m.rvol, 2)}x promedio 20D`,
    risk: risks.join(' | ') || 'Riesgo normal para swing setup',
    metrics: {
      price: round(m.close),
      rsi14: round(m.rsi14, 1),
      sma20: round(m.sma20),
      sma50: round(m.sma50),
      sma200: round(m.sma200),
      ema20: round(m.ema20),
      macdHistogram: round(m.macdHistogram, 3),
      atr14: round(m.atr14),
      atrPct: round((m.atr14 / m.close) * 100, 2),
      avgVolume20: Math.round(m.avgVolume20 || 0),
      rvol: round(m.rvol, 2),
      coreUniverse: Boolean(m.coreUniverse),
      distEma20Pct: round(getDistEma20Pct(m), 2),
      returns5d: round(m.returns5d, 2),
      returns20d: round(m.returns20d, 2),
      rsVsSpy20d: round(m.rsVsSpy20d, 2),
      rsVsQqq20d: round(m.rsVsQqq20d, 2),
      compression: compression.label
    },
    scoreBreakdown: {
      trend: trend.points,
      volume: volume.points,
      momentum: momentum.points,
      structure: structure.points,
      riskReward: riskReward.points,
      emaDistancePenalty: emaPenalty.points
    }
  };
}

function scoreEmaDistancePenalty(m) {
  const dist = Math.abs(getDistEma20Pct(m));
  if (dist > 20) return { points: 20 };
  if (dist > 15) return { points: 15 };
  if (dist > 10) return { points: 10 };
  if (dist > 5) return { points: 5 };
  return { points: 0 };
}

function getDistEma20Pct(m) {
  if (!Number.isFinite(m.close) || !Number.isFinite(m.ema20) || m.ema20 === 0) return 0;
  return ((m.close - m.ema20) / m.ema20) * 100;
}

function classifyCoreSatellite(m) {
  const atrPct = Number.isFinite(m.atr14) && m.close ? m.atr14 / m.close : 1;
  if (m.coreUniverse && atrPct <= 0.04) {
    return { type: 'CORE', label: 'CORE', reason: 'S&P/Nasdaq 100 proxy + ATR bajo' };
  }
  return { type: 'SATELLITE', label: 'SATELLITE', reason: m.coreUniverse ? 'ATR alto' : 'fuera del universo core' };
}

function scoreTrend(bias, m) {
  let points = 0;
  const reasons = [];
  if (bias === 'LONG') {
    if (m.close > m.sma50) { points += 10; reasons.push('precio > SMA50'); }
    if (m.close > m.sma200) { points += 10; reasons.push('precio > SMA200'); }
    if (m.sma50 > m.sma200) { points += 5; reasons.push('SMA50 > SMA200'); }
  } else {
    if (m.close < m.sma50) { points += 10; reasons.push('precio < SMA50'); }
    if (m.close < m.sma200) { points += 10; reasons.push('precio < SMA200'); }
    if (m.sma50 < m.sma200) { points += 5; reasons.push('SMA50 < SMA200'); }
  }
  return { points, reasons };
}

function scoreVolume(m) {
  let points = 0;
  const reasons = [];
  if (m.rvol >= 2) { points += 15; reasons.push(`RVOL ${round(m.rvol, 1)}x`); }
  else if (m.rvol >= 1.5) { points += 12; reasons.push(`RVOL ${round(m.rvol, 1)}x`); }
  else if (m.rvol >= 1.1) { points += 7; reasons.push('volumen sobre promedio'); }
  if (m.volume > m.avgVolume20) points += 5;
  const recentVol = m.candles.slice(-5).reduce((sum, c) => sum + c.volume, 0) / 5;
  if (recentVol > m.avgVolume20 * 1.15) { points += 5; reasons.push('volumen reciente creciente'); }
  return { points: clamp(points, 0, 25), reasons };
}

function scoreMomentum(bias, m, market) {
  let points = 0;
  const reasons = [];
  if (bias === 'LONG') {
    if (m.rsi14 >= 50 && m.rsi14 <= 75) { points += 7; reasons.push(`RSI saludable ${round(m.rsi14, 0)}`); }
    if (m.macdHistogram > 0 && m.macd > m.macdSignal) { points += 6; reasons.push('MACD positivo'); }
    if ((m.returns5d || 0) > 0 && (m.returns20d || 0) > 0) { points += 4; reasons.push('price strength'); }
    if ((m.rsVsSpy20d || 0) > 0 || (m.rsVsQqq20d || 0) > 0) { points += 3; reasons.push('lidera vs SPY/QQQ'); }
    if (market.bias === 'BEARISH') points -= 3;
  } else {
    if (m.rsi14 >= 25 && m.rsi14 <= 50) { points += 7; reasons.push(`RSI debil ${round(m.rsi14, 0)}`); }
    if (m.macdHistogram < 0 && m.macd < m.macdSignal) { points += 6; reasons.push('MACD negativo'); }
    if ((m.returns5d || 0) < 0 && (m.returns20d || 0) < 0) { points += 4; reasons.push('debilidad de precio'); }
    if ((m.rsVsSpy20d || 0) < 0 || (m.rsVsQqq20d || 0) < 0) { points += 3; reasons.push('rezagada vs SPY/QQQ'); }
    if (market.bias === 'BULLISH') points -= 3;
  }
  return { points: clamp(points, 0, 20), reasons };
}

function scoreStructure(bias, m) {
  const compression = detectCompression(m);
  let points = 0;
  const reasons = [];
  if (bias === 'LONG') {
    if (m.close > m.high20Prev) { points += 10; reasons.push('breakout 20D'); }
    else if (m.close > m.ema20 && m.close > m.sma20) { points += 5; reasons.push('estructura sobre EMA20'); }
    if (compression.active) { points += 5; reasons.push('compresion previa'); }
    if (m.close > m.low10Prev && m.range10Pct < 0.08) { points += 5; reasons.push('consolidacion saludable'); }
  } else {
    if (m.close < m.low20Prev) { points += 10; reasons.push('breakdown 20D'); }
    else if (m.close < m.ema20 && m.close < m.sma20) { points += 5; reasons.push('estructura bajo EMA20'); }
    if (compression.active) { points += 5; reasons.push('compresion previa'); }
    if (m.close < m.high10Prev && m.range10Pct < 0.08) { points += 5; reasons.push('rango estrecho bajista'); }
  }
  return { points: clamp(points, 0, 20), reasons, compression };
}

function scoreRiskReward(bias, m, config) {
  const entry = m.close;
  let stop;
  let target;
  if (bias === 'LONG') {
    const stopTecnico = (m.low10Prev || entry) - m.atr14 * 0.2;
    const stopATR = entry - m.atr14 * 1.5;
    stop = Math.max(stopTecnico, stopATR);
    target = Math.max(entry + m.atr14 * 3.0, m.high20Prev || entry);
  } else {
    const stopTecnico = (m.high10Prev || entry) + m.atr14 * 0.2;
    const stopATR = entry + m.atr14 * 1.5;
    stop = Math.min(stopTecnico, stopATR);
    target = Math.min(entry - m.atr14 * 3.0, m.low20Prev || entry);
  }
  const reward = bias === 'LONG' ? target - entry : entry - target;
  const risk = bias === 'LONG' ? entry - stop : stop - entry;
  const rr = risk > 0 ? reward / risk : 0;
  const points = rr >= config.filters.minRR ? 10 : rr >= 1.5 ? 5 : 0;
  return { points, rr, stop, target, reasons: rr >= config.filters.minRR ? [`R:R ${round(rr, 1)}`] : [] };
}

function detectCompression(m) {
  let signals = 0;
  if (m.bollingerBandwidth && m.bbBandwidthAvg60 && m.bollingerBandwidth < m.bbBandwidthAvg60 * 0.75) signals++;
  if (m.atrAvg5 && m.atrAvg20 && m.atrAvg5 < m.atrAvg20 * 0.9) signals++;
  if (m.range10Pct != null && m.range10Pct < 0.08) signals++;
  return {
    active: signals >= 2,
    label: signals >= 2 ? 'Compression' : signals === 1 ? 'Mild' : 'None'
  };
}

function pickSetup(bias, structure, compression) {
  if (structure.reasons.some(r => r.includes('breakout'))) return 'Breakout after consolidation';
  if (structure.reasons.some(r => r.includes('breakdown'))) return 'Breakdown with weakness';
  if (compression.active) return bias === 'LONG' ? 'Compression preparing expansion' : 'Compression before possible breakdown';
  return bias === 'LONG' ? 'Trend continuation pullback' : 'Bearish continuation setup';
}

function relativeStrengthLabel(bias, m) {
  const spy = m.rsVsSpy20d || 0;
  const qqq = m.rsVsQqq20d || 0;
  const avg = (spy + qqq) / 2;
  if (bias === 'LONG') return avg > 2 ? 'Strong vs SPY/QQQ' : avg > 0 ? 'Slightly strong vs SPY/QQQ' : 'Weak vs SPY/QQQ';
  return avg < -2 ? 'Weak vs SPY/QQQ' : avg < 0 ? 'Slightly weak vs SPY/QQQ' : 'Not weak vs SPY/QQQ';
}

function detectRisks(bias, m, market, rr) {
  const risks = [];
  if (m.rsi14 > 75 && bias === 'LONG') risks.push('RSI extendido');
  if (m.rsi14 < 25 && bias === 'SHORT') risks.push('posible rebote por sobreventa');
  if (m.rvol > 4) risks.push('volumen anormal: revisar noticia');
  if (m.atr14 / m.close > 0.08) risks.push('volatilidad alta');
  if (rr < 2) risks.push('R:R debajo del minimo');
  if (market.bias === 'BULLISH' && bias === 'SHORT') risks.push('short contra mercado alcista');
  if (market.bias === 'BEARISH' && bias === 'LONG') risks.push('long contra mercado bajista');
  return risks;
}

module.exports = { scoreCandidate };
