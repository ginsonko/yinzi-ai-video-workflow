# 银子AI视频工作流桌面端

本目录负责 Windows x64、macOS Intel x64 与 macOS Apple Silicon arm64 的 Electron 发行包。普通用户无需在这里执行命令，应从项目 Release 下载：

- `银子AI视频工作流-通用版-老李兼容-Setup-0.1.3-beta.7-x64.exe`
- `银子AI视频工作流-通用版-老李兼容-Portable-0.1.3-beta.7-x64.exe`
- `银子AI视频工作流-通用版-老李兼容-0.1.3-beta.7-mac-arm64.dmg` 与同名 ZIP
- `银子AI视频工作流-通用版-老李兼容-0.1.3-beta.7-mac-x64.dmg` 与同名 ZIP

本次 beta.7 Release 上传带有“通用版-老李兼容”字样的文件，不显示银子智能路由入口，老李站点按文本、图片、视频三组独立 Base URL + Key 配置；银子 API 专属版的 beta.4 Release 保留在历史版本中。

源码打包要求 Node.js 22 或更新版本：

```powershell
git lfs pull
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
npm test
npm run dist
```

`npm run dist` 会构建前端、同步后端、生成图标、准备并验证 FFmpeg/FFprobe、扫描发布输入中的凭据，并生成安装版和便携版。用户数据固定保存在 `%APPDATA%\银子AI视频工作流`，不进入安装目录；卸载配置 `deleteAppDataOnUninstall=false`。

发布前还必须完成：

1. Electron 原生模块真实探针。
2. 全量前后端测试和 Vite 构建。
3. 隔离用户目录首次启动、端口冲突和双开验收。
4. FFmpeg 合成、抽帧、字幕、混音验收。
5. 安装、卸载与用户数据保留验收。
6. EXE、asar、资源目录的凭据与旧品牌扫描。

详细用户说明见 [release-docs/小白使用说明.md](release-docs/小白使用说明.md)，发布限制见 [release-docs/发布说明.md](release-docs/发布说明.md)。

## macOS 双架构测试包

macOS 正式构建入口只允许在与目标架构一致的真实 Mac 或 GitHub macOS runner 上运行：

```bash
git lfs pull
npm ci
npm run dist:mac:x64     # Intel Mac / macos-15-intel
npm run dist:mac:arm64   # Apple Silicon / macos-15
```

银子 API 专属版输出位于 `release-mac`；通用版 / 老李兼容版通过 `AI_VIDEO_MAC_VARIANT=universal` 输出位于 `release-mac-universal`：

- `银子AI视频工作流-通用版-老李兼容-0.1.3-beta.7-mac-arm64.dmg` 与同名 ZIP：Apple Silicon（M1/M2/M3/M4 及后续）。
- `银子AI视频工作流-通用版-老李兼容-0.1.3-beta.7-mac-x64.dmg` 与同名 ZIP：Intel Mac。

构建通用版时先设置 `AI_VIDEO_MAC_VARIANT=universal`；不设置时保持银子 API 专属版的原有构建入口。

入口会原生安装并探测 Sharp、Better SQLite3、FFmpeg/FFprobe，再生成 DMG 和 ZIP。Windows 上执行 `dist:mac` 会明确停止；旧 V0.1.1 手工重打包入口已从公开源码移除。未配置证书时产物未签名、未公证；完整安装步骤见 `release-docs/Mac小白测试说明.md`。
