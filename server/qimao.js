'use strict';

/**
 * 七猫（qimao / wtzw）数据层 —— 逐函数照搬 macOS 版 `Core/Qimao/QimaoClient.swift`
 * （源头 `qimao/qimao.go`）。签名 / 请求头 / URL / 协议原样照抄，未做任何"优化"。
 */
const path = require('path');
const fs = require('fs');
const http = require('./http');
const sign = require('./qimao-sign');
const crypt = require('./qimao-crypto');
const writers = require('./writers');

/** qimao.go:37-42 baseURLs */
const BASE_URLS = {
  search: 'https://api-bc.wtzw.com',
  detail: 'https://api-bc.wtzw.com',
  download: 'https://api-bc.wtzw.com',
  catalog: 'https://api-ks.wtzw.com',
};

const RANK_API = 'https://www.qimao.com/qimaoapi/api/rank/book-list';

class QimaoError extends Error {
  constructor(message) {
    super(message);
    this.kind = 'qimao';
  }
}

/** qimao.go:259 `get`：补 sign，排序编码 query，头 = requestHeaders(bookID) */
async function get(baseKey, p, params, bookID) {
  const withSign = { ...params };
  withSign.sign = sign.sign(withSign);
  const url = (BASE_URLS[baseKey] || '') + p + '?' + sign.queryEncode(withSign);
  const res = await http.raw(url, { headers: sign.requestHeaders(bookID), timeout: 30000 });
  if (res.status !== 200) throw new QimaoError(`七猫服务返回 HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new QimaoError('七猫返回数据无法解析');
  }
}

// ─────────────────────────────── 搜索 / 详情 / 目录 ───────────────────────────────

async function search(keyword) {
  const data = await get(
    'search',
    '/search/v1/words',
    {
      extend: '',
      tab: '0',
      gender: '0',
      refresh_state: '8',
      page: '1',
      wd: keyword,
      is_short_story_user: '0',
    },
    '00000000'
  );
  const books = (data && data.data && data.data.books) || [];
  return books
    .map((item) => {
      const id = strOf(item.id);
      if (!id) return null;
      return {
        platform: 'qimao',
        bookID: id,
        title: sign.stripHTML(strOf(item.title)),
        author: sign.stripHTML(strOf(item.author)),
        isOver: strOf(item.is_over) === '1',
        score: strOf(item.score),
        words: extractWords(strOf(item.sub_title)),
        hot: '',
        abstract: '',
        coverURL: strOf(item.image_link),
      };
    })
    .filter(Boolean);
}

async function bookDetail(bookID) {
  const data = await get(
    'detail',
    '/api/v4/book/detail',
    { id: bookID, imei_ip: '2937357107', teeny_mode: '0' },
    bookID
  );
  const dm = data && data.data;
  const b = dm && dm.book;
  if (!b) throw new QimaoError('七猫返回数据缺少字段（detail: 无 book 字段）');

  const tags = ((b.book_tag_list) || []).map((t) => strOf(t.title)).filter(Boolean);
  const attr = b.attribute || {};
  const category = (strOf(b.category1_name) + ' ' + strOf(b.category2_name)).trim();
  return {
    platform: 'qimao',
    bookID: firstNonEmpty(strOf(b.id), bookID),
    title: strOf(b.title),
    formerTitle: '',
    author: strOf(b.author),
    description: strOf(b.intro),
    category,
    chapterCount: 0,
    coverURL: strOf(b.image_link),
    words: formatWords(intOf(b.words_num)),
    hot: composeHot(attr),
    score: strOf(attr.score) ? `${strOf(attr.score)} 分` : '暂无评分',
    finished: false,
    tags: tags.join(', '),
    rank: cleanRank(strOf(attr.rank_title)),
    characters: firstNonEmpty(strOf(attr.characters), strOf(b.characters)),
  };
}

async function chapterList(bookID) {
  const data = await get('catalog', '/api/v1/chapter/chapter-list', { chapter_ver: '0', id: bookID }, bookID);
  const lists = (data && data.data && data.data.chapter_lists) || [];
  const chapters = lists.map((item, i) => ({
    id: strOf(item.id),
    title: strOf(item.title),
    sort: intOf(item.chapter_sort),
    _i: i,
  }));
  chapters.sort((a, b) => (a.sort !== b.sort ? a.sort - b.sort : a._i - b._i));
  return chapters.map(({ id, title, sort }) => ({ id, title, sort }));
}

// ─────────────────────────────── 榜单 ───────────────────────────────

/** isGirl "0"男 "1"女；rankType 1大热 2新书 3完结 4收藏 6更新 */
async function rankingBooks(isGirl, rankType) {
  const params = {
    is_girl: isGirl,
    rank_type: rankType,
    page: '1',
    date_type: rankType === '4' || rankType === '6' ? '1' : '2',
  };
  const url = RANK_API + '?' + sign.queryEncode(params);
  const res = await http.raw(url, {
    headers: {
      'User-Agent': http.BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
    },
    timeout: 30000,
  });
  if (res.status !== 200) throw new QimaoError(`七猫榜单返回 HTTP ${res.status}`);
  const payload = JSON.parse(await res.text());
  const rows = (payload && payload.data && payload.data.table_data) || [];
  return rows
    .map((it) => {
      const id = strOf(it.book_id);
      if (!id) return null;
      const hot = (strOf(it.number) + strOf(it.unit)).trim();
      const category = (strOf(it.category1_name) + ' ' + strOf(it.category2_name)).trim();
      return {
        platform: 'qimao',
        bookID: id,
        title: strOf(it.title),
        author: strOf(it.author),
        words: strOf(it.words_num),
        hot,
        coverURL: strOf(it.image_link),
        abstract: strOf(it.intro),
        isOver: strOf(it.is_over) === '1',
        category,
      };
    })
    .filter(Boolean);
}

// ─────────────────────────────── 下载 ───────────────────────────────

async function downloadURL(bookID) {
  const data = await get(
    'download',
    '/api/v1/book/download',
    { id: bookID, source: '1', type: '2', is_vip: '1' },
    bookID
  );
  return strOf(data && data.data && data.data.link);
}

async function downloadZip(link) {
  const res = await http.raw(link, { headers: sign.requestHeaders(''), timeout: 120000 });
  if (res.status !== 200) throw new QimaoError(`七猫下载包返回 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * qimao.go:659 `Download`：详情 + 目录 + zip + 解密 + 写文件。
 * 返回 { path, fileName, size }。
 */
async function download(bookID, outputDir, format = 'txt', onProgress) {
  const book = await bookDetail(bookID);
  const catalog = await chapterList(bookID);
  const link = await downloadURL(bookID);
  const zipBytes = await downloadZip(link);
  const chapters = crypt.unzipChapters(zipBytes);

  const ordered = [];
  for (let i = 0; i < catalog.length; i++) {
    const chapter = catalog[i];
    const content = chapters[chapter.id];
    if (content !== undefined) ordered.push({ chapter, content });
    if (onProgress) onProgress(i + 1, catalog.length);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const base =
    sign.safeFilename(book.title) +
    ' ' +
    sign.safeFilename(book.author) +
    ' [' +
    sign.safeFilename(book.bookID) +
    ']';

  let filePath;
  if (format === 'epub') {
    filePath = path.join(outputDir, base + '.epub');
    await writers.writeEpub(book, ordered, filePath);
  } else {
    filePath = path.join(outputDir, base + '.txt');
    writers.writeSingleTxt(book, ordered, filePath);
  }
  const stat = fs.statSync(filePath);
  return { path: filePath, fileName: path.basename(filePath), size: stat.size };
}

// ─────────────────────────────── 取值器（qimao.go:707 起） ───────────────────────────────

function strOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function intOf(v) {
  if (typeof v === 'number') return Math.trunc(v);
  const n = parseInt(strOf(v), 10);
  return Number.isFinite(n) ? n : 0;
}

function firstNonEmpty(a, b) {
  return a ? a : b;
}

/** 从 "影视・影视原著・完结・536万字" 提取 "536万字" */
function extractWords(s) {
  const m = String(s).match(/\d+(?:\.\d+)?万?字/);
  return m ? m[0] : '';
}

/** 拼 "265.9万 人气 · 22.2万 在读" */
function composeHot(attr) {
  const parts = [];
  const pop = strOf(attr && attr.popularity);
  if (pop && pop !== '0') parts.push(pop + '万 人气');
  const read = strOf(attr && attr.reading);
  if (read && read !== '0') parts.push(read + '万 在读');
  return parts.join(' · ');
}

/** 去掉 "当前排第###7###名" 里的 ### 标记 */
function cleanRank(s) {
  if (!s) return '';
  return String(s).replace(/#+(\d+)#+/g, '$1').trim();
}

/** 5353368 → "535万字" */
function formatWords(n) {
  if (n >= 10000) return `${Math.round(n / 10000)}万字`;
  return `${n}字`;
}

module.exports = { search, bookDetail, chapterList, rankingBooks, download, QimaoError };
