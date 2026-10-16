# syntax=docker/dockerfile:1

# ─────────────────────────────────────────────────────────────
# 阶段 1：拉取上游 Rust 内核（Tomato-Novel-Downloader）的 Linux 预编译二进制
#   番茄搜索/详情/下载由该内核提供；镜像内以子进程方式启动（仅监听 127.0.0.1）
# ─────────────────────────────────────────────────────────────
ARG KERNEL_VERSION=v2.4.15

FROM debian:bookworm-slim AS kernel
ARG TARGETARCH
ARG KERNEL_VERSION
# 国内加速前缀（留空则直连 GitHub）。可改为 https://ghfast.top/
ARG KERNEL_MIRROR=https://ghfast.top/

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    # 使用 musl 静态构建：官方 glibc 版要求 GLIBC_2.39，而 Debian 12(bookworm) 仅 2.36，
    # 直接运行会报 "version `GLIBC_2.39' not found"。musl 版为完全静态链接（无 PT_INTERP/DT_NEEDED），
    # 可在任意 Linux 发行版上运行，不再受基础镜像 glibc 版本约束。
    case "${TARGETARCH}" in \
      amd64) ASSET="TomatoNovelDownloader-Linux_musl_amd64-${KERNEL_VERSION}" ;; \
      arm64) ASSET="TomatoNovelDownloader-Linux_musl_arm64-${KERNEL_VERSION}" ;; \
      *) echo "不支持的架构: ${TARGETARCH}"; exit 1 ;; \
    esac; \
    URL="https://github.com/zhongbai2333/Tomato-Novel-Downloader/releases/download/${KERNEL_VERSION}/${ASSET}"; \
    mkdir -p /out; \
    echo "下载内核: ${URL}"; \
    if ! curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "${URL}" -o /out/TomatoNovelDownloader; then \
      echo "直连失败，改用镜像 ${KERNEL_MIRROR}${URL}"; \
      curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 "${KERNEL_MIRROR}${URL}" -o /out/TomatoNovelDownloader; \
    fi; \
    chmod 0755 /out/TomatoNovelDownloader; \
    SIZE=$(stat -c %s /out/TomatoNovelDownloader); \
    echo "内核大小: ${SIZE} 字节"; \
    if [ "${SIZE}" -lt 1000000 ]; then echo "下载内容异常（疑似错误页）"; exit 1; fi

# ─────────────────────────────────────────────────────────────
# 阶段 2：运行镜像（Node 服务 + 内核二进制 + 前端）
# ─────────────────────────────────────────────────────────────
# 基础镜像用 alpine（musl）：内核已是**静态 musl 构建**，不依赖 glibc，
# 因此可以安全使用 musl 发行版；相比 debian bookworm-slim 可减小约 26 MB。
FROM node:20-alpine

# 重新声明全局 ARG，才能在 ENV 中使用
ARG KERNEL_VERSION

# 内核走 HTTPS 访问上游接口，需要根证书（静态 musl 版同样读取系统 CA 目录）
RUN apk add --no-cache ca-certificates

WORKDIR /app

# 后端（零 npm 运行时依赖，无需 install）
# 注意：镜像内只包含以下三处 + 内核二进制；test/ docs/ .github/ 等一律不打包
#      （未使用 `COPY . .`，故构建上下文中的无关文件不会进入镜像）
COPY package.json ./package.json
COPY server ./server
COPY public ./public

# 内核二进制
COPY --from=kernel /out/TomatoNovelDownloader /app/kernel/TomatoNovelDownloader

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    KERNEL_BIN=/app/kernel/TomatoNovelDownloader \
    TOMATO_KERNEL_VERSION=${KERNEL_VERSION}

RUN mkdir -p /data /downloads

EXPOSE 8080

# 说明：以 root 运行以规避宿主机卷的属主/权限问题；如需非 root，可自行改 USER 并 chown 卷目录
CMD ["node", "server/index.js"]
