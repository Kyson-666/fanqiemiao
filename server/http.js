'use strict';

/**
 * 统一 HTTP 出口：超时、可选退避重试、JSON 解析。
 * 对应 macOS 版 `Core/Network/HttpClient.swift` 的简化实现（Node 内置 fetch）。
 */
const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发一次请求（带超时）。返回原始 Response。
 */
async function raw(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = config.requestTimeout,
  } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带退避重试的请求（默认 3 次，0.8/1.6/3.2s）。
 */
async function withRetry(fn, attempts = 3, delays = [800, 1600, 3200]) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delays[Math.min(i, delays.length - 1)]);
    }
  }
  throw lastErr;
}

/**
 * GET JSON。
 */
async function getJSON(url, opts = {}) {
  const res = await raw(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}${text ? ' :: ' + text.slice(0, 200) : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回内容不是 JSON（${url}）`);
  }
}

/**
 * GET 文本（HTML 抓取用）。
 */
async function getText(url, opts = {}) {
  const res = await raw(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return text;
}

/**
 * GET 二进制。
 */
async function getBuffer(url, opts = {}) {
  const res = await raw(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * POST JSON。
 */
async function postJSON(url, obj, opts = {}) {
  const res = await raw(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: JSON.stringify(obj || {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}${text ? ' :: ' + text.slice(0, 200) : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回内容不是 JSON（${url}）`);
  }
}

/** 浏览器 UA（贴合 Chrome，降低反爬误判；与 macOS 版一致） */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 榜单/网页抓取用的完整浏览器头 */
function browserHeaders() {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  };
}

module.exports = { raw, withRetry, getJSON, getText, getBuffer, postJSON, sleep, BROWSER_UA, browserHeaders };
