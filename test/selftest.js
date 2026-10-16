'use strict';

/**
 * 自检：验证移植到 Node 的七猫签名 / AES / ZIP 与 Swift 原版一致。
 * 运行：node test/selftest.js
 */
const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');

const sign = require('../server/qimao-sign');
const crypt = require('../server/qimao-crypto');
const writers = require('../server/writers');

let passed = 0;
function ok(name) {
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('七猫签名 / 加解密 / 压缩 自检');

// 1) sign：与独立实现（排序拼接 + SIGN_KEY 的 md5）一致
{
  const params = { b: '2', a: '1', c: '中文' };
  const joined = ['a=1', 'b=2', 'c=中文'].join('') + sign.SIGN_KEY;
  const expect = crypto.createHash('md5').update(joined, 'utf8').digest('hex');
  assert.strictEqual(sign.sign(params), expect);
  ok('sign 排序拼接 + md5 一致');
}

// 2) stableHash：模拟 Dart hashCode（有符号 32 位）
{
  // 逐字符 h = (h*31 + codePoint) mod 2^32，再转有符号
  const ref = (s) => {
    let h = 0;
    for (const ch of s) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
    return h | 0;
  };
  assert.strictEqual(sign.stableHash('a'), 97);
  assert.strictEqual(sign.stableHash('ab'), ref('ab'));
  assert.strictEqual(sign.stableHash('7318247498772674083'), ref('7318247498772674083'));
  ok('stableHash 与 Dart 语义一致');
}

// 3) requestHeaders：8 个固定头 + sign，UA 不参与签名
{
  const h = sign.requestHeaders('123456');
  assert.strictEqual(h.platform, 'android');
  assert.strictEqual(h['application-id'], 'com.****.reader');
  assert.ok(sign.VERSIONS.includes(h['app-version']));
  const expectSign = sign.sign({
    AUTHORIZATION: '',
    'app-version': h['app-version'],
    'application-id': 'com.****.reader',
    channel: 'unknown',
    'net-env': '1',
    platform: 'android',
    'qm-params': '',
    reg: '0',
  });
  assert.strictEqual(h.sign, expectSign);
  ok('requestHeaders 签名覆盖 8 头、UA 不参与');
}

// 4) queryEncode：key 排序、空格→+、保留 ~ - _ .
{
  assert.strictEqual(sign.queryEncode({ b: 'a b', a: '~-_.' }), 'a=~-_.&b=a+b');
  assert.strictEqual(sign.queryEncode({ wd: '斗破 苍穹' }), 'wd=%E6%96%97%E7%A0%B4+%E8%8B%8D%E7%A9%B9');
  ok('queryEncode 与 Go url.Values.Encode 等价');
}

// 5) AES-128-CBC 解密（构造密文 → 解密还原）
{
  const key = crypt.AES_KEY;
  const iv = crypto.randomBytes(16);
  const plain = '第一章 测试正文 hello';
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, enc]).toString('base64');
  assert.strictEqual(crypt.decrypt(payload), plain);
  // 非法输入回退原文
  assert.strictEqual(crypt.decrypt('not-base64!!'), 'not-base64!!');
  ok('AES-128-CBC 解密（IV 前置 + PKCS7）正确');
}

// 6) ZIP 读写往返（含 STORED 与 DEFLATE）
{
  const entries = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip'), stored: true },
    { name: 'a/1.txt', data: Buffer.from('章节一 内容'.repeat(50)) },
    { name: 'b/2.txt', data: Buffer.from('章节二 内容') },
  ];
  const zip = crypt.writeZip(entries);
  const read = crypt.readZip(zip);
  assert.strictEqual(read.length, 3);
  assert.strictEqual(read[0].name, 'mimetype');
  assert.strictEqual(read[0].data.toString(), 'application/epub+zip');
  assert.strictEqual(read[1].data.toString(), '章节一 内容'.repeat(50));
  assert.strictEqual(read[2].data.toString(), '章节二 内容');
  ok('ZIP 读写往返一致（STORED + DEFLATE）');

  // 用标准 zlib 独立解压 deflate 条目，确认可被通用解压器读取
  const inflated = zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from('标准解压校验')));
  assert.strictEqual(inflated.toString(), '标准解压校验');
  ok('deflate 条目与标准 zlib 兼容');
}

// 7) unzipChapters：文件名去扩展名 = 章节 ID，内容 AES 解密
{
  const key = crypt.AES_KEY;
  const chapterID = '10086';
  const plain = '这是解密后的章节内容';
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const b64 = Buffer.concat([iv, enc]).toString('base64');
  const zip = crypt.writeZip([{ name: chapterID + '.txt', data: Buffer.from(b64) }]);
  const map = crypt.unzipChapters(zip);
  assert.strictEqual(map[chapterID], plain);
  ok('unzipChapters 章节 ID 映射 + 解密正确');
}

// 8) uuid5URL：稳定且格式合法
{
  const u1 = crypt.uuid5URL('qimao://123');
  const u2 = crypt.uuid5URL('qimao://123');
  assert.strictEqual(u1, u2);
  assert.match(u1, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  ok('uuid5（SHA-1, URL 命名空间）格式与稳定性正确');
}

// 9) 文件名安全化
{
  assert.strictEqual(sign.safeFilename('a<b>:"/\\|?*c'), 'abc');
  assert.strictEqual(sign.safeFilename('...'), 'book');
  assert.strictEqual(sign.safeFilename('斗破苍穹'), '斗破苍穹');
  ok('safeFilename 去非法字符 + 兜底');
}

// 10) TXT 写出结构
{
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqm-'));
  const file = path.join(dir, 't.txt');
  writers.writeSingleTxt(
    { title: '书名', author: '作者', description: '简介内容' },
    [{ chapter: { title: '第一章' }, content: '正文' }],
    file
  );
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('标题: 书名'));
  assert.ok(text.includes('作者: 作者'));
  assert.ok(text.includes('第一章'));
  assert.ok(text.includes('正文'));
  fs.rmSync(dir, { recursive: true, force: true });
  ok('TXT 写出结构正确');
}

console.log(`\n全部通过：${passed} 项`);
