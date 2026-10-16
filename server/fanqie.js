'use strict';

/**
 * 番茄（fanqie）数据层。
 * 对照 macOS 版 `Core/Fanqie/FanqieAPI.swift` + `FanqieBookInfo.swift` + `FanqieRank.swift`：
 *   - 搜索 / 详情 / 下载：走内核 REST（127.0.0.1:18423）
 *   - 榜单：直接抓 https://fanqienovel.com 官网页面（HTML 正则，与内核无关）
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const kernel = require('./kernel');
const http = require('./http');

const RANK_BASE = 'https://fanqienovel.com';
const WEB_NAME_PATTERN = /<meta name="keywords" content="([^",]+)"/;

/** 番茄用户可见错误 */
class FanqieError extends Error {
  constructor(message, kind = 'upstream') {
    super(message);
    this.kind = kind;
  }
}

// ─────────────────────────────── 搜索 / 详情 ───────────────────────────────

/** ≥10 位纯数字，或 /page/<id> 链接 → 书 ID */
function extractBookID(keyword) {
  const s = String(keyword || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s) && s.length >= 10) return s;
  const m = s.match(/\/page\/(\d{10,})/);
  if (m) return m[1];
  return null;
}

async function search(keyword) {
  await kernel.ensureReady();

  const directID = extractBookID(keyword);
  if (directID) {
    const info = await bookInfo(directID);
    return [searchItemFromInfo(info)];
  }

  const attempts = 4;
  let lastError = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const json = await http.getJSON(`${kernel.baseURL}/api/search?q=${encodeURIComponent(keyword)}`, {
        timeout: 30000,
      });
      const items = mapSearchItems(json);
      if (items.length) return items;
      lastError = '未找到相关结果';
    } catch (err) {
      lastError = err.message || String(err);
    }
    if (i < attempts) await http.sleep(800);
  }
  if (/HTTP 5|风控|滑块/.test(lastError)) {
    throw new FanqieError(`搜索失败：${lastError}（可能被番茄网站风控限制，请稍后再试或更换关键词）`);
  }
  throw new FanqieError(`搜索失败：${lastError || '未找到相关结果'}`);
}

async function bookInfo(id) {
  await kernel.ensureReady();
  let json;
  try {
    json = await http.getJSON(`${kernel.baseURL}/api/preview/${encodeURIComponent(id)}`, { timeout: 60000 });
  } catch (err) {
    throw new FanqieError(`详情加载失败：${err.message || err}`);
  }
  const info = mapBookInfo(json, id);
  const resolved = await resolveTitle(id, info.title);
  info.title = resolved.title;
  info.formerTitle = resolved.former;
  return info;
}

/** 榜单用：只取详情映射成一条结果（不做网页纠名） */
async function previewItem(id) {
  await kernel.ensureReady();
  const json = await http.getJSON(`${kernel.baseURL}/api/preview/${encodeURIComponent(id)}`, { timeout: 60000 });
  return searchItemFromInfo(mapBookInfo(json, id));
}

/** 作者改名书：内核返回旧名，网页是当前名（互不包含才算改名） */
async function resolveTitle(bookID, kernelTitle) {
  const web = await webBookName(bookID);
  if (!web || web === kernelTitle) return { title: kernelTitle, former: '' };
  if (web.includes(kernelTitle) || kernelTitle.includes(web)) return { title: kernelTitle, former: '' };
  return { title: web, former: kernelTitle };
}

async function webBookName(bookID) {
  try {
    const html = await http.getText(`${RANK_BASE}/page/${bookID}`, {
      timeout: 8000,
      headers: http.browserHeaders(),
    });
    const m = html.match(WEB_NAME_PATTERN);
    if (!m) return '';
    const raw = (m[1] || '').trim();
    return raw ? safeDecodeURIComponent(raw) : '';
  } catch {
    return '';
  }
}

// ─────────────────────────────── 榜单 ───────────────────────────────

let cachedGroups = null;
const rankCache = new Map(); // url → { books, at }
const RANK_TTL = 60 * 1000;

async function fetchHTML(url) {
  return http.getText(url, { timeout: 20000, headers: http.browserHeaders() });
}

/** 解析榜单分类（综合/男频/女频 + 题材） */
function parseCategories(html) {
  const re = /<a[^>]*href="(\/rank\/(\d+)_(\d+)_(\d+))"[^>]*>([\s\S]*?)<\/a>/g;
  const byGender = { 男频: new Map(), 女频: new Map() };
  let m;
  while ((m = re.exec(html))) {
    const path = m[1];
    const genderCode = m[2];
    const rankType = m[3];
    const label = stripTags(m[5]);
    if (!label || isObfuscated(label)) continue;
    const gender = genderCode === '0' ? '女频' : '男频';
    const group = byGender[gender];
    const genre = group.get(label) || { name: label, readURL: '', newURL: '' };
    if (rankType === '1') genre.readURL = RANK_BASE + path;
    else genre.newURL = RANK_BASE + path;
    group.set(label, genre);
  }
  const groups = [{ gender: '综合', hotURL: RANK_BASE + '/rank', genres: [] }];
  for (const gender of ['男频', '女频']) {
    const map = byGender[gender];
    if (map.size === 0) continue;
    const genres = [...map.keys()].sort().map((k) => map.get(k));
    groups.push({ gender, hotURL: '', genres });
  }
  return groups;
}

async function categories(force = false) {
  if (!force && cachedGroups) return cachedGroups;
  const html = await fetchHTML(RANK_BASE + '/rank');
  cachedGroups = parseCategories(html);
  return cachedGroups;
}

/** 从榜单页解析有序书 ID（/page/(\d{15,})） */
function parseIDs(html) {
  const re = /\/page\/(\d{15,})/g;
  const ids = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

/** 并发受限的 map，保序 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function rankBooks(rankURL, force = false) {
  if (!rankURL) return [];
  const hit = rankCache.get(rankURL);
  if (!force && hit && Date.now() - hit.at < RANK_TTL) return hit.books;

  const html = await fetchHTML(rankURL);
  const ids = parseIDs(html).slice(0, config.rankTopN);
  const items = await mapLimit(ids, 4, async (id) => {
    try {
      return await previewItem(id);
    } catch {
      return null;
    }
  });
  const books = items.filter(Boolean);
  rankCache.set(rankURL, { books, at: Date.now() });
  return books;
}

// ─────────────────────────────── 下载 ───────────────────────────────

/** 建内核下载任务并轮询到完成 */
async function createJob(bookID, start, end) {
  await kernel.ensureReady();
  const body = { book_id: String(bookID) };
  if (start > 0) body.range_start = start;
  if (end > 0) body.range_end = end;
  const json = await http.postJSON(`${kernel.baseURL}/api/jobs`, body, { timeout: 30000 });
  const id = json && json.id;
  if (id === undefined || id === null) throw new FanqieError('创建下载任务失败：内核没有返回任务 ID');
  return id;
}

async function jobStatus(id) {
  const json = await http.getJSON(`${kernel.baseURL}/api/jobs?id=${id}`, { timeout: 15000 });
  const first = json && json.items && json.items[0];
  if (!first) return null;
  const progress = first.progress || {};
  return {
    state: String(first.state || ''),
    message: first.message || '',
    saved: Number(progress.saved_chapters || 0),
    total: Number(progress.chapter_total || 0),
  };
}

/**
 * 完整下载流程：建任务 → 轮询 → 等产物落到暂存目录 → 搬运到持久化下载目录。
 * 返回 { path, fileName, size }。
 */
async function download(bookID, title, author, range, onProgress) {
  await kernel.ensureReady();
  const startedAt = Date.now();
  const jobID = await createJob(bookID, range && range.start, range && range.end);

  // 轮询（最多 30 分钟）
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    let job = null;
    try {
      job = await jobStatus(jobID);
    } catch {
      job = null;
    }
    if (job) {
      if (onProgress) onProgress({ saved: job.saved, total: job.total });
      if (job.state === 'done') break;
      if (job.state === 'failed' || job.state === 'cancelled') {
        throw new FanqieError(job.message || '下载失败');
      }
    }
    await http.sleep(1000);
  }

  const found = findOutput(bookID, title, startedAt);
  if (!found) throw new FanqieError('内核报告下载完成，但没找到产物文件');
  return relocate(found, bookID, title, author);
}

function isTargetFile(name, bookID, title) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext !== 'txt' && ext !== 'epub') return false;
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.includes(title) || stem.includes(bookID);
}

/** 目录名安全化（与 macOS 版 SafeFilename 一致） */
function safeName(s) {
  const out = String(s || '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/^[. ]+|[. ]+$/g, '');
  return out || 'book';
}

/** 规范成品文件名：`书名 作者 [ID].txt` */
function canonicalName(title, author, bookID) {
  return `${safeName(title)} ${safeName(author)} [${safeName(bookID)}].txt`;
}

/** 遍历目录（最多 depth 层子目录） */
function walk(dir, depth) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) out.push(full);
    else if (e.isDirectory() && depth > 0) out.push(...walk(full, depth - 1));
  }
  return out;
}

/** 在内核暂存目录 + 下载目录里找本次任务之后写入的产物 */
function findOutput(bookID, title, since) {
  const roots = [config.stagingDir, config.downloadDir];
  let newest = null;
  for (const root of roots) {
    for (const full of walk(root, 2)) {
      const name = path.basename(full);
      if (!isTargetFile(name, bookID, title)) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since - 10000) continue;
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { path: full, fileName: name, size: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  }
  return newest;
}

/** 把内核产物搬到持久化下载目录并规范命名 */
function relocate(found, bookID, title, author) {
  if (found.path.toLowerCase().endsWith('.epub')) {
    throw new FanqieError('内核产出的是 EPUB；本服务仅保存 TXT，请将内核配置改为 txt');
  }
  fs.mkdirSync(config.downloadDir, { recursive: true });
  const target = path.join(config.downloadDir, canonicalName(title, author, bookID));
  if (path.resolve(found.path) !== path.resolve(target)) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    try {
      fs.renameSync(found.path, target);
    } catch {
      // 跨卷时退化为 copy + delete
      fs.copyFileSync(found.path, target);
      fs.rmSync(found.path, { force: true });
    }
  }
  const stat = fs.statSync(target);
  return { path: target, fileName: path.basename(target), size: stat.size };
}

// ─────────────────────────────── 映射 ───────────────────────────────

function mapSearchItems(json) {
  const items = (json && json.items) || [];
  return items
    .map((item) => {
      const bookID = String(item.book_id || '');
      if (!bookID) return null;
      const raw = item.raw || {};
      const title = String(item.title || raw.book_name || '');
      if (!title) return null;
      const wordCount = Number(raw.word_number || 0);
      return {
        platform: 'fanqie',
        bookID,
        title,
        author: String(item.author || raw.author || '佚名'),
        abstract: String(raw.abstract || ''),
        score: fmtScore(raw.score),
        words: wordCount > 0 ? fmtWords(wordCount) : '',
        hot: String(raw.read_count_text || ''),
        coverURL: resolveCover(raw.thumb_url, kernel.baseURL),
      };
    })
    .filter(Boolean);
}

function mapBookInfo(json, fallbackID) {
  const wordCount = Number(json.word_count || 0);
  return {
    platform: 'fanqie',
    bookID: String(json.book_id || fallbackID),
    title: String(json.book_name || ''),
    formerTitle: String(json.original_book_name || ''),
    author: String(json.author || '佚名'),
    description: String(json.description || '').replace(/\u3000/g, ' ').trim(),
    category: String(json.category || ''),
    chapterCount: Number(json.chapter_count || 0),
    coverURL: resolveCover(json.detail_cover_url || json.cover_url, kernel.baseURL),
    words: wordCount > 0 ? fmtWords(wordCount) : '',
    hot: String(json.read_count_text || ''),
    score: fmtScore(json.score),
    finished: Boolean(json.finished),
  };
}

function searchItemFromInfo(info) {
  return {
    platform: 'fanqie',
    bookID: info.bookID,
    title: info.title,
    author: info.author,
    abstract: info.description,
    score: info.score,
    words: info.words,
    hot: info.hot,
    coverURL: info.coverURL,
  };
}

function resolveCover(raw, base) {
  if (!raw) return '';
  const s = String(raw);
  if (s.startsWith('http')) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

// ─────────────────────────────── 工具 ───────────────────────────────

function fmtScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '暂无评分';
  return `${n.toFixed(1)} 分`;
}

function fmtWords(n) {
  if (n >= 10000) return `${Math.round(n / 10000)}万字`;
  return `${n}字`;
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

/** 番茄对未登录用户做字体混淆（私用区字符） */
function isObfuscated(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xe000 && cp <= 0xf8ff) return true;
  }
  return false;
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

module.exports = {
  search,
  bookInfo,
  previewItem,
  categories,
  rankBooks,
  download,
  extractBookID,
  FanqieError,
  RANK_BASE,
};
