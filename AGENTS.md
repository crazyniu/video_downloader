# AGENTS.md

给 AI 编程助手（Claude Code、Codex 等）和贡献者的项目说明。

## 项目概况

大懒虫是一个 Chrome MV3 扩展，解析并下载抖音、快手以及普通网页里的视频（MP4 / HLS）。全部代码在 `extension/` 中，纯原生 JavaScript（ES Modules），**没有构建步骤、没有依赖安装、没有服务端**。

不支持 YouTube：分轨、签名地址问题多，已整体移除，`media-records.js` 的 `canCaptureSource` 会拒收 YouTube 页面。不要重新加入。

## 运行与调试

1. `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `extension/`
2. 修改后在扩展页点「重新加载」，并刷新已打开的视频网页（内容脚本不会自动更新）
3. 后台日志：扩展页的「Service Worker」链接；界面日志：在弹窗或工作台右键检查

检查语法：`for f in extension/*.js; do node --check "$f"; done`

打包：`scripts/pack.sh [key.pem]` 用 Chrome 的 `--pack-extension` 生成 `dist/` 下的 `.crx` 与 `.zip`；`.github/workflows/pack.yml` 在推送 `main` 和 `v*` 标签时运行，签名私钥取自 Secret `CRX_PRIVATE_KEY`（已设置，扩展 ID `ndfjcobjjekmbohcnljkponkkeloamfm`）。私钥不要提交（`.gitignore` 已忽略 `*.pem`），本机备份在 `~/.config/dalanchong/dalanchong-crx.pem`。

## 发版

版本号和发版由 AI 负责，维护者不手动改版本号。用户说「发版」「打包」「发布新版本」时：

1. 从上一个 `v*` 标签起看 `git log`，按改动定版本号（`manifest.json` 的 `version`）：只修问题加修订号（1.5.1 → 1.5.2），新增或改变功能加次版本号（1.5.1 → 1.6.0），主版本号只在用户要求时改
2. 只改 `extension/manifest.json` 的 `version`，提交 `Release v<版本>`
3. 打同名标签并推送：`git push origin main && git tag v<版本> && git push origin v<版本>`；工作流会检查标签与 manifest 一致，打包并发布到 Releases
4. 用 `gh run watch` 等工作流结束，确认 Release 里有 `.crx` 和 `.zip`、运行摘要里的扩展 ID 没变
5. 写中文更新说明替换自动生成的说明：`gh release edit v<版本> --notes-file <文件>`。按上一个标签以来的提交整理，面向用户写「新功能 / 改进 / 修复 / 移除」分组（没有的组省略），每条一句话说清用户能感知的变化，不写内部重构和提交哈希；最后附「安装」说明（解压 zip 后加载已解压的扩展程序）和完整对比链接
6. 把 Release 链接告诉用户

不要重复使用或移动已推送的标签；发错了就发下一个修订号。

## 结构

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 权限、内容脚本、`popup.html` 弹窗、`manager.html` 工作台 |
| `background.js` | Service Worker 入口：`PARSE_URL` 解析、抖音详情、`REFRESH_JOB` 链接失效后按来源重新解析 |
| `library.js` | 视频记录与下载队列：`LIST_LIBRARY`、`QUEUE_DOWNLOADS`、`CANCEL_JOB`、`CLEAR_LIBRARY`，webRequest 捕获，工具栏图标数字（已监听视频数） |
| `resolve.js` / `platforms.js` | 从链接或分享文案识别平台与作品 ID |
| `media.js` / `media-records.js` | 媒体类型、分段下载、去重标识、来源校验 |
| `offscreen.js` | 后台文档：多线程分段下载、HLS、FFmpeg WASM 合并音视频 |
| `capture.js` / `bridge.js` | 网页 MAIN world 媒体捕获，经 bridge 发给后台 |
| `page.js` / `kuaishou.js` | 在作品页 MAIN world 读取抖音 / 快手详情 |
| `ui.js` / `theme.css` | 弹窗与工作台共用的组件、画质文字、样式变量 |
| `popup.*` | 工具栏弹窗：累计监听到的视频（每个作品取最大文件）、预览、多选 / 全部下载、清空；打开作品页时自动解析当前作品 |
| `manager.*` | 工作台：批量下载（只列出本页解析的抖音作品，行内显示下载进度）、设置 |
| `player.*` | 弹窗与工作台共用的视频预览弹框 |
| `vendor/` | 本地打包的 Web Awesome、Lucide 图标、hls.js、FFmpeg WASM，不要手改 |

数据都在 `chrome.storage.session`：`media:<id>` 视频记录、`job:<id>` 下载任务、`parse:<requestId>` 解析进度、`res:<id>` 读取到的分辨率。设置在 `chrome.storage.local`（`downloadMode`、`downloadThreads`）。

## 约定

- 代码风格跟随周围代码：两空格缩进、单引号、短函数、注释少而说明原因
- 界面文字用简体中文，简洁；功能不要在多个地方重复出现
- 用户数据一律用 `textContent` / `element()` 渲染，不拼接 HTML
- MV3 CSP：不加载远程脚本或样式；新库放进 `vendor/` 并在 `THIRD_PARTY_NOTICES.md` 和 `licenses/` 记录
- 图标只用 `vendor/icons` 里已有的 Lucide 图标
- 画质无法判断时不显示「画质未知」之类的占位文字，只显示能确定的信息
- 平台地址会过期：下载失败要能按 `sourceUrl` 重新解析，不要只依赖保存的直链

## 改动前后检查

- 改解析或下载逻辑时，在真实的抖音、快手作品页和一个普通网页视频上实测，并在 PR 说明测过哪些链接
- 确认弹窗、工作台两个页面在窄窗口和宽窗口下排版正常，控制台无报错

## 许可

GPL-3.0（快手模块改编自 GPL-3.0 的 KS-Downloader）。引入第三方代码前确认许可兼容。
