# 参与贡献

欢迎提交 Issue 和 Pull Request。

## 报告问题

请附上：Chrome 版本、扩展版本、出问题的网页地址（可去掉个人参数）、操作步骤，以及工作台或扩展 Service Worker 控制台里的报错。

## 开发

扩展是纯原生 JavaScript（ES Modules），不需要构建：直接在 `chrome://extensions` 加载 `extension` 文件夹，修改后点「重新加载」。

- 代码风格与周围保持一致，界面文字使用简体中文
- 用户数据一律用 `textContent` 渲染，不拼接 HTML
- 遵守 MV3 内容安全策略：不加载远程脚本，第三方库放在 `extension/vendor/` 并在 `THIRD_PARTY_NOTICES.md` 记录来源与许可
- 改动解析或下载逻辑时，请在 PR 中说明在哪些平台、哪些链接上实测过

## 许可

提交的代码将以 GPL-3.0 发布。
