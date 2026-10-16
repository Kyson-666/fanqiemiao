# 番茄喵 Web · 自托管小说下载器

> 本项目是对 Rust 内核 [`zhongbai2333/Tomato-Novel-Downloader`](https://github.com/zhongbai2333/Tomato-Novel-Downloader)
> 的 **Web 封装**：番茄小说的搜索 / 详情 / 下载由该内核提供，本版在此基础上补齐七猫小说、榜单与网页界面，
> 并打包为 **可一键 Docker 部署的单容器服务**。

<p align="center">
  <code>番茄小说</code> · <code>七猫小说</code> · <code>Docker 一键部署</code> · <code>零 npm 运行时依赖</code>
</p>

> ⚠️ **使用须知**：本项目仅用于技术学习与个人本地备份，**坚定支持小说正版**；
> **严禁任何形式的二次分发，严禁用于盈利或收费**。详见 [使用声明](#-使用声明请务必阅读并遵守)。

---

## ✨ 项目特性

### 数据平台
- **番茄小说**：搜索（书名 / 纯数字 ID / 书籍链接三种入口）、书籍详情、榜单、整本 TXT 下载
- **七猫小说**：搜索、详情、榜单、整本 TXT 下载（**签名 / 解密 / 解包算法纯 Node 实现**，不依赖任何外部工具）

### 榜单
- **番茄榜单**：综合热榜 / 男频 / 女频，按题材细分（阅读榜 · 新书榜），一键刷新
- **七猫榜单**：男频 / 女频 × 大热 / 新书 / 完结 / 收藏 / 更新
- 榜单首屏抓取书籍数量可配置（`RANK_TOP_N`，默认 10）

### 搜索与详情
- 搜索支持 **书名、纯数字 ID、官网书籍链接** 直达
- 详情页展示：封面、书名（含**曾用名纠正**）、作者、评分、字数、在读人数、章节数、分类、标签、简介
- 自动识别番茄官网的**字体混淆**（私用区字符）并过滤无效分类

### 下载
- 整本导出 **TXT**，文件名规范为 `书名 作者 [ID].txt`
- **下载管理页**：实时进度（`已下载 N 章` / `N/M 章（xx%）`）、任务取消、完成后一键下载到本地
- 内核产物先落 **暂存目录**，成品再搬运到持久化目录，**不污染下载目录**（封面等中间文件隔离在 `/data`）

### 文件库
- 浏览已下载的全部小说（**磁盘为真源**，与索引自动合并）
- 单个文件直接下载、删除（删除前二次确认）
- 显示文件大小与下载时间

### 设置
- 内核状态与版本、可执行文件路径
- 当前下载目录（由卷映射决定）
- **运行日志**：预览最近 150 行、一键下载完整日志（封面 / 搜索 / 下载事件均已持久化）
- **最近查看**历史（搜索 / 书籍）与一键清空

### 部署与运维
- **单容器**：Node 服务 + 内核二进制 + 前端一体化，`docker compose up -d --build` 即完成部署
- **零 npm 运行时依赖**：只用 Node 内置模块（`http`/`crypto`/`zlib`/`child_process`/`fs`），无 `node_modules`、无构建步骤
- **文件持久化**：`/downloads` 卷可映射到服务器任意路径；`/data` 卷保存内核配置、日志、库索引、历史
- **运行日志持久化**：封面 / 搜索 / 下载等运行事件追加写入 `/data/logs/app.log`（5MB 自动轮转），设置页可预览与下载，便于排查问题
- **访问口令**：设置 `WEB_PASSWORD` 即开启（公网暴露必备）
- **前端零依赖**：原生 HTML/CSS/JS 单页应用，Hash 路由，无需打包工具
- **优雅降级**：内核不可用时，七猫与番茄榜单仍可正常使用，并在顶部给出明确状态提示
- **架构自适应**：镜像按 `TARGETARCH` 自动下载对应架构的 Linux 内核（amd64 / arm64）
- **国内网络友好**：内核下载支持镜像加速前缀（默认 `ghfast.top`，可配置）

### 安全
- 封面统一经 `/api/cover` 代理，规避浏览器跨域与混合内容问题
- 文件读写路径做目录穿越校验，文件名白名单过滤
- 容器内内核仅监听 `127.0.0.1:18423`，不对外暴露

---

## 🚀 快速开始

### 方式一：最简部署（复制即用）

新建一个 `docker-compose.yml`，把**口令**和**保存路径**改成自己的，然后 `docker compose up -d`：

```yaml
services:
  fanqiemiao:
    image: kyson666/fanqiemiao:latest    # 也可用 ghcr.io/hanyuestar/fanqiemiao:latest
    container_name: fanqiemiao
    ports:
      - "8107:8080"                      # 冒号左边是宿主机端口，可改成任意未被占用的端口
    environment:
      WEB_PASSWORD: 请改成足够长的口令      # 留空=不校验；公网暴露务必设置
    volumes:
      - /volume1/docker/fanqiemiao/data:/data           # 数据：内核配置/日志、库索引、历史
      - /volume1/docker/fanqiemiao/download:/downloads  # ★ 小说成品保存到这里
    restart: unless-stopped
```

浏览器打开 `http://<服务器IP>:8107`，输入上面设置的口令即可。

> 只需改两处：`WEB_PASSWORD`（口令）与两个卷的**冒号左边**（宿主机目录）。
> 卷的冒号右边（`/data`、`/downloads`）是容器内路径，**不要改**。

### 方式二：使用仓库自带的 compose

```bash
git clone https://github.com/hanyuestar/fanqiemiao.git
cd fanqiemiao
cp .env.example .env        # 按需修改：端口 / 口令 / 持久化目录
docker compose up -d        # 直接拉取已发布的多架构镜像（amd64 / arm64）
```

浏览器访问：`http://<服务器IP>:8080`

> **从源码本地构建**（可选；构建时会联网下载内核二进制，耗时更长）：
> ```bash
> docker compose up -d --build
> ```
>
> **切换镜像源 / 版本**：
> ```bash
> IMAGE=kyson666/fanqiemiao docker compose up -d   # 改用 Docker Hub
> TAG=v1.0.3 docker compose up -d                  # 指定版本标签
> ```

### 方式三：docker run

```bash
docker run -d \
  --name fanqiemiao \
  -p 8107:8080 \
  -e WEB_PASSWORD=你的口令 \
  -v /volume1/docker/fanqiemiao/data:/data \
  -v /volume1/docker/fanqiemiao/download:/downloads \
  --restart unless-stopped \
  kyson666/fanqiemiao:latest
# 或 ghcr.io/hanyuestar/fanqiemiao:latest
```

> 镜像为多架构（linux/amd64、linux/arm64），`docker pull` 会自动选择匹配的架构。

### 方式四：本地开发（不使用 Docker）

```bash
# 需要一份可运行的番茄内核二进制（Linux / macOS / Windows 均可）
export KERNEL_BIN=/path/to/TomatoNovelDownloader
export DATA_DIR=./data
export DOWNLOAD_DIR=./downloads
node server/index.js
```

---

## 💾 文件持久化

| 容器路径 | 内容 | 宿主机默认 | 说明 |
|---|---|---|---|
| `/downloads` | **小说成品 TXT** | `./downloads` | 用 `DOWNLOAD_HOST_DIR` 指定为服务器任意路径 |
| `/data` | 内核配置/日志、库索引、历史、暂存 | `./data` | 用 `DATA_HOST_DIR` 指定 |

在 `.env` 中修改即可：

```ini
DOWNLOAD_HOST_DIR=/srv/novels          # 小说落到这里
DATA_HOST_DIR=/srv/fanqiemiao-data
WEB_PASSWORD=change-me
WEB_PORT=8080
```

---

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 对外监听端口 |
| `WEB_PASSWORD` | 空 | 非空则开启访问口令 |
| `DOWNLOAD_DIR` | `/downloads` | 容器内小说成品目录 |
| `DATA_DIR` | `/data` | 容器内数据目录 |
| `KERNEL_BIN` | `/app/kernel/TomatoNovelDownloader` | 内核可执行文件路径 |
| `KERNEL_PORT` | `18423` | 内核内部监听端口（仅本机） |
| `TOMATO_KERNEL_VERSION` | `v2.4.15` | 内核版本（展示用） |
| `RANK_TOP_N` | `10` | 榜单首屏书籍数量 |
| `REQUEST_TIMEOUT` | `30000` | 出网请求超时（毫秒） |

构建参数：`KERNEL_VERSION`（默认 `v2.4.15`）、`KERNEL_MIRROR`（默认 `https://ghfast.top/`，置空则直连 GitHub）。

---

## 🧱 技术架构

```
        ┌────────────────────────────────────────────────┐
        │                单容器（node:20-slim）           │
        │                                                 │
浏览器 ─┼─:8080─► Node 服务（公开端口）                   │
        │          ├─ /api/rank*    榜单（番茄/七猫）      │
        │          ├─ /api/search   搜索（番茄/七猫）      │
        │          ├─ /api/book     详情                  │
        │          ├─ /api/download 创建下载任务           │
        │          ├─ /api/tasks    任务进度 / 取消        │
        │          ├─ /api/library  文件库 / 删除          │
        │          ├─ /api/file     文件下载               │
        │          ├─ /api/cover    封面代理               │
        │          └─ /api/logs     运行日志（预览/下载）  │
        │                 │ 内部 127.0.0.1:18423           │
        │          ┌──────▼───────────────────┐            │
        │          │ 番茄内核（Rust，子进程）   │            │
        │          └──────────────────────────┘            │
        └───────────────┬───────────────┬─────────────────┘
                        │               │
                  /data 卷         /downloads 卷
```

- **番茄**：搜索 / 详情 / 下载经上游 Rust 内核（`Tomato-Novel-Downloader`）的本地 REST 接口；榜单直接抓取 `fanqienovel.com` 官网页面
- **七猫**：全部逻辑纯 Node 实现 —— 签名（MD5 + 稳定哈希选 app-version）、AES-128-CBC 解密、ZIP 解包、TXT 写出
- **内核**：以子进程方式启动（`--server --data-dir`），带健康探测与失败自动重启

---

## 📁 目录结构

```
fanqiemiao/
├── server/               # Node 后端（零 npm 运行时依赖）
│   ├── index.js          # HTTP 服务 + 路由 + 静态资源
│   ├── config.js         # 环境变量配置
│   ├── http.js           # 统一 HTTP 客户端
│   ├── kernel.js         # 内核子进程管理 + 健康检查
│   ├── fanqie.js         # 番茄：内核 REST + 榜单抓取 + 产物搬运
│   ├── qimao.js          # 七猫：搜索/详情/榜单/下载
│   ├── qimao-sign.js     # 七猫签名（MD5）
│   ├── qimao-crypto.js   # 七猫 AES-128-CBC + ZIP 读写
│   ├── writers.js        # TXT / EPUB 写出
│   ├── store.js          # 库索引 / 历史 / 设置持久化
│   ├── logger.js         # 运行日志（持久化到 /data/logs）
│   └── tasks.js          # 下载任务队列
├── public/               # 前端 SPA（原生 HTML/CSS/JS）
├── test/                 # 自检与冒烟测试
├── docs/design.md        # 架构与实现说明
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 🔌 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 内核状态 + 配置 |
| GET | `/api/rank/groups` | 番茄榜单分类 |
| GET | `/api/rank?url=&force=` | 番茄榜单书籍 |
| GET | `/api/rank/qimao?isGirl=&rankType=` | 七猫榜单 |
| GET | `/api/search?q=&platform=` | 搜索（`fanqie` / `qimao`） |
| GET | `/api/book?platform=&id=` | 书籍详情 |
| POST | `/api/download` | 建下载任务 `{platform,bookID,title,author,range?}` |
| GET | `/api/tasks` · `/api/tasks/:id` | 任务列表 / 单任务 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| GET | `/api/library` · DELETE `/api/library?file=` | 文件库 / 删除文件 |
| GET | `/api/file?name=` | 下载文件 |
| GET | `/api/cover?url=` | 封面代理 |
| GET | `/api/logs?lines=` | 运行日志尾部（封面/搜索/下载事件） |
| GET | `/api/logs/download?file=` | 下载日志文件（`app.log` / `app.log.1`） |
| GET/POST | `/api/history` · `/api/history/clear` | 最近查看 |
| GET/POST | `/api/settings` | 设置 |

---

## ✅ 测试

```bash
# 单元自检：签名 / AES / ZIP / uuid5 / 写出 / 封面转换（12 项）
npm run selftest

# 端到端冒烟：需服务已启动（榜单/搜索/详情/下载/文件库/设置 全链路）
npm run smoke
```

冒烟测试覆盖：内核状态、番茄榜单分类与榜单书籍、七猫榜单、番茄/七猫搜索、番茄/七猫详情、
番茄/七猫下载（含进度轮询与落盘校验）、任务列表与取消、文件库列表/下载/删除、封面代理、历史、设置、访问口令鉴权、运行日志预览与下载。

---

## ⚠️ 依赖与注意事项

- **内核依赖**：番茄小说的搜索 / 详情 / 下载由 Rust 内核 `zhongbai2333/Tomato-Novel-Downloader` 提供
  （镜像构建时自动下载对应架构的 Linux 预编译二进制，并以内网子进程方式运行）。该内核的第三方正文 API
  地址池**未开源**，上游接口若变更可能导致番茄下载暂时失效 —— 可通过重新构建升级内核版本（`KERNEL_VERSION`）应对。
- **不含功能**：「短剧 IP 命中」需要浏览器登录态与系统钥匙串，本项目**不含该功能**。
- **安全建议**：公网暴露务必设置 `WEB_PASSWORD`，并建议置于反向代理 / HTTPS 之后。

---

## 📜 使用声明（请务必阅读并遵守）

- ✅ **支持小说正版**：本项目**坚定支持小说正版化**。所有作品的著作权归原作者与版权方所有，
  请通过官方渠道**购买、订阅或阅读正版**。本工具产出的一切文件**仅供个人学习、研究与本地备份**，
  请在下载后 **24 小时内自行删除**，不得以任何形式替代正版阅读。
- 🚫 **绝对禁止二次分发**：**严禁**将本项目下载的任何小说内容以任何形式
  （网盘、论坛、社群、站点、打包分享、再发布等）**转载、传播或分发**。
- 🚫 **绝对禁止盈利收费**：**严禁**将本项目（含其修改版、衍生版）用于**任何商业或盈利目的**，
  包括但不限于**售卖、付费下载、会员收费、广告变现、代下载收费**，以及以本项目为基础提供任何形式的**收费服务**。
- 🎯 **用途限定**：本项目仅用于 **Rust / Node 网络爬虫技术与数据处理的学习研究**。
- ⚖️ **责任自负**：使用者须自行确保其行为符合当地法律法规及目标网站的使用条款；
  因使用本项目所产生的一切法律责任与风险由使用者**自行承担**，项目作者及贡献者**不承担任何责任**。
- 若相关权利人认为本项目不妥，请联系作者，我们将及时处理。

---

## 📄 许可

本项目保留所有权利（All Rights Reserved）。**未经明确授权，不得将本项目用于商业用途，亦不得二次分发。**
如需合作或授权，请联系作者。
