# 快速开始

## Windows 用户

从 Release 下载 V0.1.2 内测版的 `银子AI视频工作流-Setup-0.1.2-beta.1-x64.exe` 或 `银子AI视频工作流-Portable-0.1.2-beta.1-x64.exe`。双击后先使用首页“模拟体验”；准备真实生成时，再按首页配置准备度依次填写文本、生图和视频服务。配置保存后可直接点“测试”，无需重复粘贴 Key。

应用已经内置 Node.js、SQLite、FFmpeg/FFprobe 和图片处理模块，不要求安装开发环境。用户数据保存在 `%APPDATA%\银子AI视频工作流`，升级和卸载默认保留。

## macOS 用户

Apple Silicon 下载文件名带 `mac-arm64` 的 DMG，Intel Mac 下载 `mac-x64`。优先使用 DMG 安装；未签名内测包首次打开时，按住 Control 点击应用并选择“打开”，不要关闭整个 Gatekeeper。详细步骤见 [Mac 小白测试说明](../desktop/release-docs/Mac小白测试说明.md)。

## 三种模式

- 人工审批：逐项确认、修改或打回。
- AI 审批：AI 自动打回、修改和复审，连续失败才交给人工。
- 全自动：从故事运行到最终成片，仅在预算、资源不足或连续异常时暂停。

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
