'use strict';

/**
 * 运行配置 —— 全部来自环境变量，未设置时给出「本地开发 / 容器内」都合理的默认值。
 * 容器内由 Dockerfile / docker-compose.yml 显式覆盖为 /data、/downloads、/app/kernel/...。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..'); // web/

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

function envInt(name, def) {
  const n = parseInt(env(name, String(def)), 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  /** 对外监听端口（浏览器访问） */
  port: envInt('PORT', 8080),
  /** 数据目录：内核 config/logs、库索引、历史、设置 */
  dataDir: env('DATA_DIR', path.join(ROOT, 'data')),
  /** 小说成品目录（持久化目标） */
  downloadDir: env('DOWNLOAD_DIR', path.join(ROOT, 'downloads')),
  /** 访问口令，非空则开启（简单 Bearer / ?token= 校验） */
  webPassword: env('WEB_PASSWORD', ''),
  /** 内核可执行文件 */
  kernelBin: env('KERNEL_BIN', path.join(ROOT, 'kernel', 'TomatoNovelDownloader')),
  /** 内核内部监听端口（仅本机） */
  kernelPort: envInt('KERNEL_PORT', 18423),
  /** 期望内核版本（仅用于展示） */
  kernelVersion: env('TOMATO_KERNEL_VERSION', 'v2.4.15'),
  /** 单次出网请求超时（ms） */
  requestTimeout: envInt('REQUEST_TIMEOUT', 30000),
  /** 榜单首屏抓取的书籍数量 */
  rankTopN: envInt('RANK_TOP_N', 10),
};

config.kernelDataDir = path.join(config.dataDir, 'kernel');
/** 内核产物暂存目录：内核预览/下载都会往 save_path 写（含封面），
 *  指向 data 目录避免污染持久化下载目录；成品 TXT 再搬运到 downloadDir。 */
config.stagingDir = path.join(config.dataDir, 'staging');
config.kernelLog = path.join(config.dataDir, 'kernel.stdout.log');
config.libraryFile = path.join(config.dataDir, 'library.json');
config.historyFile = path.join(config.dataDir, 'history.json');
config.settingsFile = path.join(config.dataDir, 'settings.json');

module.exports = config;
