# 快速开始

## Windows 用户

从 Release 下载 V0.1.3 Windows 测试版的 `银子AI视频工作流-Setup-0.1.3-beta.7-x64.exe` 或 `银子AI视频工作流-Portable-0.1.3-beta.7-x64.exe`。双击后先使用首页“模拟体验”；银子 API 专属版可使用一键智能路由；通用版请在“配置老李站点（三 Key）”或普通配置中分别填写文本、图片、视频的 URL 与 Key。能力信息稍后同步不会阻止保存或手动选模。配置保存后可直接点“测试”，无需重复粘贴 Key。

应用已经内置 Node.js、SQLite、FFmpeg/FFprobe 和图片处理模块，不要求安装开发环境。用户数据保存在 `%APPDATA%\银子AI视频工作流`，升级和卸载默认保留。

## macOS 用户

Apple Silicon 下载文件名带 `mac-arm64` 的 DMG，Intel Mac 下载 `mac-x64`。优先使用 DMG 安装；未签名内测包首次打开时，按住 Control 点击应用并选择“打开”，不要关闭整个 Gatekeeper。详细步骤见 [Mac 小白测试说明](../desktop/release-docs/Mac小白测试说明.md)。

## 三种模式

- 人工审批：逐项确认、修改或打回。
- AI 审批：AI 自动打回、修改和复审，连续失败才交给人工。
- 全自动：从故事运行到最终成片，仅在预算、资源不足或连续异常时暂停。

## 银子媒体站（三 Key）

如果使用 `image.yinziapi.top`，打开「AI 配置 → 配置银子媒体站」并填写文本、图片、视频三个 Key 即可。该站点不支持智能路由，系统会分别保存三项凭据，并预置视频协议：Seedance 2.5-720 只提交 30 秒，Seedance 2.0-720 可提交 5、10 或 15 秒。模型能力是建议值，不会阻止你手动输入和尝试未登记的新模型；提交失败时会保留上游返回的具体原因。

银子 API 专用版和通用 NewAPI/sub2 版共用同一套工作流内核。发行版 profile 只负责首次打开时的说明和一键配置入口：银子版可使用一个智能路由 Key；通用版分别填写文本、图片、视频 Key。`image.yinziapi.top` 在两个版本中都按普通三 Key 站点配置，不能也不会误走智能路由。默认发行版可在后端 `configs/config.yaml` 的 `app.distribution_profile` 设置为 `yinzi` 或 `universal`，也可通过 `AI_VIDEO_DISTRIBUTION_PROFILE` 临时覆盖。

## 源码开发

要求 Node.js 22 或更新版本：

```powershell
cd backend-node
npm install
npm start

# 新终端
cd frontweb
npm install
npm run dev
```

也可以双击仓库根目录的 `start-ai-video-demo.cmd`。更多产品和打包说明见 [根 README](../README.md)。
