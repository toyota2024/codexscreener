const { httpsPostJson } = require('../utils/http');
const { readJson, writeJson } = require('../utils/helpers');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');

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

function getTelegramConfig() {
  const env = loadEnv();
  return {
    token: process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID
  };
}

function getScanTriggerToken() {
  const env = loadEnv();
  return process.env.SCAN_TRIGGER_TOKEN || env.SCAN_TRIGGER_TOKEN;
}

async function sendTelegramText(text) {
  const tg = getTelegramConfig();
  if (!tg.token || !tg.chatId) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env');
  }
  return httpsPostJson('api.telegram.org', `/bot${tg.token}/sendMessage`, {
    chat_id: tg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

async function sendCandidates(candidates, config, force = false) {
  const tg = getTelegramConfig();
  if (!tg.token || !tg.chatId) {
    throw new Error('Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en .env');
  }
  const memory = readJson(MEMORY_PATH, { watchlist: [], lastAlerts: {}, lastScan: null });
  const selected = filterSendable(candidates, memory, config, force)
    .slice(0, config.alerts.maxTelegramCandidates);
  if (!selected.length) {
    return { sent: 0, skipped: candidates.length, message: 'Sin alertas nuevas por cooldown/score.' };
  }
  const text = formatTelegramMessage(selected);
  const result = await sendTelegramText(text);
  const now = Date.now();
  for (const c of selected) {
    memory.lastAlerts[`${c.ticker}:${c.bias}`] = {
      score: c.score,
      bias: c.bias,
      setup: c.setup,
      timestamp: now
    };
  }
  writeJson(MEMORY_PATH, memory);
  return { sent: selected.length, skipped: candidates.length - selected.length, telegram: result };
}

function formatGroupedScanMessage(scanResult, label) {
  const groups = [
    { icon: '\u{1F4C8}', title: 'LONG', items: scanResult.longCandidates || [] },
    { icon: '\u{1F4C9}', title: 'SHORT', items: scanResult.shortCandidates || [] },
    { icon: '\u{1F440}', title: 'MONITOR', items: scanResult.monitoringCandidates || [] }
  ];
  const lines = [
    `\u{1F3AF} <b>SCREENER \u2014 ${escapeHtml(label)}</b>`,
    `R\u00e9gimen: <b>${escapeHtml(scanResult.market?.bias || 'NEUTRAL')}</b>`
  ];
  for (const group of groups) {
    lines.push('', `${group.icon} <b>${group.title}:</b>`);
    if (!group.items.length) {
      lines.push('Sin candidatos');
      continue;
    }
    for (const candidate of group.items) lines.push('', formatCandidateDetails(candidate));
  }
  lines.push('', 'No constituye recomendaci\u00f3n financiera.');
  return lines.join('\n');
}

function formatGroupedCandidate(candidate) {
  return formatCandidateDetails(candidate);
}

async function sendGroupedScan(scanResult, label) {
  const text = formatGroupedScanMessage(scanResult, label);
  const telegram = await sendTelegramText(text);
  const sent = (scanResult.longCandidates?.length || 0)
    + (scanResult.shortCandidates?.length || 0)
    + (scanResult.monitoringCandidates?.length || 0);
  return { sent, text, telegram };
}

function filterSendable(candidates, memory, config, force) {
  if (force) return candidates;
  const cooldownMs = config.alerts.cooldownMinutes * 60 * 1000;
  return candidates.filter(c => {
    const last = memory.lastAlerts?.[`${c.ticker}:${c.bias}`];
    if (!last) return true;
    const cooledDown = Date.now() - last.timestamp > cooldownMs;
    const scoreMoved = Math.abs(c.score - last.score) >= config.alerts.minScoreChangeToResend;
    const setupChanged = c.setup !== last.setup;
    return cooledDown || scoreMoved || setupChanged;
  });
}

function formatTelegramMessage(candidates) {
  const header = `🚨 <b>Infusion Capital Screener</b>\n${new Date().toLocaleString()}\n`;
  const body = candidates.map(formatCandidateDetails).join('\n\n');
  return `${header}${body}\n\nNo constituye recomendacion financiera.`;
}

function formatCandidateDetails(candidate) {
  const isShort = candidate.bias === 'SHORT';
  const icon = isShort ? '\u{1F4C9}' : '\u{1F4C8}';
  const entrySide = isShort ? 'Bajo' : 'Sobre';
  const compression = candidate.metrics?.compression === 'Compression' ? 'S\u00ed' : 'No';
  return [
    `${icon} <b>${escapeHtml(candidate.ticker)}</b> \u2014 <b>${escapeHtml(candidate.bias)}</b>`,
    candidate.name ? `\u{1F3E2} ${escapeHtml(candidate.name)}` : null,
    `\u{1F4CA} Score: <b>${escapeHtml(candidate.score)}</b> | R:R: <b>${formatNumber(candidate.riskReward, 2)}</b>`,
    `\u{1F4CB} Setup: ${escapeHtml(candidate.setup || 'n/a')}`,
    `\u{1F4B0} Entry: ${entrySide} ${formatMoney(candidate.entryPrice)}`,
    `\u{1F6D1} Stop: ${formatMoney(candidate.stopPrice)}`,
    `\u{1F3AF} Target: ${formatMoney(candidate.targetPrice)}`,
    `\u{1F4C9} RSI: ${formatNumber(candidate.metrics?.rsi14, 1)} | Fuerza Relativa: ${escapeHtml(candidate.relativeStrength || 'n/a')}`,
    `\u{1F56F}\uFE0F Compresi\u00f3n: ${compression}`,
    candidate.metrics?.reboteOpcionC && candidate.metrics.reboteOpcionC !== '\u2014'
      ? `\u{1F3AF} Opci\u00f3n C: ${escapeHtml(candidate.metrics.reboteOpcionC)} \u2014 ${escapeHtml(candidate.metrics.reboteTouches || 0)} toques \u00B7 RVOL ${formatNumber(candidate.metrics.rvol, 2)}x`
      : null
  ].filter(Boolean).join('\n');
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `$${number.toFixed(2)}`;
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return number.toFixed(digits);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = {
  sendCandidates,
  sendGroupedScan,
  sendTelegramText,
  formatGroupedScanMessage,
  formatTelegramMessage,
  getTelegramConfig,
  getScanTriggerToken
};
