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
  const result = await httpsPostJson('api.telegram.org', `/bot${tg.token}/sendMessage`, {
    chat_id: tg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
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
  const body = candidates.map(c => [
    `\n<b>${c.bias} Candidate</b>`,
    `Ticker: <b>${escapeHtml(c.ticker)}</b>`,
    c.name ? `Name: ${escapeHtml(c.name)}` : null,
    c.sector && c.sectorEtf && c.sectorTrend ? `Sector: ${escapeHtml(c.sector)} | ${escapeHtml(c.sectorEtf)}: ${escapeHtml(c.sectorTrend)}` : null,
    `Score: <b>${c.score}</b>`,
    `Setup: ${escapeHtml(c.setup)}`,
    `RVOL: ${escapeHtml(String(c.metrics?.rvol ?? 'n/a'))}`,
    `R:R: ${escapeHtml(String(c.riskReward ?? 'n/a'))}`,
    `Reason: ${escapeHtml(c.whyItMatters || '')}`,
    `Risk: ${escapeHtml(c.risk || '')}`
  ].filter(Boolean).join('\n')).join('\n');
  return `${header}${body}\n\nNo constituye recomendacion financiera.`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { sendCandidates, getTelegramConfig };
