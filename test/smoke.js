'use strict';

/**
 * 端到端冒烟测试：覆盖 榜单 / 搜索 / 详情 / 下载管理 / 文件库 / 设置 全部 Web 功能。
 *
 * 前置：服务已启动（默认 http://127.0.0.1:8080），且内核可用。
 *   npm run smoke
 *   BASE=http://127.0.0.1:8099 npm run smoke
 */
const { spawn } = require('child_process');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';

// 用于测试的小体积书籍
const FANQIE_BOOK = { id: '7638631629665078297', title: '皇帝重生后，太子成了掌心宠', author: '托尔图加岛的沐辉' };
const QIMAO_BOOK = { id: '1739785', title: '小青六短篇', author: '范小青' };

let pass = 0;
const failures = [];

function log(line) {
  process.stdout.write(line + '\n');
}

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    log('  \u2713 ' + name);
  } catch (err) {
    failures.push(name + ' — ' + (err && err.message ? err.message : String(err)));
    log('  \u2717 ' + name + ' — ' + (err && err.message ? err.message : String(err)));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

async function api(pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + pathname, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(id, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data } = await api('/api/tasks/' + id);
    last = data && data.task;
    if (last && ['下载完成', '失败', '已取消'].includes(last.state)) return last;
    await sleep(1000);
  }
  return last;
}

// ─────────────────────────────── 测试主体 ───────────────────────────────

async function run() {
  log('番茄喵 Web · 端到端冒烟测试');
  log('目标：' + BASE);
  log('');

  // ---------- 设置 / 状态 ----------
  log('[设置 / 状态]');
  let status = null;
  await check('GET /api/status 返回内核状态与配置', async () => {
    const { status: code, data } = await api('/api/status');
    assert(code === 200, 'HTTP ' + code);
    assert(data.kernel && typeof data.kernel.phase === 'string', '缺少 kernel.phase');
    assert(data.settings && data.settings.downloadDir, '缺少 settings.downloadDir');
    assert(typeof data.version === 'string', '缺少 version');
    status = data;
  });
  await check('内核处于 ready（番茄链路可用）', async () => {
    assert(status && status.kernel.phase === 'ready', '内核 phase=' + (status && status.kernel.phase));
  });
  await check('GET /api/settings 返回设置', async () => {
    const { status: code, data } = await api('/api/settings');
    assert(code === 200 && data.settings && data.settings.downloadDir, '返回异常');
  });
  await check('POST /api/settings 可保存设置', async () => {
    const { status: code, data } = await api('/api/settings', { method: 'POST', body: { theme: 'light' } });
    assert(code === 200 && data.settings, '返回异常');
    assert(data.settings.theme === 'light', '未写入 theme');
  });

  // ---------- 榜单 ----------
  log('');
  log('[榜单]');
  let rankURL = '';
  await check('GET /api/rank/groups 返回番茄榜单分类', async () => {
    const { status: code, data } = await api('/api/rank/groups');
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.groups) && data.groups.length > 0, '分组为空');
    const hot = data.groups.find((g) => g.gender === '综合');
    assert(hot && hot.hotURL, '缺少综合热榜 URL');
    rankURL = hot.hotURL;
    const male = data.groups.find((g) => g.gender === '男频');
    assert(male && male.genres.length > 0, '男频题材为空');
  });
  await check('GET /api/rank 返回番茄榜单书籍（含封面）', async () => {
    const { status: code, data } = await api('/api/rank?url=' + encodeURIComponent(rankURL));
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.books) && data.books.length > 0, '榜单为空');
    const b = data.books[0];
    assert(b.bookID && b.title, '书籍字段缺失');
    assert(b.platform === 'fanqie', 'platform 应为 fanqie');
  });
  await check('GET /api/rank/qimao 返回七猫榜单书籍', async () => {
    const { status: code, data } = await api('/api/rank/qimao?isGirl=0&rankType=1');
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.books) && data.books.length > 0, '榜单为空');
    assert(data.books[0].platform === 'qimao', 'platform 应为 qimao');
  });

  // ---------- 搜索 ----------
  log('');
  log('[搜索]');
  await check('GET /api/search 番茄按书名搜索', async () => {
    const { status: code, data } = await api('/api/search?platform=fanqie&q=' + encodeURIComponent('斗破苍穹'));
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.items) && data.items.length > 0, '无结果');
    assert(data.items[0].bookID && data.items[0].title, '字段缺失');
  });
  await check('GET /api/search 番茄按纯数字 ID 直达', async () => {
    const { status: code, data } = await api('/api/search?platform=fanqie&q=' + FANQIE_BOOK.id);
    assert(code === 200, 'HTTP ' + code);
    assert(data.items.length === 1, '应为 1 条');
    assert(data.items[0].bookID === FANQIE_BOOK.id, 'ID 不匹配');
  });
  await check('GET /api/search 七猫按书名搜索', async () => {
    const { status: code, data } = await api('/api/search?platform=qimao&q=' + encodeURIComponent('斗破苍穹'));
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.items) && data.items.length > 0, '无结果');
    assert(data.items[0].platform === 'qimao', 'platform 应为 qimao');
  });
  await check('GET /api/search 空关键词返回 400', async () => {
    const { status: code } = await api('/api/search?platform=fanqie&q=');
    assert(code === 400, 'HTTP ' + code);
  });

  // ---------- 详情 ----------
  log('');
  log('[详情]');
  await check('GET /api/book 番茄详情', async () => {
    const { status: code, data } = await api('/api/book?platform=fanqie&id=' + FANQIE_BOOK.id);
    assert(code === 200, 'HTTP ' + code);
    assert(data.book && data.book.title, '缺少 title');
    assert(data.book.bookID === FANQIE_BOOK.id, 'ID 不匹配');
    assert(typeof data.book.description === 'string', '缺少 description');
  });
  await check('GET /api/book 七猫详情', async () => {
    const { status: code, data } = await api('/api/book?platform=qimao&id=' + QIMAO_BOOK.id);
    assert(code === 200, 'HTTP ' + code);
    assert(data.book && data.book.title, '缺少 title');
    assert(data.book.platform === 'qimao', 'platform 应为 qimao');
  });
  await check('GET /api/book 缺 id 返回 400', async () => {
    const { status: code } = await api('/api/book?platform=fanqie');
    assert(code === 400, 'HTTP ' + code);
  });

  // ---------- 封面代理 ----------
  log('');
  log('[封面代理]');
  await check('GET /api/cover 代理七猫封面图片', async () => {
    const target = 'https://cdn.qimao.com/bookimg/zww/upload/readerCover/68/203050_360x480.jpg?time=1607394498';
    const res = await fetch(BASE + '/api/cover?url=' + encodeURIComponent(target));
    assert(res.status === 200, 'HTTP ' + res.status);
    assert((res.headers.get('content-type') || '').startsWith('image/'), '非图片');
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.length > 1000, '图片过小');
  });
  await check('GET /api/cover 非法地址返回 400', async () => {
    const res = await fetch(BASE + '/api/cover?url=file:///etc/passwd');
    assert(res.status === 400, 'HTTP ' + res.status);
  });

  // ---------- 下载管理 ----------
  log('');
  log('[下载管理]');
  let fanqieTaskId = '';
  let fanqieFile = '';
  await check('POST /api/download 创建番茄任务（限前 2 章）', async () => {
    const { status: code, data } = await api('/api/download', {
      method: 'POST',
      body: {
        platform: 'fanqie',
        bookID: FANQIE_BOOK.id,
        title: FANQIE_BOOK.title,
        author: FANQIE_BOOK.author,
        range: { start: 1, end: 2 },
      },
    });
    assert(code === 200, 'HTTP ' + code);
    assert(data.task && data.task.id, '缺少任务 id');
    assert(data.task.state === '下载中' || data.task.state === '准备中', '初始状态异常：' + data.task.state);
    fanqieTaskId = data.task.id;
  });
  await check('番茄任务轮询至完成并产出文件', async () => {
    const t = await waitTask(fanqieTaskId);
    assert(t && t.state === '下载完成', '最终状态：' + (t && t.state) + ' ' + (t && t.message));
    assert(t.fileName && t.fileName.endsWith('.txt'), '文件名异常：' + t.fileName);
    assert(t.size > 0, '文件大小为 0');
    fanqieFile = t.fileName;
  });

  let qimaoTaskId = '';
  let qimaoFile = '';
  await check('POST /api/download 创建七猫任务', async () => {
    const { status: code, data } = await api('/api/download', {
      method: 'POST',
      body: { platform: 'qimao', bookID: QIMAO_BOOK.id, title: QIMAO_BOOK.title, author: QIMAO_BOOK.author },
    });
    assert(code === 200, 'HTTP ' + code);
    assert(data.task && data.task.id, '缺少任务 id');
    qimaoTaskId = data.task.id;
  });
  await check('七猫任务轮询至完成并产出文件', async () => {
    const t = await waitTask(qimaoTaskId);
    assert(t && t.state === '下载完成', '最终状态：' + (t && t.state) + ' ' + (t && t.message));
    assert(t.fileName && t.fileName.endsWith('.txt'), '文件名异常：' + t.fileName);
    assert(t.size > 0, '文件大小为 0');
    qimaoFile = t.fileName;
  });
  await check('GET /api/tasks 列出全部任务', async () => {
    const { status: code, data } = await api('/api/tasks');
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.tasks) && data.tasks.length >= 2, '任务数不足');
    assert(data.tasks.some((t) => t.id === fanqieTaskId), '缺少番茄任务');
    assert(data.tasks.some((t) => t.id === qimaoTaskId), '缺少七猫任务');
  });
  await check('POST /api/tasks/:id/cancel 取消进行中的任务', async () => {
    // 取一本大书制造耗时任务，随即取消
    const { data: created } = await api('/api/download', {
      method: 'POST',
      body: { platform: 'qimao', bookID: '1784900', title: '斗破苍穹', author: '天蚕土豆' },
    });
    const id = created.task.id;
    await sleep(300);
    const { status: code, data } = await api('/api/tasks/' + id + '/cancel', { method: 'POST' });
    assert(code === 200 && data.ok === true, '取消失败');
    const { data: after } = await api('/api/tasks/' + id);
    assert(['已取消', '下载完成'].includes(after.task.state), '状态异常：' + after.task.state);
  });
  await check('GET /api/tasks/:id 不存在的任务返回 404', async () => {
    const { status: code } = await api('/api/tasks/deadbeefdeadbeef');
    assert(code === 404, 'HTTP ' + code);
  });

  // ---------- 文件库 ----------
  log('');
  log('[文件库]');
  await check('GET /api/library 列出已下载文件', async () => {
    const { status: code, data } = await api('/api/library');
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.files), 'files 非数组');
    assert(data.files.some((f) => f.fileName === fanqieFile), '缺少番茄产物');
    assert(data.files.some((f) => f.fileName === qimaoFile), '缺少七猫产物');
    const f = data.files.find((x) => x.fileName === fanqieFile);
    assert(f.size > 0 && f.platform === 'fanqie', '元数据异常');
  });
  await check('GET /api/file 可下载成品文件', async () => {
    const res = await fetch(BASE + '/api/file?name=' + encodeURIComponent(fanqieFile));
    assert(res.status === 200, 'HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    assert(buf.length > 0, '内容为空');
    assert((res.headers.get('content-disposition') || '').includes('attachment'), '缺少 attachment');
  });
  await check('GET /api/file 目录穿越被拒绝', async () => {
    const res = await fetch(BASE + '/api/file?name=' + encodeURIComponent('../../../secret.txt'));
    assert(res.status === 404 || res.status === 400, 'HTTP ' + res.status);
  });
  await check('DELETE /api/library 删除文件并从库中移除', async () => {
    const { status: code, data } = await api('/api/library?file=' + encodeURIComponent(qimaoFile), { method: 'DELETE' });
    assert(code === 200 && data.ok === true, '删除失败');
    const { data: after } = await api('/api/library');
    assert(!after.files.some((f) => f.fileName === qimaoFile), '文件仍在库中');
    assert(after.files.some((f) => f.fileName === fanqieFile), '误删其他文件');
  });

  // ---------- 历史 ----------
  log('');
  log('[最近查看 / 历史]');
  await check('GET /api/history 有搜索与详情记录', async () => {
    const { status: code, data } = await api('/api/history');
    assert(code === 200, 'HTTP ' + code);
    assert(Array.isArray(data.history) && data.history.length > 0, '历史为空');
    assert(data.history.some((h) => h.type === 'search'), '缺少搜索记录');
    assert(data.history.some((h) => h.type === 'book'), '缺少详情记录');
  });
  await check('POST /api/history/clear 清空历史', async () => {
    const { status: code, data } = await api('/api/history/clear', { method: 'POST' });
    assert(code === 200 && data.ok === true, '清空失败');
    const { data: after } = await api('/api/history');
    assert(after.history.length === 0, '历史未清空');
  });

  // ---------- 静态资源 ----------
  log('');
  log('[前端静态资源]');
  await check('GET / 返回前端页面', async () => {
    const res = await fetch(BASE + '/');
    assert(res.status === 200, 'HTTP ' + res.status);
    const html = await res.text();
    assert(html.includes('番茄喵') && html.includes('/app.js'), '页面内容异常');
  });
  await check('GET /app.js 与 /style.css 可访问', async () => {
    for (const f of ['/app.js', '/style.css']) {
      const res = await fetch(BASE + f);
      assert(res.status === 200, f + ' HTTP ' + res.status);
      const text = await res.text();
      assert(text.length > 100, f + ' 内容过短');
    }
  });

  // ---------- 访问口令 ----------
  log('');
  log('[访问口令鉴权]');
  await check('开启口令后：无口令 401 / 带口令 200', async () => {
    const port = 8091;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        WEB_PASSWORD: 'smoke-secret',
        DATA_DIR: path.join(__dirname, '..', 'data'),
        DOWNLOAD_DIR: path.join(__dirname, '..', 'downloads'),
      },
      stdio: 'ignore',
    });
    try {
      // 等待启动
      let up = false;
      for (let i = 0; i < 30; i++) {
        await sleep(400);
        try {
          await fetch('http://127.0.0.1:' + port + '/');
          up = true;
          break;
        } catch {
          /* 继续等 */
        }
      }
      assert(up, '带口令实例未启动');
      const noAuth = await fetch('http://127.0.0.1:' + port + '/api/status');
      assert(noAuth.status === 401, '无口令应为 401，实际 ' + noAuth.status);
      const withAuth = await fetch('http://127.0.0.1:' + port + '/api/status', {
        headers: { Authorization: 'Bearer smoke-secret' },
      });
      assert(withAuth.status === 200, '带口令应为 200，实际 ' + withAuth.status);
      const byQuery = await fetch('http://127.0.0.1:' + port + '/api/status?token=smoke-secret');
      assert(byQuery.status === 200, '?token= 方式应放行，实际 ' + byQuery.status);
    } finally {
      child.kill('SIGKILL');
    }
  });

  // ---------- 汇总 ----------
  log('');
  log('─'.repeat(52));
  log(`通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    log('');
    log('失败明细：');
    for (const f of failures) log('  · ' + f);
    process.exitCode = 1;
  } else {
    log('全部通过 ✅');
  }
}

run().catch((err) => {
  log('冒烟测试异常终止：' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
