'use strict';

/**
 * 运行日志：把封面 / 搜索 / 下载 / 服务等运行事件追加写入 `{DATA_DIR}/logs/app.log`，
 * 容器重建后仍可追溯；同时输出到 stdout（保留 docker logs 行为）。
 *
 * 格式：`2026-10-16T07:45:12.345Z [info] [search] platform=fanqie q="斗破苍穹" items=6 elapsed=812ms`
 * 轮转：单文件超过 5MB 转为 app.log.1（仅保留一代）。
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_DIR = path.join(config.dataDir, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const ROTATED_FILE = LOG_FILE + '.1';
const MAX_BYTES = 5 * 1024 * 1024;

function write(level, scope, message) {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (fs.statSync(LOG_FILE).size >= MAX_BYTES) {
        fs.rmSync(ROTATED_FILE, { force: true });
        fs.renameSync(LOG_FILE, ROTATED_FILE);
      }
    } catch {
      /* 日志文件尚不存在 */
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* 磁盘不可写等：不影响主流程 */
  }
  const prefix = `[fanqiemiao-web] [${scope}]`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
}

/** 读取日志尾部若干行（文件 ≤5MB，直接整读切片） */
function tail(lines = 200) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8');
    return text.split('\n').filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function fileInfo() {
  try {
    const st = fs.statSync(LOG_FILE);
    return { file: LOG_FILE, exists: true, size: st.size, mtime: st.mtimeMs };
  } catch {
    return { file: LOG_FILE, exists: false, size: 0, mtime: 0 };
  }
}

module.exports = {
  info: (scope, message) => write('info', scope, message),
  warn: (scope, message) => write('warn', scope, message),
  error: (scope, message) => write('error', scope, message),
  tail,
  fileInfo,
  dir: LOG_DIR,
  file: LOG_FILE,
};
