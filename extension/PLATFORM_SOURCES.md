# 快手下载逻辑

研究与集成日期：2026-10-30（Asia/Taipei）。

## 快手

参考 [JoeanAmier/KS-Downloader](https://github.com/JoeanAmier/KS-Downloader)，核对源码 revision `b8ecf66d46358c013df1637d46d0194a42d525e3`：

- [HTML / API 提取](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/extract/extractor.py)：从 `__APOLLO_STATE__.defaultClient['VisionVideoDetailPhoto:<id>']` 读取 `photoUrl`，从 `currentWork.mp4Url` 提取 API 视频地址。
- [作品 API](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/request/detail.py)：`live_api/profile/feedbyid` 的 `photoId` / `principalId` 与 `data.currentWork`。
- [链接识别](https://github.com/JoeanAmier/KS-Downloader/blob/b8ecf66d46358c013df1637d46d0194a42d525e3/source/link/examiner.py)：`short-video`、`fw/photo`、短链接跳转后的作品 ID。

`extension/kuaishou.js` 将上述提取流程改写为浏览器脚本，观察当前页面的详情响应，按 ID 匹配作品；缺少缓存时请求 `visionVideoDetail`。下载交给扩展现有分段下载器。作品地址来自平台详情，不能据此称为作者上传原文件。

该模块改编自 GPL-3.0 项目，保留完整许可于 `licenses/KS-Downloader-GPL-3.0.txt`。分发包含该模块的衍生插件时应按 GPL-3.0 提供对应源码与许可。原项目作者署名：JoeanAmier / KS-Downloader。
