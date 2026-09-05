# Codex 银子万能视频工作流

这是银子 AI 视频工作流的 Codex 插件层。用户直接把目标、文件或文件夹位置告诉 Codex；Codex 根据真实素材动态安排研究、写作、图片/视频生成、剪辑和验收。现有本地应用负责配置、持久化、进度/费用/错误显示、项目与剧集管理，以及随时可用的人工接管。

它不是固定模板，也不会因为本地没有登记某个模块就禁止任务。所有实际动作都会进入可恢复的会话、节点、事件和回执中；换线程、压缩上下文或重启后从本地真值继续，避免重复生成和重复计费。

## 当前能力层级

- V1 编排核心：已集成动态计划、节点状态、失败回执、直接重试、暂停/恢复、检查点、审计导出和编排台。
- V2 研究与创意：由 Codex 执行研究/推理，系统保存来源、决策和产物。
- V3 媒体执行：桥接现有银子工作流的导入、生成和编辑能力；每个真实产物必须写回回执。高标准镜头还可以选择 `director.blender-render`，由本地 Blender 生成可编辑工程、逐帧参考图、GLB 预览和 FFmpeg 参考视频；普通任务继续走更快的 Three.js 路径。
- V4 自修复：支持诊断、补丁/适配器提案、沙盒测试和回放；生产应用仍需明确确认与回滚。

## 安装与首次使用

插件层和工作流运行时是两个可升级部件。插件负责 Codex 的规划、执行桥接和恢复；桌面包或源码 checkout 提供完整工作台、SQLite 和媒体工具。插件不会把 API Key 写入仓库，也不会在安装或打开界面时调用付费模型。

### 从 GitHub 安装（Windows）

在 PowerShell 中先浅克隆并检查仓库，再运行仓库自带的安装脚本。脚本会把仓库浅克隆到用户本地应用数据目录、注册 Marketplace 并安装插件；已存在的 checkout 只更新到远端 HEAD。

```powershell
$source = Join-Path $env:TEMP 'yinzi-ai-video-workflow'
git clone --depth 1 https://github.com/ginsonko/yinzi-ai-video-workflow.git $source
& "$source\\codex-yinzi-universal-video-workflow\\scripts\\install-plugin.ps1" -Repository $source
```

更谨慎的方式是先下载并检查脚本，再从本地执行；脚本只操作 `%LOCALAPPDATA%\\Yinzi\\CodexVideoWorkflow\\source`，不会修改源码仓库外的 API 配置。安装完成后请开启一个新 Codex 任务，让宿主重新发现 Skill。若宿主尚未热加载 MCP，当前任务可使用下面的 CLI 续接。

### 源码/桌面运行时

用户已有桌面发行包时直接打开它即可；Codex 的 `open_workflow` 会复用并校验桌面包的本地 runtime identity。开发者或没有桌面包的用户可在仓库根目录运行：

```powershell
node codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/scripts/runtime-launcher.mjs ensure --build --json
```

这会在本机选择空闲回环端口、构建 `frontweb/dist`（不存在时）并启动后端静态界面。运行时登记在 `%LOCALAPPDATA%\\Yinzi\\CodexVideoWorkflow\\runtime.json`，不含密钥；`status --json` 查看状态，`stop --json` 只停止登记且身份仍匹配的进程。若只有插件副本而没有桌面包或源码，请先安装桌面包，或设置 `YINZI_WORKFLOW_PROJECT_ROOT` 指向源码根目录；插件不会假装提供完整 UI。

在应用设置中保存文本、图片和视频服务配置；不要把 Key 写进 Codex 提示词、计划、事件或项目文件。自然语言任务由 Skill 先给出通俗计划和费用，用户批准后才启动付费节点。

当前本地验收命令（工具会优先自动探测正式启动端口 5683，并兼容 5679/5680/5682；只选择真正提供编排路由且身份一致的实例，也可用 `YINZI_WORKFLOW_URL` 固定地址）：

```powershell
codex plugin marketplace add "<本仓库目录>"
```

Marketplace 只负责让插件出现在 Codex 中；API Key 仍在本地工作流的“模型与 Key”页面配置，不进入 Codex 插件或仓库。Marketplace 安装后建议使用新任务验证自动发现；同一任务若未热加载，使用上述 CLI 先检查/启动，再在后续任务中继续。

开发/验收时可从插件根目录运行：

```powershell
node plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/scripts/orchestration-cli.mjs health
```

示例：

> 使用 `$codex-yinzi-universal-video` 读取 `D:\商品A`。逐个识别商品、卖点、适用人群和现有视频，研究近期同类短视频的结构，为每个商品规划 15 秒 9:16 投流素材。保持产品和人物一致，不虚构价格规格；先复用已有片段，只生成缺失镜头。先给我计划和最高费用，确认后再调用付费模型。

付费图片和视频任务分别通过 `generate_image_once` / `reconcile_image` 与 `generate_video_once` / `reconcile_video` 执行。工具会在提交前锁定本地配置、模型能力、当前价格、预算和稳定请求哈希；同一请求只提交一次。视频上游生成和本地下载分别记录，下载失败只恢复下载，不会重新生成或重复计费。

用户可以打开应用中的“Codex 编排台”查看或手动接管，系统不要求用户再在页面里重复聊天。
