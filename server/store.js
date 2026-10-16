'use strict';

/**
 * 持久化：库索引 / 最近查看历史 / 设置。
 * 全部落在 DATA_DIR 下的 JSON 文件（原子写）。
 * 对照 macOS 版「唯一写入口」思路（LibraryStore / SettingsStore）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ─────────────────────────────── 库索引 ───────────────────────────────

function loadLibrary() {
  const arr = readJSON(config.libraryFile, []);
  return Array.isArray(arr) ? arr : [];
}

function addLibraryEntry(entry) {
  const lib = loadLibrary();
  const idx = lib.findIndex((e) => e.fileName === entry.fileName);
  const record = { ...entry, createdAt: Date.now() };
  if (idx >= 0) lib[idx] = record;
  else lib.unshift(record);
  writeJSON(config.libraryFile, lib.slice(0, 2000));
  return record;
}

function removeLibraryEntry(fileName) {
  const lib = loadLibrary().filter((e) => e.fileName !== fileName);
  writeJSON(config.libraryFile, lib);
}

/** 合并索引与磁盘实际文件：磁盘为真源，索引补充元数据 */
function listLibrary() {
  const indexed = new Map(loadLibrary().map((e) => [e.fileName, e]));
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(config.downloadDir, { withFileTypes: true });
  } catch {
    files = [];
  }
  for (const ent of files) {
    if (!ent.isFile()) continue;
    if (ent.name.startsWith('.')) continue;
    const ext = (ent.name.split('.').pop() || '').toLowerCase();
    if (!['txt', 'epub'].includes(ext)) continue;
    const full = path.join(config.downloadDir, ent.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const meta = indexed.get(ent.name) || {};
    out.push({
      fileName: ent.name,
      path: full,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      platform: meta.platform || '',
      bookID: meta.bookID || '',
      title: meta.title || ent.name.replace(/\.[^.]+$/, ''),
      author: meta.author || '',
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ─────────────────────────────── 历史 ───────────────────────────────

function loadHistory() {
  const arr = readJSON(config.historyFile, []);
  return Array.isArray(arr) ? arr : [];
}

function addHistory(entry) {
  const list = loadHistory().filter((e) => !(e.type === entry.type && e.key === entry.key));
  list.unshift({ ...entry, at: Date.now() });
  writeJSON(config.historyFile, list.slice(0, 100));
}

function clearHistory() {
  writeJSON(config.historyFile, []);
}

// ─────────────────────────────── 设置 ───────────────────────────────

function loadSettings() {
  return { downloadDir: config.downloadDir, ...readJSON(config.settingsFile, {}) };
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJSON(config.settingsFile, next);
  return next;
}

module.exports = {
  ensureDir,
  loadLibrary,
  addLibraryEntry,
  removeLibraryEntry,
  listLibrary,
  loadHistory,
  addHistory,
  clearHistory,
  loadSettings,
  saveSettings,
};
