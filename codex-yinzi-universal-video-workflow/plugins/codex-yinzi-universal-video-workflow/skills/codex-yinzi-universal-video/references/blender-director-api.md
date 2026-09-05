# Blender 专业导演台（S1）

Blender 是按镜头选择的可选本地执行器。快速 Three.js 预演仍是默认回退；没有 Blender、版本未知或资源不足时，不阻塞普通图片、剪辑和视频流程。

## 能力探测

调用 `GET /api/v1/production-director/blender/capability`。返回值中的 `available`、`version_known` 和 `status` 是本机本次探测结果。`renderers.verified=false` 表示只完成 `blender --version`，不能当成渲染通过；只有真实 smoke 产物验收后才能记录渲染器可用。

## S1 smoke 准备

调用 `POST /api/v1/production-director/blender/smoke/prepare`，请求体只传：

```json
{
  "request_key": "session-id:node-key",
  "scene": {
    "version": 2,
    "active_camera_id": "camera-1",
    "objects": [
      { "id": "camera-1", "kind": "camera", "props": { "aim_mode": "rotation" } },
      { "id": "floor", "kind": "plane", "props": {} },
      { "id": "actor", "kind": "character", "props": { "profile_id": "human.adult.female" } }
    ],
    "timeline": { "duration": 5, "keyframes": [] }
  }
}
```

`scene` 必须符合现有导演台场景 JSON v2 合同，`request_key` 是稳定的非凭据标识。响应包含场景哈希、对象/关键帧摘要、预期 `.blend`、GLB、PNG 帧、MP4 和 manifest 相对路径，以及确定的命令参数。`executed=false` 和 `side_effects.filesystem_write=false` 是固定保证：准备接口不会启动 Blender、不会创建媒体、不会调用网络或付费模型。

当 `status=blocked` 时，使用 `blocked_reason` 向用户说明并回退 Three.js；不要改写场景或无限重试。当前 S1 脚本 `runtime/blender/smoke_scene.py` 只创建离线测试几何体、渲染三帧 PNG、保存 `.blend` 并尽力导出 GLB；MP4 编码必须由单独验收过的 FFmpeg 阶段完成。脚本的真实执行、显存/耗时、材质转换和专业质量仍属于后续阶段，不得用准备响应宣称已完成。

## 安全和恢复

- Blender 命令使用 `--background --disable-autoexec --python-exit-code 2`；公开 HTTP 不接收任意 Python 脚本或任意输出路径。
- 产物目录由项目存储根和 plan ID 派生，准备阶段不会写入；执行器需在启动前再次做路径包含检查和幂等锁。
- 重复相同 `request_key` 的准备应复用相同场景哈希/plan ID；场景发生变化应创建新的计划或由编排层显式重开节点。
- 进程崩溃、缺帧、GLB 导出失败和编码失败必须分别记录原始错误；恢复时只重跑缺失阶段，不重新生成已存在的帧或调用上游。
