'use strict';

/**
 * 番茄喵 Web · HTTP 服务
 *   - 静态托管 public/（前端 SPA）
 *   - /api/* 对外 REST（榜单 / 搜索 / 详情 / 下载 / 文件库 / 封面代理）
 *   - 内部拉起并复用番茄内核（127.0.0.1:18423）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const config = require('./config');
const store = require('./store');
const kernel = require('./kernel');
const fanqie = require('./fanqie');
const qimao = require('./qimao');
const tasks = require('./tasks');
const httpc = require('./http');
const log = require('./logger');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ─────────────────────────────── 工具 ───────────────────────────────

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, ...headers });
  res.end(text);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, url) {
  if (!config.webPassword) return true;
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ') && header.slice(7) === config.webPassword) return true;
  if (url.searchParams.get('token') === config.webPassword) return true;
  return false;
}

/** 防止目录穿越（先归一化基准目录，兼容 Windows 反斜杠 / 大小写差异） */
function safeJoin(dir, name) {
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** 仅在服务端日志记录域名与路径，不泄漏带签名的 query 参数 */
function coverLabel(value) {
  try {
    const u = new URL(value);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return String(value).slice(0, 100);
  }
}

/** 运行日志文件名白名单（防目录穿越） */
function safeLogFile(name) {
  if (name !== 'app.log' && name !== 'app.log.1') return null;
  return path.join(log.dir, name);
}

/** 按魔数嗅探图片类型（返回空字符串表示未知/不支持） */
function guessImageType(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) return 'image/gif';
  // 已允许浏览器渲染的常见图片类型；HEIC/HEIF 明确拒绝并尝试备用地址
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (/^(hei[cfx]|hevc|hevx|mif1|msf1|heim|heis|hevm|hevs)/.test(brand)) return 'image/heic';
  }
  return '';
}

// ─────────────────────────────── 静态资源 ───────────────────────────────

/** 页面/脚本/样式禁用强缓存：镜像更新后用户刷新即可用上新前端（避免旧 app.js 被浏览器缓存） */
const NO_CACHE_EXTS = new Set(['.html', '.htm', '.js', '.css']);
function staticHeaders(ext) {
  return NO_CACHE_EXTS.has(ext) ? { 'Cache-Control': 'no-cache' } : {};
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = safeJoin(PUBLIC_DIR, rel.replace(/^\/+/, ''));
  if (!full) return sendText(res, 400, '非法路径');
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA 兜底：未知路径回 index.html
      if (!path.extname(rel)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
          if (e2) return sendText(res, 404, 'Not Found');
          sendText(res, 200, html, MIME['.html'], staticHeaders('.html'));
        });
      }
      return sendText(res, 404, 'Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    sendText(res, 200, data, MIME[ext] || 'application/octet-stream', staticHeaders(ext));
  });
}

// ─────────────────────────────── API 路由 ───────────────────────────────

async function handleAPI(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // 状态
  if (p === '/api/status' && method === 'GET') {
    const k = await kernel.snapshot();
    return sendJSON(res, 200, {
      kernel: k,
      settings: store.loadSettings(),
      passwordProtected: Boolean(config.webPassword),
      version: require('../package.json').version,
    });
  }

  // 番茄榜单分组
  if (p === '/api/rank/groups' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    const groups = await fanqie.categories(force);
    return sendJSON(res, 200, { groups });
  }

  // 番茄榜单书籍
  if (p === '/api/rank' && method === 'GET') {
    const rankURL = url.searchParams.get('url') || '';
    const force = url.searchParams.get('force') === '1';
    const books = await fanqie.rankBooks(rankURL, force);
    return sendJSON(res, 200, { books });
  }

  // 七猫榜单
  if (p === '/api/rank/qimao' && method === 'GET') {
    const isGirl = url.searchParams.get('isGirl') || '0';
    const rankType = url.searchParams.get('rankType') || '1';
    const books = await qimao.rankingBooks(isGirl, rankType);
    return sendJSON(res, 200, { books });
  }

  // 搜索
  if (p === '/api/search' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const platform = url.searchParams.get('platform') || 'fanqie';
    if (!q.trim()) return sendJSON(res, 400, { error: '请输入关键词' });
    const t0 = Date.now();
    try {
      const items = platform === 'qimao' ? await qimao.search(q) : await fanqie.search(q);
      store.addHistory({ type: 'search', key: `${platform}:${q}`, title: q, platform });
      log.info('search', `platform=${platform} q="${q}" items=${items.length} elapsed=${Date.now() - t0}ms`);
      return sendJSON(res, 200, { items, platform });
    } catch (err) {
      log.error('search', `platform=${platform} q="${q}" 失败：${err && err.message} elapsed=${Date.now() - t0}ms`);
      throw err;
    }
  }

  // 详情
  if (p === '/api/book' && method === 'GET') {
    const platform = url.searchParams.get('platform') || 'fanqie';
    const id = url.searchParams.get('id') || '';
    if (!id) return sendJSON(res, 400, { error: '缺少 id' });
    const info = platform === 'qimao' ? await qimao.bookDetail(id) : await fanqie.bookInfo(id);
    store.addHistory({ type: 'book', key: `${platform}:${id}`, title: info.title, platform, bookID: id });
    return sendJSON(res, 200, { book: info });
  }

  // 创建下载任务
  if (p === '/api/download' && method === 'POST') {
    const body = await readBody(req);
    const platform = body.platform === 'qimao' ? 'qimao' : 'fanqie';
    const bookID = String(body.bookID || '').trim();
    if (!bookID) return sendJSON(res, 400, { error: '缺少 bookID' });
    const range = body.range && body.range.end > 0 ? body.range : null;
    const task = tasks.start({
      platform,
      bookID,
      title: body.title || bookID,
      author: body.author || '',
      range,
    });
    return sendJSON(res, 200, { task });
  }

  // 任务列表 / 单任务 / 取消
  if (p === '/api/tasks' && method === 'GET') {
    return sendJSON(res, 200, { tasks: tasks.list() });
  }
  const cancelMatch = p.match(/^\/api\/tasks\/([0-9a-f]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    const ok = tasks.cancel(cancelMatch[1]);
    return sendJSON(res, ok ? 200 : 400, { ok });
  }
  const taskMatch = p.match(/^\/api\/tasks\/([0-9a-f]+)$/);
  if (taskMatch && method === 'GET') {
    const t = tasks.get(taskMatch[1]);
    return t ? sendJSON(res, 200, { task: t }) : sendJSON(res, 404, { error: '任务不存在' });
  }

  // 文件库
  if (p === '/api/library' && method === 'GET') {
    return sendJSON(res, 200, { files: store.listLibrary(), downloadDir: config.downloadDir });
  }
  if (p === '/api/library' && method === 'DELETE') {
    const name = url.searchParams.get('file') || '';
    const full = safeJoin(config.downloadDir, name);
    if (!full) return sendJSON(res, 400, { error: '非法文件名' });
    try {
      fs.unlinkSync(full);
    } catch {
      /* 文件可能已不存在 */
    }
    store.removeLibraryEntry(name);
    return sendJSON(res, 200, { ok: true });
  }

  // 文件下载
  if (p === '/api/file' && method === 'GET') {
    const name = url.searchParams.get('name') || '';
    const full = safeJoin(config.downloadDir, name);
    if (!full || !fs.existsSync(full)) return sendText(res, 404, '文件不存在');
    const stat = fs.statSync(full);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // 封面代理：依次尝试主 URL 与番茄端提供的备用 URL。
  // 原 URL 可能是 403（源 CDN 限制）或 HEIC（桌面浏览器无法解码）；两种情况都试备用源。
  if (p === '/api/cover' && method === 'GET') {
    const target = url.searchParams.get('url') || '';
    const fallbacks = url.searchParams.getAll('fallback').slice(0, 4);
    const candidates = [...new Set([target, ...fallbacks].filter((u) => /^https?:\/\//i.test(u)))];
    if (!candidates.length) return sendText(res, 400, '非法地址');

    const failures = [];
    let lastType = '';
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      try {
        const origin = new URL(candidate).origin;
        const buf = await httpc.getBuffer(candidate, {
          timeout: 20000,
          headers: {
            'User-Agent': httpc.BROWSER_UA,
            Referer: origin + '/',
            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          },
        });
        const type = guessImageType(buf);
        lastType = type;
        if (!type) throw new Error('响应不是受支持的图片格式');
        if (type === 'image/heic' && i < candidates.length - 1) {
          failures.push(`${new URL(candidate).hostname}: HEIC 不受桌面浏览器支持`);
          continue;
        }
        if (type === 'image/heic') {
          failures.push(`${new URL(candidate).hostname}: HEIC 不受桌面浏览器支持`);
          break;
        }
        if (i > 0 || failures.length) {
          log.warn('cover', `主源不可用，备用源命中：${coverLabel(target)} → ${coverLabel(candidate)}${failures.length ? `（${failures.join('; ')}）` : ''}`);
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
        return;
      } catch (err) {
        const message = String((err && err.message) || '请求失败').match(/HTTP \d{3}/)?.[0] || '请求失败';
        failures.push(`${coverLabel(candidate)}: ${message}`);
      }
    }

    const reason = failures.join('; ') || (lastType ? `不支持 ${lastType}` : '没有可用封面源');
    log.warn('cover', `所有来源均不可用：${coverLabel(target)} :: ${reason}`);
    // 兜底交给浏览器直连第一个候选（若服务器出口被 CDN 屏蔽，用户侧网络仍可能可达）。
    const redirect = candidates.find((u) => !/\.hei[cf](\?|$)/i.test(u)) || target;
    res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  // 运行日志：尾部预览（封面 / 搜索 / 下载等事件持久化在 /data/logs/app.log）
  if (p === '/api/logs' && method === 'GET') {
    const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines') || '200', 10) || 200, 1), 500);
    const info = log.fileInfo();
    return sendJSON(res, 200, {
      file: info.file,
      kernelLog: config.kernelLog,
      exists: info.exists,
      size: info.size,
      mtime: info.mtime,
      lines: log.tail(lines),
    });
  }

  // 运行日志：完整文件下载（app.log / app.log.1）
  if (p === '/api/logs/download' && method === 'GET') {
    const name = url.searchParams.get('file') || 'app.log';
    const full = safeLogFile(name);
    if (!full) return sendText(res, 400, '非法文件名');
    if (!fs.existsSync(full)) return sendText(res, 404, '日志不存在');
    const stat = fs.statSync(full);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // 历史
  if (p === '/api/history' && method === 'GET') {
    return sendJSON(res, 200, { history: store.loadHistory() });
  }
  if (p === '/api/history/clear' && method === 'POST') {
    store.clearHistory();
    return sendJSON(res, 200, { ok: true });
  }

  // 设置
  if (p === '/api/settings' && method === 'GET') {
    return sendJSON(res, 200, { settings: store.loadSettings() });
  }
  if (p === '/api/settings' && method === 'POST') {
    const body = await readBody(req);
    const next = store.saveSettings(body || {});
    return sendJSON(res, 200, { settings: next });
  }

  return sendJSON(res, 404, { error: '未知接口' });
}

// ─────────────────────────────── 服务器 ───────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/')) {
      if (!checkAuth(req, url)) return sendJSON(res, 401, { error: '需要访问口令', auth: true });
      await handleAPI(req, res, url);
      return;
    }
    serveStatic(req, res, p);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!res.headersSent) sendJSON(res, 500, { error: message });
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[fanqiemiao-web] 监听 0.0.0.0:${config.port}`);
  console.log(`[fanqiemiao-web] 下载目录 ${config.downloadDir}`);
  console.log(`[fanqiemiao-web] 数据目录 ${config.dataDir}`);
  console.log(`[fanqiemiao-web] 内核 ${config.kernelBin}`);
  if (config.webPassword) console.log('[fanqiemiao-web] 已开启访问口令');
  log.info('server', `启动：version=${require('../package.json').version} port=${config.port} 数据=${config.dataDir} 下载=${config.downloadDir}`);
  // 预热内核（不阻塞启动）
  kernel.ensureReady().catch((err) => {
    log.warn('server', `番茄内核启动失败：${err.message}`);
    const tail = kernel.logTail(5);
    if (tail) log.warn('server', `内核日志末尾：${tail.replace(/ \| /g, ' | ')}`);
    log.warn('server', '提示：七猫小说与番茄榜单不依赖内核，仍可正常使用。');
  });
});

function shutdown(signal) {
  console.log(`[fanqiemiao-web] 收到 ${signal}，退出中…`);
  kernel.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
