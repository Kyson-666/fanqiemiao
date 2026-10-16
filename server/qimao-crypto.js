'use strict';

/**
 * 七猫解密与下载包解包 —— 对照 macOS 版 `Core/Qimao/QimaoCrypto.swift` + `QimaoZip.swift`。
 *   - AES-128-CBC：base64 → 前 16 字节 IV + 密文，手动去 PKCS7 填充，失败返回原文
 *   - ZIP 读：自解析中央目录 + raw deflate（Node `zlib.inflateRawSync`）
 *   - ZIP 写：EPUB 需要（mimetype 必须第一个且 STORED）
 */
const crypto = require('crypto');
const zlib = require('zlib');

/** qimao.go:31 AESKeyHex → 16 字节 ASCII 密钥 */
const AES_KEY_HEX = '32343263636238323330643730396531';
const AES_KEY = Buffer.from(AES_KEY_HEX, 'hex'); // 16 bytes

/**
 * AES-128-CBC 解密（PKCS7 手动去填充）。失败返回原文。
 */
function decrypt(text) {
  let raw;
  try {
    raw = Buffer.from(text, 'base64');
  } catch {
    return text;
  }
  if (raw.length < 16 || (raw.length - 16) % 16 !== 0) return text;
  const iv = raw.subarray(0, 16);
  const cipher = raw.subarray(16);
  if (cipher.length === 0) return text;

  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, iv);
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  } catch {
    return text;
  }

  // 手动去 PKCS7
  if (plain.length > 0) {
    const pad = plain[plain.length - 1];
    if (pad >= 1 && pad <= 16 && pad <= plain.length) {
      plain = plain.subarray(0, plain.length - pad);
    }
  }
  return plain.toString('utf8');
}

// ─────────────────────────────── ZIP 读 ───────────────────────────────

/**
 * 解析 zip → 条目列表（已解压）。支持 method 0（STORED）与 8（DEFLATE）。
 */
function readZip(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const eocd = findEOCD(bytes);
  if (eocd < 0) throw new Error('压缩包解析失败（找不到 EOCD）');
  const count = bytes.readUInt16LE(eocd + 10);
  const cdOffset = bytes.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`压缩包解析失败（中央目录条目签名不对 @${p}）`);
    }
    const method = bytes.readUInt16LE(p + 10);
    const compSize = bytes.readUInt32LE(p + 20);
    const rawSize = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录

    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`压缩包解析失败（本地头签名不对 @${localOffset}）`);
    }
    const lNameLen = bytes.readUInt16LE(localOffset + 26);
    const lExtraLen = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const end = start + compSize;
    if (end > bytes.length) throw new Error(`压缩包解析失败（条目数据越界 ${name}）`);

    const raw = bytes.subarray(start, end);
    let payload;
    if (method === 0) payload = raw;
    else if (method === 8) {
      try {
        payload = zlib.inflateRawSync(raw);
      } catch (err) {
        throw new Error(`deflate 解压失败 ${name}: ${err.message}`);
      }
    } else {
      throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    }
    entries.push({ name, data: payload });
  }
  return entries;
}

function findEOCD(bytes) {
  if (bytes.length < 22) return -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 解压并解密：文件名去扩展名 = 章节 ID → 明文。
 */
function unzipChapters(zipBytes) {
  const map = {};
  for (const entry of readZip(zipBytes)) {
    const chapterID = entry.name.endsWith('.txt') ? entry.name.slice(0, -4) : entry.name;
    map[chapterID] = decrypt(entry.data.toString('utf8'));
  }
  return map;
}

// ─────────────────────────────── ZIP 写（EPUB 用） ───────────────────────────────

const CRC_TABLE = (() => {
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 打 zip。entries: [{ name, data:Buffer, stored?:bool }]，stored=true 的条目原样存。
 */
function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    let payload;
    let method;
    if (entry.stored) {
      payload = entry.data;
      method = 0;
    } else {
      payload = zlib.deflateRawSync(entry.data);
      method = 8;
    }
    const localOffset = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, payload);
    offset += local.length + nameBuf.length + payload.length;

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(localOffset, 42);
    central.push(cen, nameBuf);
  }

  const centralBuf = Buffer.concat(central);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** SHA-1 版 UUID v5（URL 命名空间），与 Python uuid5 一致 */
function uuid5URL(name) {
  const namespace = Buffer.from([
    0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1,
    0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
  ]);
  const hash = crypto.createHash('sha1').update(Buffer.concat([namespace, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { decrypt, readZip, unzipChapters, writeZip, crc32, uuid5URL, AES_KEY };
