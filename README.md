# 大懒虫 · 视频下载器

一个 Chrome 扩展（Manifest V3），用来解析和下载网页视频：支持抖音、快手，以及其他网页里播放的 MP4 / HLS 视频。

- 不使用第三方解析服务器，所有解析在你自己的浏览器里完成，复用浏览器的登录状态
- 无需安装 Python、本机服务或命令行工具，加载即可使用

## 功能

**工具栏弹窗**

- 列出所有网页累计监听到的视频，工具栏图标上的数字即视频数量
- 同一作品只显示一行，自动选最大的文件（抖音即原画），可预览、复制地址或下载
- 支持多选下载、全部下载和清空；下载中显示进度，完成后显示勾
- 打开抖音 / 快手作品页时自动解析当前作品，无需手动点击

**批量下载页（批量下载 · 设置）**

- 批量解析：每行粘贴一个抖音链接或分享文案，自动识别、依次解析；成功的视频自动勾选，直接「下载所选」或「全部下载」
- 只列出在本页解析的作品（网页中监听到的视频在工具栏弹窗查看）；同一作品多个画质可切换，支持搜索、预览、复制地址，行内显示下载进度
- 链接失效备用方案：平台地址过期导致下载失败时，自动按来源网页重新解析并重新下载；预览失败可一键按来源重新解析
- 设置：下载方式（自动 / 多线程）与每个文件的线程数

**下载**

- 普通 MP4 交给 Chrome 下载；HLS、分轨视频、blob 媒体由扩展下载，分轨用本地打包的 FFmpeg WASM 自动合并音视频
- 可选分段多线程下载；同时下载 2 个文件

## 安装

1. 下载本仓库（`Code → Download ZIP` 或 `git clone`）
2. 打开 `chrome://extensions`，开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择仓库里的 **`extension`** 文件夹

更新时拉取最新代码，在扩展页点「重新加载」，再刷新已打开的视频网页。

要求 Chrome 116 或更高版本。

## 打包 CRX

GitHub Actions 的「Pack CRX」工作流会把 `extension/` 打包成签名的 `.crx` 和同内容的 `.zip`：

- 推送到 `main`（改动了扩展）或在 Actions 页手动运行：在该次运行的 Artifacts 里下载
- 推送 `v1.5.1` 这样的标签（须与 `manifest.json` 的版本一致）：同时发布到 Releases

签名私钥放在仓库 Secret `CRX_PRIVATE_KEY`，扩展 ID 由它决定，请固定使用同一把并妥善备份。没有设置时每次构建用临时私钥，ID 会变。生成私钥：

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out dalanchong.pem
gh secret set CRX_PRIVATE_KEY < dalanchong.pem
```

本地打包：`scripts/pack.sh dalanchong.pem`，输出到 `dist/`（需要本机 Chrome，可用 `CHROME=/path/to/chrome` 指定）。

Windows / macOS 版 Chrome 只允许安装 Chrome 应用商店的 CRX，自行打包的 CRX 需要通过企业策略（`ExtensionInstallForcelist`）分发；个人使用请解压 `.zip` 后按上面的步骤「加载已解压的扩展程序」。

## 使用

1. 打开视频网页并播放，点击工具栏的大懒虫图标即可看到监听到的视频；在抖音 / 快手作品页打开时会自动解析当前作品
2. 需要批量下载抖音作品时点弹窗右上角的「批量下载」，把链接逐行粘贴到输入框

无法解析时：打开来源网页，完成登录或验证并播放视频后再试。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `webRequest`、`<all_urls>` | 识别网页正在加载的视频地址与文件大小 |
| `scripting`、`activeTab`、`tabs` | 在作品页读取平台详情、重新扫描网页视频、打开来源网页 |
| `downloads` | 保存文件到 Chrome 下载目录 |
| `offscreen` | 在后台分段下载与合并音视频 |
| `storage` | 保存设置与本次会话的视频记录 |

扩展不收集、不上传任何数据。视频记录只保存在本次浏览器会话中。

## 限制

- 抖音「原片」是 `ratio=default` 接口返回的候选地址，未与作者上传的源文件做比对
- 平台签名、登录、风控或接口变化可能导致解析失败
- 不支持 YouTube、DRM 加密内容和直播录制
- 分轨或 blob 视频下载时请保留来源标签页

## 目录结构

```
extension/
├── manifest.json
├── popup.*           工具栏弹窗
├── manager.*         批量下载页
├── player.*          视频预览弹框
├── ui.js / theme.css 共用组件与样式
├── background.js     解析调度、失效重新解析
├── library.js        视频记录与下载队列
├── offscreen.js      分段下载、FFmpeg 合并
├── resolve.js        链接识别与解析
├── capture.js / bridge.js  网页媒体捕获
├── page.js / kuaishou.js  平台详情解析
├── vendor/           本地打包的 Web Awesome、Lucide、hls.js、FFmpeg WASM
└── licenses/         第三方许可
scripts/pack.sh       打包 CRX 与 ZIP
.github/workflows/    打包工作流
```

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

本项目以 [GNU GPL v3](LICENSE) 发布。快手模块改编自 GPL-3.0 项目 [KS-Downloader](https://github.com/JoeanAmier/KS-Downloader)，其余第三方来源与许可见 [extension/THIRD_PARTY_NOTICES.md](extension/THIRD_PARTY_NOTICES.md) 和 [extension/PLATFORM_SOURCES.md](extension/PLATFORM_SOURCES.md)。

请仅下载你有权保存的内容，并遵守各平台的服务条款与当地法律。
