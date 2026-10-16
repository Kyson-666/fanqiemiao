'use strict';

/**
 * 番茄内核（Tomato-Novel-Downloader）子进程管理。
 * 对照 macOS 版 `Core/Kernel/KernelManager.swift` + `KernelProcess.swift`：
 *   - 以 `--server --data-dir <dir>` 启动，仅监听 127.0.0.1
 *   - /api/status 健康探测（冷启动最多等 60s）
 *   - 进程退出后自动重启（限流），退出时统一回收
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { getJSON } = require('./http');

const KERNEL_DEFAULT_CONFIG = [
  'old_cli: false',
  'max_workers: 3',
  'request_timeout: 15',
  'novel_format: txt',
  'bulk_files: false',
  'auto_open_downloaded_files: false',
  "save_path: ''",
  'use_official_api: true',
  'api_endpoints: []',
  '',
].join('\n');

class Kernel {
  constructor() {
    this.proc = null;
    this.phase = 'stopped'; // stopped | starting | ready | failed | missing
    this.version = null;
    this.lastError = null;
    this.startPromise = null;
    this.restarts = 0;
    this.stopping = false;
    this.startedAt = null;
  }

  get baseURL() {
    return `http://127.0.0.1:${config.kernelPort}`;
  }

  /** 内核二进制是否存在且可执行 */
  binaryAvailable() {
    try {
      fs.accessSync(config.kernelBin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** 保证内核 config.yml 把产物写到暂存目录（再由下载流水线搬运到持久化下载目录） */
  ensureConfig() {
    fs.mkdirSync(config.kernelDataDir, { recursive: true });
    fs.mkdirSync(config.stagingDir, { recursive: true });
    fs.mkdirSync(config.downloadDir, { recursive: true });
    const file = path.join(config.kernelDataDir, 'config.yml');
    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : KERNEL_DEFAULT_CONFIG;
    // 已有配置若缺少关键键（或格式损坏）→ 回退默认模板，避免把坏 YAML 喂给内核
    if (!/^save_path:/m.test(content) || !/^novel_format:/m.test(content)) {
      content = KERNEL_DEFAULT_CONFIG;
    }
    content = setYaml(content, 'save_path', config.stagingDir);
    content = setYaml(content, 'novel_format', 'txt');
    fs.writeFileSync(file, content, 'utf8');
  }

  async status(timeout = 2000) {
    const json = await getJSON(`${this.baseURL}/api/status`, { timeout });
    return {
      version: String(json.version || ''),
      saveDir: String(json.save_dir || ''),
      bindAddr: String(json.bind_addr || ''),
    };
  }

  async probe(timeout = 2000) {
    try {
      return await this.status(timeout);
    } catch {
      return null;
    }
  }

  /** 幂等启动 */
  async ensureReady() {
    if (this.phase === 'ready') {
      const s = await this.probe(2000);
      if (s) return s;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async _start() {
    if (!this.binaryAvailable()) {
      this.phase = 'missing';
      this.lastError = `未找到内核可执行文件：${config.kernelBin}`;
      throw new Error(this.lastError);
    }

    // 端口上已有可用内核 → 直接接管
    const existing = await this.probe(2000);
    if (existing) {
      this.phase = 'ready';
      this.version = existing.version;
      this.startedAt = this.startedAt || Date.now();
      return existing;
    }

    this.ensureConfig();
    this.phase = 'starting';
    this.lastError = null;

    const logFd = fs.openSync(config.kernelLog, 'a');
    const args = ['--server', '--data-dir', config.kernelDataDir];
    this.proc = spawn(config.kernelBin, args, {
      cwd: config.kernelDataDir,
      env: { ...process.env, TOMATO_WEB_ADDR: `127.0.0.1:${config.kernelPort}` },
      stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    this.startedAt = Date.now();

    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      if (this.stopping) {
        this.phase = 'stopped';
        return;
      }
      this.phase = 'failed';
      this.lastError = `内核进程退出（code=${code} signal=${signal}）`;
      // 限流自动重启：最多 3 次，每次间隔 3s
      if (this.restarts < 3) {
        this.restarts += 1;
        setTimeout(() => {
          this.ensureReady().catch(() => {});
        }, 3000);
      }
    });

    const ready = await this._waitHealthy(60000);
    if (!ready) {
      this.lastError = this.lastError || '内核启动超时（60s），详见 ' + config.kernelLog;
      this.phase = 'failed';
      this.stop();
      throw new Error(this.lastError);
    }
    this.restarts = 0;
    this.phase = 'ready';
    this.version = ready.version;
    return ready;
  }

  async _waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.probe(2000);
      if (s) return s;
      if (!this.proc) return null; // 进程已退出
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  stop() {
    this.stopping = true;
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const p = this.proc;
      setTimeout(() => {
        try {
          if (p && !p.killed) p.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 3000);
    }
    this.phase = 'stopped';
  }

  /** 给前端用的状态快照 */
  async snapshot() {
    const alive = await this.probe(1200);
    return {
      available: this.binaryAvailable(),
      phase: alive ? 'ready' : this.phase,
      version: alive ? alive.version : this.version,
      expectedVersion: config.kernelVersion,
      saveDir: alive ? alive.saveDir : config.downloadDir,
      bin: config.kernelBin,
      error: alive ? null : this.lastError,
    };
  }
}

/** 逐行替换 YAML 里的 key（不存在则追加），值统一加双引号以容纳路径等特殊字符 */
function setYaml(content, key, value) {
  const re = new RegExp(`^(${key}):.*$`, 'm');
  const quoted = `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (re.test(content)) return content.replace(re, () => `${key}: ${quoted}`);
  return content + `\n${key}: ${quoted}\n`;
}

module.exports = new Kernel();
