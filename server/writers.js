'use strict';

/**
 * 七猫输出写入器：TXT（单文件）+ 中文 EPUB 2.0。
 * 逐函数照搬 macOS 版 `Core/Qimao/QimaoWriters.swift`（源头 `qimao/writers.go`）。
 */
const fs = require('fs');
const http = require('./http');
const crypt = require('./qimao-crypto');

/** Go `len(string)` 是字节数（中文 3 字节/字），分隔线长度照搬字节数（上限 40） */
function rule(title) {
  return '─'.repeat(Math.min(Buffer.byteLength(title, 'utf8'), 40));
}

/** writers.go:24 WriteSingleTxt */
function writeSingleTxt(book, chapters, filePath) {
  let sb = '';
  sb += '标题: ' + book.title + '\n';
  sb += '作者: ' + book.author + '\n\n';
  sb += '简介:\n' + book.description + '\n\n';
  sb += '='.repeat(40) + '\n\n';
  for (const oc of chapters) {
    sb += oc.chapter.title + '\n';
    sb += rule(oc.chapter.title) + '\n';
    sb += oc.content + '\n\n';
  }
  fs.writeFileSync(filePath, sb, 'utf8');
}

/** writers.go:233 xmlEscape（& 先换，避免二次转义） */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;')
    .replace(/"/g, '&quot;');
}

/** writers.go:56 WriteEpub（结构照搬：mimetype → container.xml → content.opf → toc.ncx → cover → css → chapters） */
async function writeEpub(book, chapters, filePath) {
  const uid = crypt.uuid5URL('qimao://' + book.bookID);
  const safeTitle = xmlEscape(book.title);
  const safeAuthor = xmlEscape(book.author);
  const safeIntro = xmlEscape(book.description);
  const safeTags = xmlEscape(book.tags || '');

  const entries = chapters.map((oc, i) => ({
    idx: i + 1,
    title: xmlEscape(oc.chapter.title),
    body: xmlEscape(oc.content).replace(/\n/g, '<br/>\n'),
  }));

  const files = [];
  const add = (name, content) => files.push({ name, data: Buffer.from(content, 'utf8') });

  // 1. mimetype —— 必须第一个且 STORED
  files.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'utf8'), stored: true });

  // 2. container.xml
  add(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );

  const manifest = [
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="css" href="style.css" media-type="text/css"/>`,
  ];
  const spine = [`<itemref idref="cover"/>`];
  for (const e of entries) {
    const fid = 'ch' + String(e.idx).padStart(4, '0');
    manifest.push(`<item id="${fid}" href="chapter-${String(e.idx).padStart(4, '0')}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${fid}"/>`);
  }

  // 封面图（拿不到就跳过）
  if (book.coverURL) {
    try {
      const buf = await http.getBuffer(book.coverURL, { timeout: 15000, headers: { 'User-Agent': http.BROWSER_UA } });
      files.push({ name: 'OEBPS/cover.jpg', data: buf });
      manifest.unshift(`<item id="cover-img" href="cover.jpg" media-type="image/jpeg"/>`);
    } catch {
      /* 忽略 */
    }
  }

  add(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookid">${uid}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>
    <dc:creator opf:role="aut">${safeAuthor}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:description>${safeIntro}</dc:description>
    <dc:subject>${safeTags}</dc:subject>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>`
  );

  const nav = entries.map(
    (e) => `    <navPoint id="nav-${String(e.idx).padStart(4, '0')}" playOrder="${e.idx}">
      <navLabel><text>${e.title}</text></navLabel>
      <content src="chapter-${String(e.idx).padStart(4, '0')}.xhtml"/>
    </navPoint>`
  );
  add(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.dtd/mil/ncx" version="2005-1" xml:lang="zh-CN">
  <head>
    <meta name="dtb:uid" content="${uid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <docAuthor><text>${safeAuthor}</text></docAuthor>
  <navMap>
${nav.join('\n')}
  </navMap>
</ncx>`
  );

  add(
    'OEBPS/cover.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head>
<body style="text-align:center;padding:2em;">
  <h1>${safeTitle}</h1>
  <p>作者: ${safeAuthor}</p>
  <hr/><p>${safeIntro}</p>
  <p>标签: ${safeTags}</p>
</body></html>`
  );

  add(
    'OEBPS/style.css',
    'body{font-family:sans-serif;line-height:1.8;margin:1em 2em;max-width:40em}\n' +
      'h1{text-align:center;font-size:1.3em;margin:1.5em 0 1em}\n' +
      'p{text-indent:2em;margin:.3em 0}\n'
  );

  for (const e of entries) {
    add(
      `OEBPS/chapter-${String(e.idx).padStart(4, '0')}.xhtml`,
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head>
  <title>${e.title}</title>
  <link href="style.css" rel="stylesheet"/>
</head><body>
  <h1>${e.title}</h1>
  ${e.body}
</body></html>`
    );
  }

  fs.writeFileSync(filePath, crypt.writeZip(files));
}

module.exports = { writeSingleTxt, writeEpub, xmlEscape, rule };
