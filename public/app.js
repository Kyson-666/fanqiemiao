'use strict';

/* 番茄喵 Web · 前端 SPA（无框架，Hash 路由） */

const state = {
  platform: 'fanqie',
  route: 'rank',
  status: null,
  rankGroups: [],
  rankGroup: '综合',
  rankGenre: null,
  rankBooks: [],
  qimaoRank: { isGirl: '0', rankType: '1' },
  searchResults: [],
  searchKeyword: '',
  tasks: [],
  library: [],
  pollTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const view = () => $('#view');

// ─────────────────────────────── API ───────────────────────────────

function getToken() {
  return localStorage.getItem('fqm_token') || '';
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (res.status === 401 && data && data.auth) {
    const pw = prompt('请输入访问口令：');
    if (pw) {
      localStorage.setItem('fqm_token', pw);
      return api(path, opts);
    }
    throw new Error('需要访问口令');
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  return data;
}

// ─────────────────────────────── 工具 ───────────────────────────────

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/** img / 下载链接等非 fetch 请求无法携带 Authorization 头，改为在 URL 上带 ?token=（服务端 checkAuth 支持） */
function withToken(path) {
  const token = getToken();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function coverSrc(url, fallbackURLs = []) {
  if (!url) return '';
  const q = new URLSearchParams({ url, v: '2' }); // v 参数换新缓存键，避免旧 HEIC 响应缓存 24h
  for (const fallback of fallbackURLs || []) if (fallback) q.append('fallback', fallback);
  // 口令模式下 <img> 不会带 Authorization 头；必须把 token 挂在 URL 上，否则封面 401 → 占位图
  return withToken('/api/cover?' + q.toString());
}

/** 封面加载失败时的占位图（避免出现裂图） */
const COVER_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160">' +
      '<rect width="100%" height="100%" fill="#eef1f5"/>' +
      '<text x="50%" y="55%" font-size="42" fill="#b8c2cc" text-anchor="middle" font-family="sans-serif">书</text>' +
      '</svg>'
  );

function coverErr(el) {
  el.onerror = null;
  el.src = COVER_PLACEHOLDER;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─────────────────────────────── 渲染入口 ───────────────────────────────

function render() {
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === state.route);
  });
  document.querySelectorAll('#platformToggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.platform === state.platform);
  });

  if (state.route === 'rank') return renderRank();
  if (state.route === 'search') return renderSearch();
  if (state.route === 'downloads') return renderDownloads();
  if (state.route === 'library') return renderLibrary();
  if (state.route === 'settings') return renderSettings();
}

function setRoute(route) {
  state.route = route;
  if (location.hash !== '#/' + route) location.hash = '#/' + route;
  render();
}

// ─────────────────────────────── 榜单 ───────────────────────────────

async function renderRank() {
  view().innerHTML = `<div class="loading"><span class="spinner"></span>加载榜单…</div>`;
  try {
    if (state.platform === 'qimao') return await renderQimaoRank();
    if (!state.rankGroups.length) {
      const data = await api('/api/rank/groups');
      state.rankGroups = data.groups || [];
    }
    renderRankShell();
    await loadRankBooks();
  } catch (err) {
    view().innerHTML = `<div class="empty"><div class="big">😕</div>${esc(err.message)}</div>`;
  }
}

function renderRankShell() {
  const groups = state.rankGroups;
  const current = groups.find((g) => g.gender === state.rankGroup) || groups[0];
  const genres = current ? current.genres : [];

  view().innerHTML = `
    <div class="section-title">番茄榜单 <span class="muted">综合热榜 / 男频 / 女频</span>
      <span class="spacer"></span>
      <button class="btn" id="refreshRank">刷新</button>
    </div>
    <div class="filters" id="genderFilters">
      ${groups.map((g) => `<button class="chip ${g.gender === state.rankGroup ? 'active' : ''}" data-gender="${esc(g.gender)}">${esc(g.gender)}</button>`).join('')}
    </div>
    ${genres.length ? `<div class="filters" id="genreFilters">
      ${genres.map((g) => `<button class="chip ${state.rankGenre === g.name ? 'active' : ''}" data-genre="${esc(g.name)}">${esc(g.name)}</button>`).join('')}
    </div>` : ''}
    <div id="rankList"><div class="loading"><span class="spinner"></span>加载中…</div></div>
  `;

  $('#refreshRank').onclick = () => loadRankBooks(true);
  document.querySelectorAll('#genderFilters .chip').forEach((b) => {
    b.onclick = () => {
      state.rankGroup = b.dataset.gender;
      state.rankGenre = null;
      renderRankShell();
      loadRankBooks();
    };
  });
  document.querySelectorAll('#genreFilters .chip').forEach((b) => {
    b.onclick = () => {
      state.rankGenre = b.dataset.genre;
      renderRankShell();
      loadRankBooks();
    };
  });
}

async function loadRankBooks(force = false) {
  const list = $('#rankList');
  if (!list) return;
  list.innerHTML = `<div class="loading"><span class="spinner"></span>加载中…</div>`;

  const group = state.rankGroups.find((g) => g.gender === state.rankGroup) || state.rankGroups[0];
  let rankURL = group.hotURL;
  if (state.rankGenre && group.genres) {
    const genre = group.genres.find((g) => g.name === state.rankGenre);
    if (genre) rankURL = genre.readURL || genre.newURL;
  }
  try {
    const data = await api(`/api/rank?url=${encodeURIComponent(rankURL)}${force ? '&force=1' : ''}`);
    state.rankBooks = data.books || [];
    list.innerHTML = state.rankBooks.length
      ? `<div class="grid">${state.rankBooks.map((b, i) => cardHTML(b, i + 1)).join('')}</div>`
      : `<div class="empty"><div class="big">📭</div>该榜单暂无数据</div>`;
    bindCards(list);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="big">😕</div>${esc(err.message)}</div>`;
  }
}

async function renderQimaoRank() {
  const types = [
    ['1', '大热榜'], ['2', '新书榜'], ['3', '完结榜'], ['4', '收藏榜'], ['6', '更新榜'],
  ];
  view().innerHTML = `
    <div class="section-title">七猫榜单 <span class="muted">男频 / 女频</span>
      <span class="spacer"></span>
      <button class="btn" id="refreshRank">刷新</button>
    </div>
    <div class="filters" id="qGender">
      <button class="chip ${state.qimaoRank.isGirl === '0' ? 'active' : ''}" data-g="0">男频</button>
      <button class="chip ${state.qimaoRank.isGirl === '1' ? 'active' : ''}" data-g="1">女频</button>
    </div>
    <div class="filters" id="qType">
      ${types.map(([v, n]) => `<button class="chip ${state.qimaoRank.rankType === v ? 'active' : ''}" data-t="${v}">${n}</button>`).join('')}
    </div>
    <div id="rankList"><div class="loading"><span class="spinner"></span>加载中…</div></div>
  `;
  $('#refreshRank').onclick = () => loadQimaoRank();
  document.querySelectorAll('#qGender .chip').forEach((b) => {
    b.onclick = () => { state.qimaoRank.isGirl = b.dataset.g; renderQimaoRank(); };
  });
  document.querySelectorAll('#qType .chip').forEach((b) => {
    b.onclick = () => { state.qimaoRank.rankType = b.dataset.t; renderQimaoRank(); };
  });
  await loadQimaoRank();
}

async function loadQimaoRank() {
  const list = $('#rankList');
  if (!list) return;
  list.innerHTML = `<div class="loading"><span class="spinner"></span>加载中…</div>`;
  try {
    const data = await api(`/api/rank/qimao?isGirl=${state.qimaoRank.isGirl}&rankType=${state.qimaoRank.rankType}`);
    const books = data.books || [];
    list.innerHTML = books.length
      ? `<div class="grid">${books.map((b, i) => cardHTML(b, i + 1)).join('')}</div>`
      : `<div class="empty"><div class="big">📭</div>该榜单暂无数据</div>`;
    bindCards(list);
  } catch (err) {
    list.innerHTML = `<div class="empty"><div class="big">😕</div>${esc(err.message)}</div>`;
  }
}

// ─────────────────────────────── 卡片 ───────────────────────────────

function cardHTML(book, rank) {
  const cover = book.coverURL
    ? `<img class="cover" src="${esc(coverSrc(book.coverURL, book.coverFallbackURLs))}" loading="lazy" onerror="coverErr(this)">`
    : `<div class="cover"></div>`;
  const meta = [book.score, book.words, book.hot].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  return `
    <div class="card" data-platform="${esc(book.platform || state.platform)}" data-id="${esc(book.bookID)}"
         data-title="${esc(book.title)}" data-author="${esc(book.author || '')}">
      ${rank ? `<div class="rank-no">${rank}</div>` : ''}
      ${cover}
      <div class="info">
        <div class="title">${esc(book.title)}</div>
        <div class="author">${esc(book.author || '佚名')}</div>
        <div class="abstract">${esc(book.abstract || '')}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>
    </div>
  `;
}

function bindCards(root) {
  root.querySelectorAll('.card').forEach((el) => {
    el.onclick = () => openDetail(el.dataset.platform, el.dataset.id, el.dataset.title, el.dataset.author);
  });
}

// ─────────────────────────────── 搜索 ───────────────────────────────

async function renderSearch() {
  if (!state.searchKeyword) {
    view().innerHTML = `<div class="empty"><div class="big">🔍</div>输入书名、数字 ID 或书籍链接开始搜索</div>`;
    return;
  }
  view().innerHTML = `
    <div class="section-title">搜索「${esc(state.searchKeyword)}」<span class="muted">${state.platform === 'qimao' ? '七猫小说' : '番茄小说'}</span></div>
    <div id="searchList"><div class="loading"><span class="spinner"></span>搜索中…</div></div>
  `;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(state.searchKeyword)}&platform=${state.platform}`);
    const items = data.items || [];
    const list = $('#searchList');
    list.innerHTML = items.length
      ? `<div class="grid">${items.map((b) => cardHTML(b)).join('')}</div>`
      : `<div class="empty"><div class="big">📭</div>未找到相关结果</div>`;
    bindCards(list);
  } catch (err) {
    $('#searchList').innerHTML = `<div class="empty"><div class="big">😕</div>${esc(err.message)}</div>`;
  }
}

// ─────────────────────────────── 详情 ───────────────────────────────

async function openDetail(platform, id, fallbackTitle, fallbackAuthor) {
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-mask" id="mask">
      <div class="modal">
        <div class="modal-head">
          <div class="h-info">
            <h2>${esc(fallbackTitle)}</h2>
            <div class="h-author">${esc(fallbackAuthor)}</div>
          </div>
        </div>
        <div class="modal-body"><div class="loading"><span class="spinner"></span>加载详情…</div></div>
      </div>
    </div>`;
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') closeModal(); };

  try {
    const data = await api(`/api/book?platform=${platform}&id=${encodeURIComponent(id)}`);
    renderDetail(data.book, platform);
  } catch (err) {
    root.querySelector('.modal-body').innerHTML = `<div class="empty"><div class="big">😕</div>${esc(err.message)}</div>`;
  }
}

function renderDetail(book, platform) {
  const root = $('#modalRoot');
  const tags = (book.tags ? String(book.tags).split(/,\s*/) : []).filter(Boolean);
  const stats = [
    book.score && `<span><b>${esc(book.score)}</b></span>`,
    book.words && `<span>${esc(book.words)}</span>`,
    book.hot && `<span>${esc(book.hot)}</span>`,
    book.chapterCount ? `<span>${book.chapterCount} 章</span>` : '',
    book.finished ? '<span>已完结</span>' : '',
  ].filter(Boolean).join('');

  root.innerHTML = `
    <div class="modal-mask" id="mask">
      <div class="modal">
        <div class="modal-head">
          ${book.coverURL
            ? `<img src="${esc(coverSrc(book.coverURL, book.coverFallbackURLs))}" onerror="coverErr(this)">`
            : `<div style="width:110px;height:150px;border-radius:10px;background:#eef0f3;flex:none"></div>`}
          <div class="h-info">
            <h2>${esc(book.title)}</h2>
            ${book.formerTitle ? `<div class="h-author">曾用名：${esc(book.formerTitle)}</div>` : ''}
            <div class="h-author">${esc(book.author || '佚名')}${book.category ? ' · ' + esc(book.category) : ''}</div>
            <div class="h-stats">${stats}</div>
            ${book.rank ? `<div class="h-author">${esc(book.rank)}</div>` : ''}
          </div>
        </div>
        <div class="modal-body">
          ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
          <h3>简介</h3>
          <div class="desc">${esc(book.description || '暂无简介')}</div>
          <div class="kv">
            <span class="k">平台</span><span>${platform === 'qimao' ? '七猫小说' : '番茄小说'}</span>
            <span class="k">小说 ID</span><span><code class="inline">${esc(book.bookID)}</code></span>
            <span class="k">格式</span><span>TXT（整本导出）</span>
          </div>
          <div class="modal-actions">
            <button class="btn primary" id="dlBtn">下载整本</button>
            <div class="progress"><i id="dlBar"></i></div>
            <span class="muted" id="dlText" style="color:#6b7280;font-size:13px"></span>
          </div>
        </div>
      </div>
    </div>`;
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') closeModal(); };
  $('#dlBtn').onclick = () => startDownload(book, platform);
}

function closeModal() {
  $('#modalRoot').innerHTML = '';
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function startDownload(book, platform) {
  const btn = $('#dlBtn');
  btn.disabled = true;
  btn.textContent = '创建任务…';
  try {
    const data = await api('/api/download', {
      method: 'POST',
      body: {
        platform,
        bookID: book.bookID,
        title: book.title,
        author: book.author,
      },
    });
    const taskId = data.task.id;
    toast('已创建下载任务', 'ok');
    btn.textContent = '下载中…';
    pollTask(taskId, (t) => {
      const bar = $('#dlBar');
      const text = $('#dlText');
      if (!bar) return;
      if (t.state === '下载完成') {
        bar.style.width = '100%';
        btn.textContent = '下载完成';
        btn.disabled = false;
        if (text) text.textContent = `${t.fileName}（${fmtSize(t.size)}）`;
        toast('下载完成：' + t.fileName, 'ok');
        state.tasks = [];
        return true;
      }
      if (t.state === '失败' || t.state === '已取消') {
        btn.textContent = '重试下载';
        btn.disabled = false;
        if (text) text.textContent = t.message || t.state;
        toast('下载失败：' + (t.message || t.state), 'err');
        return true;
      }
      const pct = t.total > 0 ? Math.min(100, Math.round((t.saved / t.total) * 100)) : 0;
      bar.style.width = pct + '%';
      btn.textContent = '下载中…';
      if (text) text.textContent = t.total > 0 ? `${t.saved}/${t.total} 章（${pct}%）` : `已下载 ${t.saved} 章`;
      return false;
    });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '下载整本';
    toast(err.message, 'err');
  }
}

function pollTask(taskId, onUpdate) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const tick = async () => {
    try {
      const data = await api('/api/tasks/' + taskId);
      const done = onUpdate(data.task);
      if (done) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    } catch {
      /* 忽略单次失败 */
    }
  };
  tick();
  state.pollTimer = setInterval(tick, 1000);
}

// ─────────────────────────────── 下载管理 ───────────────────────────────

async function renderDownloads() {
  view().innerHTML = `
    <div class="section-title">下载管理 <span class="spacer"></span><button class="btn" id="refreshTasks">刷新</button></div>
    <div id="taskList"><div class="loading"><span class="spinner"></span>加载中…</div></div>
  `;
  $('#refreshTasks').onclick = loadTasks;
  await loadTasks();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.route === 'downloads') loadTasks(true);
    else { clearInterval(state.pollTimer); state.pollTimer = null; }
  }, 2000);
}

async function loadTasks(silent = false) {
  const box = $('#taskList');
  if (!box) return;
  try {
    const data = await api('/api/tasks');
    const list = data.tasks || [];
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">📥</div>暂无下载任务</div>`;
      return;
    }
    box.innerHTML = `
      <table class="list">
        <thead><tr><th>书名</th><th>平台</th><th>状态</th><th>进度</th><th>操作</th></tr></thead>
        <tbody>
          ${list.map((t) => `
            <tr>
              <td>${esc(t.title)}<div style="color:#6b7280;font-size:12px">${esc(t.author || '')}</div></td>
              <td>${t.platform === 'qimao' ? '七猫' : '番茄'}</td>
              <td><span class="state ${esc(t.state)}">${esc(t.state)}</span>${t.message ? `<div style="color:#d93025;font-size:12px">${esc(t.message)}</div>` : ''}</td>
              <td>${t.total > 0 ? `${t.saved}/${t.total}` : (t.saved ? `已下载 ${t.saved} 章` : '—')}</td>
              <td>${['准备中', '下载中'].includes(t.state)
                ? `<button class="btn danger" data-cancel="${t.id}">取消</button>`
                : (t.state === '下载完成' && t.fileName ? `<a class="btn" href="${esc(withToken('/api/file?name=' + encodeURIComponent(t.fileName)))}">下载</a>` : '')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    box.querySelectorAll('[data-cancel]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/tasks/${b.dataset.cancel}/cancel`, { method: 'POST' });
          toast('已取消');
          loadTasks();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
  } catch (err) {
    if (!silent) box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ─────────────────────────────── 文件库 ───────────────────────────────

async function renderLibrary() {
  view().innerHTML = `
    <div class="section-title">文件库 <span class="spacer"></span><button class="btn" id="refreshLib">刷新</button></div>
    <div id="libList"><div class="loading"><span class="spinner"></span>加载中…</div></div>
  `;
  $('#refreshLib').onclick = loadLibrary;
  await loadLibrary();
}

async function loadLibrary() {
  const box = $('#libList');
  try {
    const data = await api('/api/library');
    const files = data.files || [];
    if (!files.length) {
      box.innerHTML = `<div class="empty"><div class="big">📚</div>还没有下载任何小说<div style="margin-top:8px;font-size:12px">下载目录：<code class="inline">${esc(data.downloadDir)}</code></div></div>`;
      return;
    }
    box.innerHTML = `
      <table class="list">
        <thead><tr><th>文件名</th><th>大小</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          ${files.map((f) => `
            <tr>
              <td>${esc(f.title || f.fileName)}</td>
              <td>${fmtSize(f.size)}</td>
              <td>${fmtTime(f.mtimeMs)}</td>
              <td>
                <a class="btn" href="${esc(withToken('/api/file?name=' + encodeURIComponent(f.fileName)))}">下载</a>
                <button class="btn danger" data-del="${esc(f.fileName)}">删除</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    box.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`确认删除「${b.dataset.del}」？此操作不可恢复。`)) return;
        try {
          await api('/api/library?file=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
          toast('已删除', 'ok');
          loadLibrary();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
  } catch (err) {
    box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ─────────────────────────────── 设置 ───────────────────────────────

async function renderSettings() {
  view().innerHTML = `<div class="loading"><span class="spinner"></span>加载中…</div>`;
  const [statusData, histData, logData] = await Promise.all([
    api('/api/status').catch(() => null),
    api('/api/history').catch(() => ({ history: [] })),
    api('/api/logs?lines=150').catch(() => null),
  ]);
  const k = statusData ? statusData.kernel : {};
  const settings = statusData ? statusData.settings : {};
  const history = histData.history || [];

  view().innerHTML = `
    <div class="section-title">设置</div>

    <div class="panel">
      <h3>番茄内核</h3>
      <div class="row"><span class="k">状态</span><span class="state ${k.phase === 'ready' ? '下载完成' : '失败'}">${k.phase === 'ready' ? '就绪' : (k.phase === 'missing' ? '未找到内核' : esc(k.phase || '未知'))}</span></div>
      <div class="row"><span class="k">内核版本</span><span>${esc(k.version || '未知')}</span></div>
      <div class="row"><span class="k">可执行文件</span><code class="inline">${esc(k.bin || '')}</code></div>
      ${k.error ? `<div class="row"><span class="k">错误</span><span style="color:#d93025">${esc(k.error)}</span></div>` : ''}
    </div>

    <div class="panel">
      <h3>存储</h3>
      <div class="row"><span class="k">下载目录</span><code class="inline">${esc(settings.downloadDir || '')}</code></div>
      <div class="row"><span class="k">说明</span><span>该目录由容器卷挂载决定，可在 <code class="inline">docker-compose.yml</code> 中把宿主机任意路径映射到它。</span></div>
    </div>

    ${logData ? `
    <div class="panel">
      <h3>运行日志 <button class="btn" id="refreshLogs">刷新</button></h3>
      <div class="row"><span class="k">应用日志</span><code class="inline">${esc(logData.file || '')}</code>${logData.exists ? `<span style="color:#6b7280">${fmtSize(logData.size)}</span>` : '<span style="color:#6b7280">暂无</span>'}</div>
      <div class="row"><span class="k">内核日志</span><code class="inline">${esc(logData.kernelLog || '')}</code></div>
      ${logData.lines && logData.lines.length
        ? `<pre class="log-tail">${esc(logData.lines.join('\n'))}</pre>`
        : '<div style="color:#6b7280;margin-bottom:10px">暂无日志</div>'}
      <div class="row"><a class="btn" href="${esc(withToken('/api/logs/download'))}">下载完整日志</a><span style="color:#6b7280;font-size:12px">记录封面 / 搜索 / 下载事件，便于排查问题</span></div>
    </div>` : ''}

    <div class="panel">
      <h3>最近查看 <span class="spacer"></span><button class="btn danger" id="clearHist">清空</button></h3>
      <div id="histBox">${history.length
        ? history.slice(0, 30).map((h) => `<div class="row"><span class="k">${h.type === 'search' ? '搜索' : '书籍'}</span><span>${esc(h.title || h.key)}</span></div>`).join('')
        : '<div style="color:#6b7280">暂无记录</div>'}</div>
    </div>

    <div class="panel">
      <h3>关于</h3>
      <div class="row"><span class="k">应用</span><span>番茄喵 Web v${esc((statusData && statusData.version) || '1.0.0')}</span></div>
      <div class="row"><span class="k">引擎</span><span>Tomato-Novel-Downloader（Rust 内核，随镜像分发）</span></div>
      <div class="row"><span class="k">声明</span><span>仅供个人学习与本地备份使用，请支持正版。</span></div>
    </div>
  `;
  $('#clearHist').onclick = async () => {
    await api('/api/history/clear', { method: 'POST' });
    toast('已清空', 'ok');
    renderSettings();
  };
  const refreshLogs = $('#refreshLogs');
  if (refreshLogs) refreshLogs.onclick = () => renderSettings();
}

// ─────────────────────────────── 内核状态条 ───────────────────────────────

async function refreshStatusBar() {
  const bar = $('#kernelBar');
  try {
    const data = await api('/api/status');
    state.status = data;
    const k = data.kernel;
    if (k.phase === 'ready') {
      bar.className = 'kernel-bar show ok';
      bar.innerHTML = `● 番茄内核 v${esc(k.version || '?')} 已就绪 · 下载目录 <code class="inline">${esc(k.saveDir)}</code>`;
    } else if (k.phase === 'missing') {
      bar.className = 'kernel-bar show err';
      bar.innerHTML = `● 未找到番茄内核，番茄搜索/下载不可用（七猫与番茄榜单仍可使用）· 请检查镜像构建是否包含内核`;
    } else if (k.phase === 'failed') {
      bar.className = 'kernel-bar show err';
      bar.innerHTML = `● 番茄内核启动失败：${esc(k.error || '未知原因')}<br>七猫小说与番茄榜单不依赖内核，仍可正常使用`;
    } else {
      bar.className = 'kernel-bar show warn';
      bar.innerHTML = `● 番茄内核正在启动…（七猫与番茄榜单可先使用）`;
    }
  } catch {
    bar.className = 'kernel-bar show err';
    bar.innerHTML = '● 无法连接服务端';
  }
}

// ─────────────────────────────── 启动 ───────────────────────────────

function init() {
  const hash = location.hash.replace('#/', '') || 'rank';
  state.route = ['rank', 'search', 'downloads', 'library', 'settings'].includes(hash) ? hash : 'rank';

  window.addEventListener('hashchange', () => {
    const r = location.hash.replace('#/', '') || 'rank';
    state.route = r;
    render();
  });

  $('#platformToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    state.platform = btn.dataset.platform;
    state.searchResults = [];
    render();
  });

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    state.searchKeyword = q;
    setRoute('search');
  });

  // 顶部导航：显式接管路由
  // （此前只 preventDefault 而未接管跳转，导致「下载 / 文件库 / 设置」等只能经导航进入的页面点不动）
  $('#nav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-route]');
    if (!a) return;
    e.preventDefault();
    setRoute(a.dataset.route);
  });

  render();
  refreshStatusBar();
  setInterval(refreshStatusBar, 15000);
}

// 脚本位于 body 末尾，正常情况下 DOM 尚未就绪；加一层兜底防止事件已错过
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
