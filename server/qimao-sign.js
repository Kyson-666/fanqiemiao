'use strict';

/**
 * 七猫签名 / 请求头 / 工具 —— 逐函数照搬 macOS 版 `Core/Qimao/QimaoSign.swift`
 * （其源头为 `qimao/qimao.go`）。**签名算法禁改**：SignKey、排序拼接、md5 hex 全部原样。
 */
const crypto = require('crypto');

/** qimao.go:29 SignKey */
const SIGN_KEY = 'd3dGiJc651gSQ8w1';

/** qimao.go:36-44 versions（21 个 app-version，按 stableHash 取模选） */
const VERSIONS = [
  '73720', '73700', '73620', '73600', '73500', '73420', '73400',
  '73328', '73325', '73320', '73300', '73220', '73200', '73100',
  '73000', '72900', '72820', '72800', '70720', '62010', '62112',
];

/** sorted keys 的 "k=v" 拼接 + SIGN_KEY，md5 hex（小写） */
function sign(params) {
  let joined = '';
  for (const key of Object.keys(params).sort()) {
    joined += key + '=' + (params[key] ?? '');
  }
  return crypto.createHash('md5').update(joined + SIGN_KEY, 'utf8').digest('hex');
}

/** 模拟 Dart `string.hashCode`（确定性 signed 32-bit），按码点累加 */
function stableHash(s) {
  let h = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    h = (Math.imul(h, 31) + cp) >>> 0; // 32 位无符号回绕
  }
  return h | 0; // 转 signed 32-bit
}

/** 8 个固定头 + 按书号选 app-version + sign，最后加 UA（UA 不参与签名） */
function requestHeaders(bookID = '') {
  let h = 0;
  if (bookID) h = stableHash(bookID);
  const idx = Math.abs(h) % VERSIONS.length;

  const headers = {
    AUTHORIZATION: '',
    'app-version': VERSIONS[idx],
    'application-id': 'com.****.reader',
    channel: 'unknown',
    'net-env': '1',
    platform: 'android',
    'qm-params': '',
    reg: '0',
  };
  headers.sign = sign(headers);
  headers['User-Agent'] =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  return headers;
}

/** 链接 → 裸数字 ID；纯数字原样；否则原样返回 */
function extractBookID(raw) {
  const s = String(raw || '').trim();
  for (const pattern of [/qimao\.com\/shuku\/(\d+)/, /wtzw\.com\/article-detail\/(\d+)/]) {
    const m = s.match(pattern);
    if (m) return m[1];
  }
  if (/^\d+$/.test(s)) return s;
  return s;
}

/** 去掉 [<>:"/\|?*]，trim ". "，空则 "book" */
function safeFilename(name) {
  let s = String(name).replace(/[<>:"/\\|?*]/g, '');
  s = s.replace(/^[. ]+|[. ]+$/g, '');
  return s || 'book';
}

/** 去掉 <...> */
function stripHTML(s) {
  return String(s).replace(/<[^>]*>/g, '');
}

/**
 * Go `url.Values.Encode()` 的等价物：key 排序、`+` 表示空格、其余按 RFC3986 转义
 * （保留 `A-Za-z0-9-_.~`）。七猫的 sign 对解码后的键值计算，这里只需生成同样的查询串。
 */
function queryEncode(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${escapeRFC3986(key)}=${escapeRFC3986(params[key] ?? '')}`)
    .join('&');
}

function escapeRFC3986(s) {
  let out = '';
  for (const byte of Buffer.from(String(s), 'utf8')) {
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || byte === 0x5f || byte === 0x2e || byte === 0x7e // - _ . ~
    ) {
      out += String.fromCharCode(byte);
    } else if (byte === 0x20) {
      out += '+';
    } else {
      out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

module.exports = {
  SIGN_KEY,
  VERSIONS,
  sign,
  stableHash,
  requestHeaders,
  extractBookID,
  safeFilename,
  stripHTML,
  queryEncode,
  escapeRFC3986,
};
