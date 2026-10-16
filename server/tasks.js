'use strict';

/**
 * 下载任务队列：内存态 + 异步执行 + 进度上报。
 * 对照 macOS 版 `Core/Fanqie/FanqieDownload.swift` 的 DownloadCenter。
 */
const crypto = require('crypto');
const config = require('./config');
const fanqie = require('./fanqie');
const qimao = require('./qimao');
const store = require('./store');

const tasks = new Map(); // id → task
const MAX_KEEP = 200;

function newID() {
  return crypto.randomBytes(8).toString('hex');
}

function snapshot(t) {
  return {
    id: t.id,
    platform: t.platform,
    bookID: t.bookID,
    title: t.title,
    author: t.author,
    state: t.state, // 准备中 | 下载中 | 下载完成 | 失败 | 已取消
    saved: t.saved,
    total: t.total,
    message: t.message || '',
    fileName: t.fileName || '',
    size: t.size || 0,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function list() {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
}

function get(id) {
  const t = tasks.get(id);
  return t ? snapshot(t) : null;
}

function update(id, patch) {
  const t = tasks.get(id);
  if (!t) return;
  Object.assign(t, patch, { updatedAt: Date.now() });
}

function prune() {
  if (tasks.size <= MAX_KEEP) return;
  const sorted = [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  const finished = sorted.filter((t) => !['准备中', '下载中'].includes(t.state));
  while (tasks.size > MAX_KEEP && finished.length) {
    tasks.delete(finished.shift().id);
  }
}

/**
 * 创建并启动一个下载任务。返回任务快照。
 */
function start({ platform, bookID, title, author, range }) {
  const id = newID();
  const task = {
    id,
    platform: platform === 'qimao' ? 'qimao' : 'fanqie',
    bookID: String(bookID),
    title: title || bookID,
    author: author || '',
    state: '准备中',
    saved: 0,
    total: range && range.end > 0 ? range.end : 0,
    message: '',
    fileName: '',
    size: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cancelled: false,
  };
  tasks.set(id, task);
  prune();
  run(id, range).catch(() => {});
  return snapshot(task);
}

async function run(id, range) {
  const t = tasks.get(id);
  if (!t) return;
  update(id, { state: '下载中' });
  try {
    let result;
    if (t.platform === 'qimao') {
      result = await qimao.download(t.bookID, config.downloadDir, 'txt', (saved, total) => {
        if (t.cancelled) return;
        update(id, { saved, total });
      });
    } else {
      result = await fanqie.download(t.bookID, t.title, t.author, range, (p) => {
        if (t.cancelled) return;
        update(id, { saved: p.saved, total: p.total || t.total });
      });
    }
    if (t.cancelled) {
      update(id, { state: '已取消' });
      return;
    }
    update(id, {
      state: '下载完成',
      fileName: result.fileName,
      size: result.size,
      saved: t.total || t.saved,
    });
    store.addLibraryEntry({
      fileName: result.fileName,
      platform: t.platform,
      bookID: t.bookID,
      title: t.title,
      author: t.author,
      size: result.size,
    });
  } catch (err) {
    if (t.cancelled) {
      update(id, { state: '已取消' });
      return;
    }
    update(id, { state: '失败', message: err.message || String(err) });
  }
}

function cancel(id) {
  const t = tasks.get(id);
  if (!t) return false;
  if (['下载完成', '失败', '已取消'].includes(t.state)) return false;
  t.cancelled = true;
  update(id, { state: '已取消' });
  return true;
}

module.exports = { start, list, get, cancel, snapshot };
