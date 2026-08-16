const response = require('../response');
const videoService = require('../services/videoService');
const taskService = require('../services/taskService');
const videoClient = require('../services/videoClient');
const { normalizeAspectRatioForApi } = videoClient;

function publicVideoConfigSnapshot(config, model) {
  if (!config) return null;
  return {
    config_id: config.id,
    provider: config.provider || null,
    api_protocol: config.api_protocol || null,
    base_url: config.base_url || null,
    endpoint: config.endpoint || null,
    query_endpoint: config.query_endpoint || null,
    model: model || config.default_model || null,
  };
}

function routes(db, log) {
  return {
    list: (req, res) => {
      try {
        const query = { ...req.query };
        const { items, total, page, pageSize } = videoService.list(db, query);
        response.successWithPagination(res, items, total, page, pageSize);
      } catch (err) {
        log.error('videos list', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    create: (req, res) => {
      try {
        const body = req.body || {};
        const task = taskService.createTask(db, log, 'video_generation', String(body.drama_id || ''));
        const now = new Date().toISOString();
        const dramaId = Number(body.drama_id) || 0;
        const storyboardId = body.storyboard_id != null ? Number(body.storyboard_id) : null;
        const provider = body.provider || 'chatfire';
        let prompt = body.prompt || '';
        const style = (body.style || '').toString().trim();
        if (style) {
          const baseLower = String(prompt || '').toLowerCase();
          const styleLower = style.toLowerCase();
          if (!baseLower.includes(styleLower)) {
            prompt = prompt ? `${prompt}. Style: ${style}` : `Style: ${style}`;
          }
        }
        const model = body.model ?? null;
        const videoConfig = videoClient.getDefaultVideoConfig(db, model, body.video_config_id);
        const videoConfigId = videoConfig?.id || null;
        const providerProtocol = videoConfig ? videoClient.resolveVideoProtocol(videoConfig, model) : null;
        const providerConfigSnapshot = publicVideoConfigSnapshot(videoConfig, model);
        const duration = body.duration ?? null;
        // 画幅：请求体归一化（全角冒号等）后写入 DB；未传则从 drama.metadata 读取并同样归一化
        let aspectRatio = null;
        if (body.aspect_ratio != null && String(body.aspect_ratio).trim() !== '') {
          aspectRatio = normalizeAspectRatioForApi(body.aspect_ratio);
        }
        if (!aspectRatio && dramaId) {
          try {
            const dramaRow = db.prepare('SELECT metadata FROM dramas WHERE id = ? AND deleted_at IS NULL').get(dramaId);
            if (dramaRow && dramaRow.metadata) {
              const meta = typeof dramaRow.metadata === 'string' ? JSON.parse(dramaRow.metadata) : dramaRow.metadata;
              if (meta && meta.aspect_ratio) aspectRatio = normalizeAspectRatioForApi(meta.aspect_ratio);
            }
          } catch (_) {}
        }
        const resolution = body.resolution ?? null;
        const seed = body.seed != null ? Number(body.seed) : null;
        const cameraFixed = body.camera_fixed != null ? (body.camera_fixed ? 1 : 0) : null;
        const watermark = body.watermark != null ? (body.watermark ? 1 : 0) : 0;
        const imageUrl = body.image_url ?? null;
        // 首尾帧：支持 URL 或本地路径（sxy，存到 first_frame_url / last_frame_url）
        const firstFrameUrl = body.first_frame_url ?? body.first_frame_local_path ?? null;
        const lastFrameUrl = body.last_frame_url ?? body.last_frame_local_path ?? null;
        // 多图模式：sxy，存 JSON 数组到 reference_image_urls
        const refImagesJson =
          body.reference_image_urls && Array.isArray(body.reference_image_urls)
            ? JSON.stringify(body.reference_image_urls)
            : null;
        const refVideosJson = Array.isArray(body.reference_video_urls)
          ? JSON.stringify(body.reference_video_urls)
          : null;
        const refAudiosJson = Array.isArray(body.reference_audio_urls)
          ? JSON.stringify(body.reference_audio_urls)
          : null;
        const promptContractJson = body.prompt_contract && typeof body.prompt_contract === 'object'
          ? JSON.stringify(body.prompt_contract)
          : null;
        const contractValidationMode = videoClient.normalizeContractValidationMode(body.contract_validation_mode);
        db.prepare(
          `INSERT INTO video_generations (
             drama_id, storyboard_id, provider, prompt, prompt_contract_json, model, duration, aspect_ratio,
             resolution, seed, camera_fixed, watermark, image_url, first_frame_url, last_frame_url,
             reference_image_urls, reference_video_urls, reference_audio_urls, status, generation_status,
             download_status, video_config_id, provider_protocol, provider_config_snapshot_json,
             contract_validation_mode,
             task_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 'processing',
             'pending', ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          dramaId, storyboardId, provider, prompt, promptContractJson, model, duration, aspectRatio,
          resolution, seed, cameraFixed, watermark, imageUrl, firstFrameUrl, lastFrameUrl,
          refImagesJson, refVideosJson, refAudiosJson, videoConfigId, providerProtocol,
          providerConfigSnapshot ? JSON.stringify(providerConfigSnapshot) : null,
          contractValidationMode, task.id, now, now
        );
        const videoGenId = db.prepare('SELECT last_insert_rowid() as id').get().id;
        setImmediate(() => {
          videoService.processVideoGeneration(db, log, videoGenId);
        });
        const item = videoService.getById(db, videoGenId);
        response.created(res, item || { id: videoGenId, task_id: task.id, status: 'processing' });
      } catch (err) {
        log.error('videos create', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    get: (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        response.success(res, item);
      } catch (err) {
        log.error('videos get', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    retryDownload: async (req, res) => {
      try {
        const item = videoService.getById(db, req.params.id);
        if (!item) return response.notFound(res, '记录不存在');
        if (item.generation_status !== 'completed') {
          return response.badRequest(res, '上游视频尚未完成，不能进入下载恢复');
        }
        const result = await videoService.resumeDownloadForVideoGeneration(db, log, req.params.id);
        response.success(res, { result, video: videoService.getById(db, req.params.id) });
      } catch (err) {
        log.error('videos retry download', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    delete: (req, res) => {
      try {
        const ok = videoService.deleteById(db, log, req.params.id);
        if (!ok) return response.notFound(res, '记录不存在');
        response.success(res, { message: '删除成功' });
      } catch (err) {
        log.error('videos delete', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    fromImage: (req, res) => {
      try {
        const task = taskService.createTask(db, log, 'video_generation', req.params.image_gen_id);
        response.success(res, { task_id: task.id });
      } catch (err) {
        log.error('videos fromImage', { error: err.message });
        response.internalError(res, err.message);
      }
    },
    episodeBatch: (req, res) => {
      try {
        response.success(res, []);
      } catch (err) {
        log.error('videos episode batch', { error: err.message });
        response.internalError(res, err.message);
      }
    },
  };
}

module.exports = routes;
