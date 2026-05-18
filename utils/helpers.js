const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim().toUpperCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function uniq(items) {
  return [...new Set(items.filter(Boolean).map(item => String(item).trim().toUpperCase()))];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctChange(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

module.exports = { readJson, writeJson, readLines, uniq, round, clamp, pctChange };
