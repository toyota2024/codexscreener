const path = require('path');
const { readJson, writeJson } = require('../utils/helpers');
const { log } = require('../utils/logger');
const { formatGroupedScanMessage, sendTelegramText } = require('../telegram/telegramBot');

const ROOT = path.join(__dirname, '..');
const MEMORY_PATH = path.join(ROOT, 'data', 'memory.json');
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function getZonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
    minutes: Number(map.hour) * 60 + Number(map.minute),
    seconds: Number(map.second)
  };
}

function findEligibleSlot(date, autoConfig) {
  const parts = getZonedParts(date, autoConfig.timeZone);
  if (!WEEKDAYS.has(parts.weekday)) return null;
  const windowMinutes = autoConfig.retryWindowMinutes || 30;
  for (const slot of autoConfig.slots || []) {
    const slotMinutes = slot.hour * 60 + slot.minute;
    const elapsedMinutes = parts.minutes - slotMinutes;
    const elapsedSeconds = elapsedMinutes * 60 + parts.seconds;
    if (elapsedSeconds < 0 || elapsedSeconds > windowMinutes * 60) continue;
    const elapsedMs = elapsedSeconds * 1000 + date.getMilliseconds();
    return {
      ...slot,
      key: `${parts.dateKey}:${slot.id}`,
      scheduledAt: new Date(date.getTime() - elapsedMs).toISOString()
    };
  }
  return null;
}

function cleanOldRuns(runs, nowMs, keepDays = 30) {
  const cutoff = nowMs - keepDays * 86400000;
  return Object.fromEntries(Object.entries(runs || {}).filter(([, run]) => {
    const timestamp = Date.parse(run.completedAt || run.lastAttemptAt || run.createdAt || 0);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }));
}

function readMemory() {
  return readJson(MEMORY_PATH, { watchlist: [], lastAlerts: {}, lastScan: null, autoScanRuns: {} });
}

function createAutoScanScheduler(options) {
  const autoConfig = options.config.autoScan || {};
  const executeScan = options.executeScan;
  const sendText = options.sendText || sendTelegramText;
  const formatMessage = options.formatMessage || formatGroupedScanMessage;
  const now = options.now || (() => new Date());
  const loadMemory = options.readMemory || readMemory;
  const saveMemory = options.writeMemory || (memory => writeJson(MEMORY_PATH, memory));
  const activeSlots = new Set();

  function updateRun(key, values, nowMs) {
    const memory = loadMemory();
    memory.autoScanRuns = cleanOldRuns(memory.autoScanRuns, nowMs);
    memory.autoScanRuns[key] = { ...(memory.autoScanRuns[key] || {}), ...values };
    saveMemory(memory);
    return memory.autoScanRuns[key];
  }

  async function tick(date = now()) {
    if (!autoConfig.enabled) return { status: 'disabled' };
    const slot = findEligibleSlot(date, autoConfig);
    if (!slot) return { status: 'outside-window' };
    if (activeSlots.has(slot.key)) return { status: 'running', key: slot.key };
    const memory = loadMemory();
    const previous = memory.autoScanRuns?.[slot.key];
    if (previous?.status === 'sent') return { status: 'sent', key: slot.key };
    const retryMs = (autoConfig.retryIntervalMinutes || 5) * 60000;
    if (previous?.lastAttemptAt && date.getTime() - Date.parse(previous.lastAttemptAt) < retryMs) {
      return { status: 'waiting-retry', key: slot.key };
    }

    activeSlots.add(slot.key);
    const attempt = (previous?.attempts || 0) + 1;
    updateRun(slot.key, {
      status: 'running',
      attempts: attempt,
      createdAt: previous?.createdAt || date.toISOString(),
      lastAttemptAt: date.toISOString(),
      label: slot.label
    }, date.getTime());
    try {
      let message = previous?.pendingMessage;
      let scanTimestamp = previous?.scanTimestamp;
      if (!message) {
        const result = await executeScan({ reuseAfter: slot.scheduledAt });
        message = formatMessage(result, slot.label);
        scanTimestamp = result.timestamp;
        updateRun(slot.key, { status: 'pending-send', pendingMessage: message, scanTimestamp }, date.getTime());
      }
      await sendText(message);
      updateRun(slot.key, {
        status: 'sent',
        completedAt: date.toISOString(),
        pendingMessage: null,
        lastError: null,
        scanTimestamp
      }, date.getTime());
      log('info', 'Automatic scan sent', { slot: slot.key, attempt, scanTimestamp });
      return { status: 'sent', key: slot.key, attempt };
    } catch (error) {
      const latest = loadMemory().autoScanRuns?.[slot.key] || {};
      updateRun(slot.key, {
        status: 'retry',
        pendingMessage: latest.pendingMessage || previous?.pendingMessage || null,
        lastError: error.message
      }, date.getTime());
      log('error', 'Automatic scan failed', { slot: slot.key, attempt, error: error.message });
      return { status: 'retry', key: slot.key, attempt, error: error.message };
    } finally {
      activeSlots.delete(slot.key);
    }
  }

  function start() {
    if (!autoConfig.enabled) return null;
    tick().catch(error => log('error', 'Automatic scheduler tick failed', { error: error.message }));
    const timer = setInterval(() => {
      tick().catch(error => log('error', 'Automatic scheduler tick failed', { error: error.message }));
    }, (autoConfig.pollIntervalSeconds || 30) * 1000);
    log('info', 'Automatic scan scheduler enabled', {
      timeZone: autoConfig.timeZone,
      slots: (autoConfig.slots || []).map(slot => slot.label)
    });
    return timer;
  }

  return { start, tick };
}

module.exports = { createAutoScanScheduler, findEligibleSlot, getZonedParts, cleanOldRuns };
