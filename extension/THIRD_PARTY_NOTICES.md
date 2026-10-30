# 第三方来源

## 原片探测参考

jiji262/douyin-downloader，核对 revision ed863617aa52353821aca8fdebcfad4e916ebff5。
https://github.com/jiji262/douyin-downloader

原片请求参数与浏览器详情解析由本插件实现。上游 MIT 许可见 licenses/douyin-downloader-MIT.txt。该公开仓库只有抖音 CLI；不包含 README 展示的其他平台桌面版完整实现。

## 快手与 YouTube

快手模块参考 JoeanAmier/KS-Downloader，revision b8ecf66d46358c013df1637d46d0194a42d525e3，GPL-3.0。
https://github.com/JoeanAmier/KS-Downloader
许可：licenses/KS-Downloader-GPL-3.0.txt。

YouTube 模块参考 yt-dlp 2026.10.26 的 player response 格式解析与实际播放地址处理，Unlicense。
https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
许可：licenses/yt-dlp-Unlicense.txt。

模块实现与范围详见 PLATFORM_SOURCES.md。YouTube 仅改写播放器格式解析与已播放签名地址观察，不包含完整 yt-dlp Python 引擎。

## 浏览器内封装

@ffmpeg/ffmpeg 0.12.15，MIT。
@ffmpeg/core 0.12.10，GPL-2.0-or-later，单线程 WASM 内核。
https://github.com/ffmpegwasm/ffmpeg.wasm
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/core
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/build

JavaScript 与 WASM 随插件本地打包；不在运行时从 CDN 下载执行代码。
许可见 licenses/ffmpeg-wasm-MIT.txt 和 licenses/FFmpeg-GPL-2.0.txt。

本分发包包含插件完整 JavaScript、HTML、CSS 源码；包含 GPL-3.0 改编模块，按 GNU GPL v3 分发。完整许可见 licenses/KS-Downloader-GPL-3.0.txt。

## 界面组件

Web Awesome 3.14.0（MIT）、Lucide 图标 0.468.0（ISC）、hls.js 1.7.4（Apache-2.0），均已本地打包到 `vendor/`。
许可见 licenses/Web-Awesome-LICENSE.txt、licenses/Lucide-LICENSE.txt、licenses/hls.js-LICENSE.txt。
