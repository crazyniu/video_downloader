# 快手与 YouTube 下载逻辑

研究与集成日期：2026-10-30（Asia/Taipei）。

## 快手

参考 [JoeanAmier/KS-Downloader](https://github.com/JoeanAmier/KS-Downloader)，核对源码 revision `b8ecf66d46358c013df1637d46d0194a42d525e3`：

- [HTML / API 提取](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/extract/extractor.py)：从 `__APOLLO_STATE__.defaultClient['VisionVideoDetailPhoto:<id>']` 读取 `photoUrl`，从 `currentWork.mp4Url` 提取 API 视频地址。
- [作品 API](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/request/detail.py)：`live_api/profile/feedbyid` 的 `photoId` / `principalId` 与 `data.currentWork`。
- [链接识别](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/link/examiner.py)：`short-video`、`fw/photo`、短链接跳转后的作品 ID。

`extension/kuaishou.js` 将上述提取流程改写为浏览器脚本，观察当前页面的详情响应，按 ID 匹配作品；缺少缓存时请求 `visionVideoDetail`。下载交给扩展现有分段下载器。作品地址来自平台详情，不能据此称为作者上传原文件。

该模块改编自 GPL-3.0 项目，保留完整许可于 `licenses/KS-Downloader-GPL-3.0.txt`。分发包含该模块的衍生插件时应按 GPL-3.0 提供对应源码与许可。原项目作者署名：JoeanAmier / KS-Downloader。

## YouTube

参考 [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp)，版本 `2026.10.26`：

- [YouTube 提取器](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/youtube/_video.py)：player response、`formats` / `adaptiveFormats`、`signatureCipher`、音视频格式信息。
- [HTTP 下载器](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/downloader/http.py)：按字节范围读取媒体文件的流程参考。
- [FFmpeg 处理](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/postprocessor/ffmpeg.py)：独立视频/音频需要合并成可播放文件；扩展使用本地打包的 FFmpeg WASM。
- [EJS 说明](https://github.com/yt-dlp/yt-dlp/wiki/EJS)：完整 yt-dlp 使用外部 JS 运行时解决 YouTube 签名挑战。

`extension/youtube.js` 移植播放器格式提取和选档流程，并按当前视频 ID 匹配，保留画质、码率、大小、音轨和 itag。直接 URL 可立即加入媒体库；密签格式由已播放页面产生有效 URL，扩展观察该请求并对应到格式。默认选择解析到的最高画面规格。下载器按段读取，分轨交由 FFmpeg WASM 合并。

这是纯 Chrome 扩展适配，未包含完整 yt-dlp 引擎，也未移植其动态 JS 签名解释器。密签画质通常需要先播放再扫描；SABR/UMP、DRM、未获访问权限或平台接口变化可能无法下载。不存在第三方解析服务器、Python 安装、本机服务或 Cookie 导出步骤。

yt-dlp 源代码使用 Unlicense，保留完整许可于 `licenses/yt-dlp-Unlicense.txt`。FFmpeg WASM 及其依赖许可由扩展 vendor 目录与对应集成文档记录。
