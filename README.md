# 银子AI视频工作流

面向短剧、漫剧和分镜视频生产的本地工作流。项目把故事/小说、剧本、角色/场景/道具资产、逐镜分镜、可选 3D 导演台、视频生成、旁白字幕和最终剪辑组织成可恢复、可审批、可全自动运行的一条生产链。

- 当前版本：`0.1.2-beta.1`（V0.1.2 内测版）
- 维护者：银子
- GitHub：[`ginsonko`](https://github.com/ginsonko)
- 联系 QQ：`474764004`
- API：[`www.yinziapi.top`](https://www.yinziapi.top)
- 许可证：MIT，详见 [LICENSE](LICENSE) 与 [第三方声明](desktop/THIRD_PARTY_NOTICES.txt)

## 下载与启动

Windows x64 用户使用 Release 中的任一版本：

| 文件 | 适合场景 |
| --- | --- |
| `银子AI视频工作流-Setup-0.1.2-beta.1-x64.exe` | 推荐。带安装向导、桌面和开始菜单入口 |
| `银子AI视频工作流-Portable-0.1.2-beta.1-x64.exe` | 不安装，直接双击运行 |

安装包已经内置 Node.js 运行时、SQLite、FFmpeg/FFprobe 和图片处理模块，不要求用户安装 Node、npm、Python 或 FFmpeg。首次打开不会自动调用付费 API；没有 Key 也可以从首页进入零成本模拟体验。

> 当前安装包未做商业代码签名，Windows 可能显示 SmartScreen 提示。请只从项目 Release 下载并对照 `SHA256SUMS.txt`。

## 标准工作流

1. 输入故事梗概或导入小说，生成可阅读、可编辑、可打回的剧本。
2. 审批剧本中的角色、场景和道具清单，并发生成资产图；每项均可新增、修改、删除、确认或重做。
3. 按真实拍摄顺序逐镜生成分镜脚本、参考图和连续性约束，前一镜批准后再构建下一镜素材包。
4. 根据镜头需要选择是否生成 3D 导演台预演；它不是强制门控，也可以完全关闭。
5. 对需要无缝连续的镜头提取上一段尾帧作为下一段首帧；普通切镜不制造刻意遮挡转场。
6. 自动路由合适的视频模型，也允许在任务中手动覆盖模型、时长、参考图、参考视频和首帧策略。
7. 每段视频批准后生成旁白、字幕并保留原声，最终由内置 FFmpeg 完成节奏对齐、混音和成片合成。

三种运行模式共享同一条工作流：

- `人工审批`：逐阶段、逐对象确认或打回，适合精细控制。
- `AI 审批`：AI 自动评估、修改、复审；连续失败达到上限才交给人。
- `全自动`：从故事一路运行到成片，仅在预算、资源不足或连续异常时暂停。

## 关键能力

- 资产图可配置并发，分镜按依赖顺序逐镜推进。
- 角色、场景、道具、分镜图、镜头视频和成片均可版本化审批与回退。
- 已批准资产可以重新打回，也可以加入素材库供其它项目复用。
- 3D 导演台支持本地 JSON 驱动、关键帧时间线、相机和对象动作；整段预演可选携带。
- 自动按镜头长度、参考媒体能力和供应商状态路由视频模型，并保留人工覆盖入口。V0.1.2 内置当前 YinziAPI 的 22 个视频模型与价格快照，包括 Seedance 2.5、Grok、MiniMax 和 Kling；站点目录更新后仍会同步新模型。
- 旁白默认可使用 Xiaoyi Edge Neural 在线音色；无需 Python，但合成语音时需要联网。
- 高级设置可编辑全部系统/审核提示词，导入导出提示词包，维护模型价格和项目预算。
- 用户配置支持快照、回滚、备份、导入与跨设备迁移。
- 作品、素材、日志和配置存放在 `%APPDATA%\银子AI视频工作流`，升级和卸载默认不删除。

## 小白入口

打开应用后按首页顺序操作：

1. 先点“模拟体验”，使用随包演示素材走一遍审批流程。
2. 查看配置准备度，按提示分别配置文本、生图和视频服务。
   已保存配置可直接点“测试”，无需再次粘贴 Key；编辑时也可用“测试当前填写”验证尚未保存的 URL、模型或临时 Key。
3. 通过“开始制作”输入故事或导入小说。
4. 在人工审批、AI 审批和全自动中选择需要的模式。
5. 任务关闭或电脑重启后，从首页“最近项目”继续原进度。

应用内“说明书”包含 API 配置、3D 导演台、首尾帧、模型路由、预算和故障恢复说明。Windows 发行包也携带 [小白使用说明](desktop/release-docs/小白使用说明.md)。

## 源码开发

要求：Windows/macOS/Linux，Node.js `>=22`。Windows 发布包仅承诺 x64。

```powershell
git clone https://github.com/ginsonko/yinzi-ai-video-workflow.git
cd yinzi-ai-video-workflow
git lfs install
git lfs pull

cd backend-node
npm install
npm start

# 新终端
cd frontweb
npm install
npm run dev
```

开发模式可直接运行仓库根目录的 `start-ai-video-demo.cmd`。默认前端会选择可用端口，后端仅监听本机回环地址。

## Windows 打包

```powershell
cd desktop
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm install
npm run dist
```

打包脚本会构建前端、同步后端、生成图标、准备并探测 FFmpeg、扫描发布输入中的凭据，再生成安装版和便携版。正式发布前还应运行全量测试、隔离用户目录启动、端口冲突、双开、迁移、安装/卸载数据保留和最终 EXE 敏感信息扫描。

## macOS 测试包

macOS 包必须在对应架构的真实 Mac 上原生构建。正式发行工作流使用 `macos-15-intel` 生成 Intel x64 的 DMG/ZIP，使用 `macos-15` 生成 Apple Silicon arm64 的 DMG/ZIP；Windows 上的旧手工重打包入口已停用，避免再次产生能解压但不能可靠安装或运行的伪 Mac 包。

在真实 Mac 源码构建时执行：

```bash
git lfs pull
cd desktop
npm ci
npm run dist:mac:x64     # 仅 Intel Mac
npm run dist:mac:arm64   # 仅 Apple Silicon Mac
```

产物位于 `desktop/release-mac`，优先分发 DMG，ZIP 作为备用。未配置 Apple Developer 凭据时是未签名内测包；配置 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID` 后可走签名/公证链。安装、Gatekeeper 放行和反馈日志位置见 [Mac 小白测试说明](desktop/release-docs/Mac小白测试说明.md)。

## 数据与隐私

- API Key 只写入用户本机配置，不写入源码、演示素材或安装包。
- 模拟体验、3D 导演台和本地剪辑无需付费 API；文本、生图、视频与 Edge Neural 语音需要联网。
- 默认服务可使用 YinziAPI，也支持其它 OpenAI 兼容站点；其它站点可能需要手动配置模型能力和价格。
- 达到预算上限只停止新的外部提交，不删除已经生成的资产。

## 开源来源

本项目基于 LocalMiniDrama 继续开发。原项目版权与 MIT 授权信息保留在 [LICENSE](LICENSE)、Git 历史和 [第三方声明](desktop/THIRD_PARTY_NOTICES.txt) 中。当前产品品牌、维护入口与发行包均由银子维护；旧项目的个人联系方式、群二维码和收款二维码不属于本产品入口。
