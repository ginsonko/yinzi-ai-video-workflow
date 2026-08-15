# 银子AI视频工作流 V0.1.2 macOS 测试版

版本：`0.1.2-beta.1`

本次为两个架构分别提供 DMG 和 ZIP：

- `mac-arm64`：Apple Silicon，适用于 M1、M2、M3、M4 及后续 Apple 芯片。
- `mac-x64`：Intel，适用于采用 Intel 处理器的 Mac。

应用包含当前 V0.1.2 的完整工作流、前后端、示例素材、对应架构的 Better SQLite3、Sharp、FFmpeg 和 FFprobe。用户无需安装 Node.js、npm、Python 或 FFmpeg。

V0.1.2 不再从 Windows 手工重打包 Mac 应用。Intel 包由真实 Intel macOS runner 原生构建，Apple Silicon 包由 arm64 macOS runner 原生构建；构建期间会实际加载 Better SQLite3 和 Sharp，并检查主程序与媒体工具架构。配置 Apple Developer 凭据时可执行签名/公证；没有凭据时产物会明确标记为未签名内测包。

推荐普通用户优先安装 DMG，ZIP 用于 DMG 下载或挂载异常时的备用测试。未签名包首次打开需要按《Mac 小白测试说明》放行，不能把“可生成安装包”当作已在所有 Mac 型号上完成真机验收。

数据目录为 `~/Library/Application Support/银子AI视频工作流`。删除应用本身不会删除作品、素材和配置；升级时请继续保留相同产品名与 appId。

作者：银子  |  GitHub：ginsonko  |  QQ：474764004  |  API：https://www.yinziapi.top
