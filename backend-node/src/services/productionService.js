const crypto = require('node:crypto');
const repo = require('./productionRepository');
const graph = require('./productionGraph');
const textStages = require('./productionTextStages');
const aiClient = require('./aiClient');
const director = require('./productionDirector');
const { createProductionMediaService } = require('./productionMediaService');
const { createProductionShotService } = require('./productionShotService');
const { createFinalEditService } = require('./productionFinalEditService');
const imageClient = require('./imageClient');
const videoClient = require('./videoClient');
const videoService = require('./videoService');
const mediaValidation = require('./productionMediaValidation');
const autonomy = require('./productionAutonomy');
const reviewMedia = require('./productionReviewMedia');
const { getYinziVideoCapability, capabilitySupportsRole } = require('./yinziVideoCapabilities');
const { classifyShotRoute, routingMaterialSignature } = require('./productionVideoRouter');
const { hasLocalFfmpeg, hasLocalFfprobe } = require('../utils/ffmpegPath');
const promptRegistry = require('./productionPromptRegistry');
const promptRuntime = require('./productionPromptRuntime');
const accounting = require('./productionRuntimeAccounting');
const costLedger = require('./productionCostLedger');
const aiConfigService = require('./aiConfigService');
const automationPreferences = require('./productionAutomationPreferences');

const PRODUCTION_TEXT_SILENCE_TIMEOUT_MS = 180000;

function createDefaultAdapters(db, log) {
  return {
    generateText: (user, system, options = {}) => aiClient.generateText(
      db, log, 'text', user, system, options
    ),
    generateTextWithVision: (user, system, imageSource, options = {}) => aiClient.generateTextWithVision(
      db, log, 'text', user, system, imageSource, options
    ),
  };
}

function latestArtifact(db, runId, stage, scopeType = null, scopeId = null) {
  const items = repo.listArtifacts(db, runId, {
    stage,
    current: true,
    ...(scopeType ? { scope_type: scopeType } : {}),
    ...(scopeId != null ? { scope_id: scopeId } : {}),
    page_size: 200,
  }).items;
  return items[0] || null;
}

function approvedArtifacts(db, runId, stage) {
  return repo.listArtifacts(db, runId, { stage, current: true, status: 'approved', page_size: 200 }).items;
}

function actionAttempt(db, runId, stage, scopeId = '') {
  return repo.nextActionAttempt(db, runId, stage, null, scopeId);
}

function generationKey(stage, scopeId, attempt) {
  return `${stage}:${scopeId || 'run'}:generate:a${attempt}`;
}

const SEQUENTIAL_SHOT_STAGES = [
  'storyboard_plan',
  'storyboard_images',
  'director_plan',
  'director_preview',
  'reference_bundle',
  'shot_video',
];

function isSequentialShotRun(run) {
  return run.runtime?.shot_pipeline?.mode === 'sequential';
}

function isDirectorDisabled(run) {
  return String(run?.policy?.director_mode || 'auto') === 'off';
}

function compareShots(left, right) {
  const leftNumber = Number(left.content?.number);
  const rightNumber = Number(right.content?.number);
  const leftHasNumber = Number.isFinite(leftNumber);
  const rightHasNumber = Number.isFinite(rightNumber);
  if (leftHasNumber && rightHasNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  if (leftHasNumber !== rightHasNumber) return leftHasNumber ? -1 : 1;
  return String(left.scope_id).localeCompare(String(right.scope_id), undefined, { numeric: true });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, Math.max(1, Number(limit) || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function createProductionService(db, cfg, log, injected = {}) {
  const configuredAdapters = { ...createDefaultAdapters(db, log), ...injected };
  const adapters = {
    ...configuredAdapters,
    generateText: (user, system, options = {}) => configuredAdapters.generateText(user, system, {
      silence_timeout_ms: PRODUCTION_TEXT_SILENCE_TIMEOUT_MS,
      ...options,
    }),
    generateTextWithVision: (user, system, imageSource, options = {}) => configuredAdapters.generateTextWithVision(
      user, system, imageSource, {
        silence_timeout_ms: PRODUCTION_TEXT_SILENCE_TIMEOUT_MS,
        ...options,
      }
    ),
  };
  const media = createProductionMediaService(db, cfg, log, {
    generateText: adapters.generateText,
    ...(injected.media || {}),
  });
  const finalEdit = createFinalEditService(db, cfg, log, injected.finalEdit || {});
  const validateImage = injected.validateImage || ((mediaPath, options) => mediaValidation.validateImage(cfg, mediaPath, options));
  const validateVideo = injected.validateVideo || ((mediaPath, options) => mediaValidation.validateVideo(cfg, mediaPath, options));
  const prepareReviewEvidence = injected.prepareReviewEvidence
    || ((artifact) => reviewMedia.prepareVisualReviewEvidence(cfg, artifact, injected.reviewMedia || {}));

  function orderedShots(run) {
    return approvedArtifacts(db, run.id, 'storyboard_plan')
      .filter((item) => item.content?.included !== false)
      .sort(compareShots);
  }

  function currentPlannedShots(run) {
    return repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', current: true, page_size: 200,
    }).items
      .filter((item) => item.content?.included !== false)
      .sort(compareShots);
  }

  function routingShot(run, shotId = null, required = false) {
    const shots = orderedShots(run);
    const resolvedId = shotId ?? run.current_scope_id;
    const shot = resolvedId == null
      ? shots[0] || null
      : shots.find((item) => String(item.scope_id) === String(resolvedId)) || null;
    if (!shot && required) {
      const error = new Error(`找不到已确认的镜头 ${resolvedId ?? ''}`.trim());
      error.code = 'VIDEO_ROUTE_SHOT_NOT_FOUND';
      throw error;
    }
    return shot;
  }

  // Routing can be edited while a storyboard revision is being reviewed. This
  // read path deliberately does not feed production: orderedShots() remains
  // approved-only and all generation stages keep using it.
  function routingEditableShot(run, shotId = null, required = false) {
    const resolvedId = shotId ?? run.current_scope_id;
    if (resolvedId == null) return routingShot(run, null, required);
    const shot = latestArtifact(db, run.id, 'storyboard_plan', 'shot', String(resolvedId));
    if (!shot && required) {
      const error = new Error(`找不到镜头 ${resolvedId} 的当前分镜版本`.trim());
      error.code = 'VIDEO_ROUTE_SHOT_NOT_FOUND';
      throw error;
    }
    return shot;
  }

  function routingPreviewShot(run) {
    return routingShot(run) || {
      id: null,
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: 'preview',
      content: {
        number: 1,
        duration: 5,
        previs_mode: 'skip',
        transition_mode: 'opening',
      },
    };
  }

  function publicRoutingReceipt(route) {
    if (!route) return null;
    const { capability: _capability, candidates: _candidates, ...receipt } = route;
    return receipt;
  }

  function readOnlyVideoConfigId(preferredModel = '') {
    const rows = db.prepare(
      `SELECT id FROM ai_service_configs
       WHERE deleted_at IS NULL AND is_active = 1 AND service_type = 'video'
       ORDER BY is_default DESC, priority DESC, created_at DESC, id ASC`
    ).all();
    if (!rows.length) return null;
    const configs = rows.map((row) => aiConfigService.getConfig(db, row.id)).filter(Boolean);
    const target = String(preferredModel || '').trim();
    if (target) {
      const matched = configs.find((config) => {
        const configuredModels = Array.isArray(config.model)
          ? config.model.map((item) => String(item || '').trim())
          : config.model ? [String(config.model).trim()] : [];
        const discoveredModels = Array.isArray(config.model_catalog_snapshot?.models)
          ? config.model_catalog_snapshot.models
            .map((item) => String(item?.model || item || '').trim())
            .filter(Boolean)
          : [];
        return config.default_model === target
          || configuredModels.includes(target)
          || discoveredModels.includes(target);
      });
      if (matched) return Number(matched.id);
    }
    return Number(configs[0].id);
  }

  function routingPolicyState(run, shot) {
    const overrides = run.policy?.video_model_overrides && typeof run.policy.video_model_overrides === 'object'
      ? run.policy.video_model_overrides
      : {};
    const shotModel = shot ? String(overrides[String(shot.scope_id)] || '').trim() : '';
    const previsOverrides = run.policy?.video_previs_overrides && typeof run.policy.video_previs_overrides === 'object'
      ? run.policy.video_previs_overrides
      : {};
    const shotPrevisOverride = shot
      ? String(previsOverrides[String(shot.scope_id)] || '').trim()
      : '';
    const projectMode = run.policy?.video_routing_mode
      ? String(run.policy.video_routing_mode)
      : String(run.policy?.video_model || '').trim() ? 'fixed' : 'auto';
    // Some legacy runs were created before a video Key was saved and therefore
    // have no persisted config id. The picker still needs a concrete config
    // context to open the advisory capability editor. Resolve that context
    // read-only from the selected model/default; this never changes dispatch
    // policy, credentials, or the model sent upstream.
    let configId = run.policy?.video_config_id == null ? null : Number(run.policy.video_config_id);
    if (configId == null || !Number.isSafeInteger(configId) || configId <= 0) {
      const preferredModel = shotModel || (projectMode === 'fixed' ? String(run.policy?.video_model || '').trim() : '');
      try {
        configId = readOnlyVideoConfigId(preferredModel);
      } catch (_) {
        configId = null;
      }
    }
    return {
      project: {
        mode: projectMode === 'fixed' ? 'fixed' : 'auto',
        model: String(run.policy?.video_model || ''),
        provider: String(run.policy?.video_provider || 'yinzi'),
        config_id: configId,
        group: String(run.policy?.video_group || ''),
        quality: String(run.policy?.video_quality || 'balanced'),
        director_mode: String(run.policy?.director_mode || 'auto') === 'off' ? 'off' : 'auto',
      },
      shot: shot ? {
        id: String(shot.scope_id),
        mode: shotModel ? 'fixed' : 'inherit',
        model: shotModel,
        previs_mode_override: ['force', 'skip'].includes(shotPrevisOverride) ? shotPrevisOverride : null,
      } : null,
    };
  }

  function actionRouteIdentity(action) {
    const receipt = action?.request?.routing_receipt || {};
    const model = String(action?.request?.model || receipt.model || '').trim();
    let signature = String(
      action?.request?.routing_material_signature
      || receipt.material_signature
      || action?.result?.routing_material_signature
      || ''
    ).trim();
    if (!signature && receipt.model) {
      try { signature = routingMaterialSignature(receipt); } catch (_) {}
    }
    return { model, signature };
  }

  function resolvedRouteIdentity(route) {
    const model = String(route?.model || '').trim();
    let signature = String(route?.material_signature || '').trim();
    if (!signature && model) signature = routingMaterialSignature(route);
    return { model, signature };
  }

  function actionRouteChanged(action, route) {
    if (!action || !route) return false;
    const previous = actionRouteIdentity(action);
    const next = resolvedRouteIdentity(route);
    if (previous.model && next.model && previous.model !== next.model) return true;
    return Boolean(previous.signature && next.signature && previous.signature !== next.signature);
  }

  function supersedeActionForRouteChange(run, shot, route, reason = '') {
    const action = shot?.id == null || shot.status !== 'approved' ? null : repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_generate',
    });
    if (!action || !actionRouteChanged(action, route)) return null;

    const previous = actionRouteIdentity(action);
    const next = resolvedRouteIdentity(route);
    const hasExternalIdentity = Boolean(action.task_id || action.generation_id || action.provider_id);
    const retryReason = String(reason || '').trim()
      || `视频路由已从 ${previous.model || '旧配置'} 切换为 ${next.model || '新配置'}`;
    const result = {
      ...(action.result || {}),
      superseded_by_route_change: true,
      route_change_authorized: true,
      previous_route_model: previous.model || null,
      previous_routing_material_signature: previous.signature || null,
      replacement_route_model: next.model || null,
      replacement_routing_material_signature: next.signature || null,
      route_changed_at: new Date().toISOString(),
    };
    let outcome = 'history_only';
    let updated = action;

    if (action.status === 'failed' || action.status === 'cancelled') {
      outcome = 'cancelled';
      updated = repo.updateAction(db, action.id, {
        status: 'cancelled',
        result: {
          ...result,
          retry_authorized: true,
          retry_reason: retryReason,
        },
      });
    } else if (action.status === 'reserved' && !hasExternalIdentity) {
      outcome = 'cancelled_before_submission';
      updated = repo.updateAction(db, action.id, {
        status: 'cancelled',
        cost_status: 'released',
        result: {
          ...result,
          retry_authorized: true,
          retry_reason: retryReason,
          superseded_before_submission: true,
        },
      });
    } else if (action.status === 'submitted' && !hasExternalIdentity) {
      outcome = 'ambiguous_external_create';
      updated = repo.updateAction(db, action.id, {
        status: 'ambiguous',
        error_code: 'VIDEO_CREATE_AMBIGUOUS',
        error_message: '旧模型请求已经外发但没有任务 ID，无法确认是否扣费；已保留待对账，禁止自动重复提交',
        result,
      });
    } else if (['reserved', 'submitted', 'waiting'].includes(action.status)) {
      outcome = 'in_flight';
      updated = repo.updateAction(db, action.id, { result });
    }

    if (outcome !== 'history_only') {
      repo.appendEvent(db, run.id, 'action.route_superseded', {
        stage: action.stage, scope_type: action.scope_type, scope_id: action.scope_id,
        payload: {
          action_id: action.id,
          outcome,
          previous_model: previous.model || null,
          replacement_model: next.model || null,
          paid_submission: action.status === 'reserved' ? false : hasExternalIdentity ? true : null,
        },
      });
    }
    return { action: updated, previous: action, outcome };
  }

  async function getVideoRouting(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const shot = input.shot_id != null
      ? routingEditableShot(run, input.shot_id, true)
      : routingPreviewShot(run);
    const catalog = await media.listVideoRoutingOptions(run, shot);
    let effectiveRoute = null;
    let effectiveRouteError = null;
    try {
      effectiveRoute = await media.resolveShotVideoRoute(run, shot);
    } catch (error) {
      effectiveRouteError = {
        code: error.code || 'VIDEO_ROUTE_UNAVAILABLE',
        message: error.message || '当前视频路由暂时不可用',
      };
    }
    const failedAction = shot.id == null || shot.status !== 'approved' ? null : repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_generate',
    });
    return {
      ...routingPolicyState(run, shot.id == null ? null : shot),
      shot_status: shot.id == null ? null : shot.status,
      route_edit_deferred: shot.id != null && shot.status !== 'approved',
      effective_route: publicRoutingReceipt(effectiveRoute),
      effective_route_error: effectiveRouteError,
      catalog,
      failed_action: failedAction?.status === 'failed' ? {
        id: failedAction.id,
        status: failedAction.status,
        model: failedAction.request?.model || failedAction.request?.routing_receipt?.model || null,
        error_code: failedAction.error_code || null,
        error_message: failedAction.error_message || null,
      } : null,
      run_version: run.version,
    };
  }

  async function updateVideoRouting(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    if (input.expected_version == null) {
      const error = new Error('缺少任务版本，请刷新后重试');
      error.code = 'VERSION_CONFLICT';
      throw error;
    }
    const scope = input.scope === 'shot' ? 'shot' : 'run';
    const targetShot = scope === 'shot'
      ? routingEditableShot(run, input.shot_id, true)
      : routingShot(run, input.shot_id ?? run.current_scope_id) || routingPreviewShot(run);
    const targetShotApproved = targetShot.id == null || targetShot.status === 'approved';
    const nextPolicy = { ...(run.policy || {}) };
    if (input.config_id !== undefined) {
      const configId = Number(input.config_id);
      if (!Number.isSafeInteger(configId) || configId <= 0) throw new Error('视频配置 ID 无效');
      const config = aiConfigService.getConfig(db, configId);
      if (!config || config.service_type !== 'video' || config.is_active === false) {
        throw new Error(`视频配置 #${configId} 不存在、不是视频配置或已停用`);
      }
      nextPolicy.video_config_id = configId;
    }
    if (scope === 'run') {
      const mode = input.mode === 'fixed' ? 'fixed' : 'auto';
      const model = String(input.model || '').trim();
      if (mode === 'fixed' && !model) throw new Error('固定模型模式必须选择视频模型');
      nextPolicy.video_routing_mode = mode;
      nextPolicy.video_model = mode === 'fixed' ? model : '';
      if (input.group != null) nextPolicy.video_group = String(input.group || '').trim();
      if (input.quality != null) {
        const quality = String(input.quality || 'balanced');
        if (!['balanced', 'speed', 'quality', 'economy'].includes(quality)) throw new Error('未知视频质量偏好');
        nextPolicy.video_quality = quality;
      }
    } else {
      const mode = input.mode === 'fixed' ? 'fixed' : 'inherit';
      const model = String(input.model || '').trim();
      if (mode === 'fixed' && !model) throw new Error('镜头手动模式必须选择视频模型');
      const overrides = nextPolicy.video_model_overrides && typeof nextPolicy.video_model_overrides === 'object'
        ? { ...nextPolicy.video_model_overrides }
        : {};
      if (mode === 'fixed') overrides[String(targetShot.scope_id)] = model;
      else delete overrides[String(targetShot.scope_id)];
      nextPolicy.video_model_overrides = overrides;
      if (input.previs_mode != null) {
        const previsMode = String(input.previs_mode || '').trim();
        if (!['auto', 'force', 'skip'].includes(previsMode)) {
          const error = new Error('3D 导演台模式必须是自动、跳过或强制');
          error.code = 'VIDEO_PREVIS_MODE_INVALID';
          throw error;
        }
        const previsOverrides = nextPolicy.video_previs_overrides && typeof nextPolicy.video_previs_overrides === 'object'
          ? { ...nextPolicy.video_previs_overrides }
          : {};
        if (previsMode === 'auto') delete previsOverrides[String(targetShot.scope_id)];
        else previsOverrides[String(targetShot.scope_id)] = previsMode;
        if (Object.keys(previsOverrides).length) nextPolicy.video_previs_overrides = previsOverrides;
        else delete nextPolicy.video_previs_overrides;
      }
    }

    const candidateRun = { ...run, policy: nextPolicy };
    const affectedShots = scope === 'run'
      ? (orderedShots(run).length ? orderedShots(run) : [targetShot])
      : [targetShot];
    const routes = [];
    for (const shot of affectedShots) {
      try {
        routes.push({ shot, route: await media.resolveShotVideoRoute(candidateRun, shot) });
      } catch (error) {
        error.message = `镜头 ${shot.scope_id}：${error.message}`;
        throw error;
      }
    }
    const expensiveRoute = routes.find(({ route }) => route.capability?.expensive_bypass === true);
    if (expensiveRoute && input.confirm_expensive !== true) {
      const error = new Error(`模型 ${expensiveRoute.route.model} 属于高价破甲通道，必须单独确认价格后才能选择`);
      error.code = 'EXPENSIVE_VIDEO_MODEL_CONFIRMATION_REQUIRED';
      throw error;
    }

    if (!targetShotApproved && input.authorize_retry === true) {
      const error = new Error('当前分镜尚未确认，路由可以保存，但不能授权视频重试');
      error.code = 'VIDEO_ROUTE_RETRY_REQUIRES_APPROVED_SHOT';
      throw error;
    }
    const latestVideoAction = targetShot.id == null || !targetShotApproved ? null : repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: targetShot.scope_id, kind: 'video_generate',
    });
    const retryReason = String(input.retry_reason || '').trim();
    if (input.authorize_retry === true && latestVideoAction?.status === 'failed' && !retryReason) {
      throw new Error('当前镜头已有失败任务，请填写切换模型和重试的原因');
    }

    let updatedRun = repo.updateRun(db, run.id, { policy: nextPolicy }, input.expected_version);
    const routeSupersessions = routes
      .map(({ shot, route }) => supersedeActionForRouteChange(updatedRun, shot, route, retryReason))
      .filter(Boolean);
    let retryAction = null;
    if (input.authorize_retry === true
      && latestVideoAction?.status === 'failed'
      && !routeSupersessions.some((item) => item.previous.id === latestVideoAction.id)) {
      retryAction = repo.updateAction(db, latestVideoAction.id, {
        status: 'cancelled',
        result: {
          ...(latestVideoAction.result || {}),
          retry_authorized: true,
          retry_reason: retryReason,
          route_change_authorized: true,
        },
      });
      repo.appendEvent(db, run.id, 'action.retry_authorized', {
        stage: 'shot_video', scope_type: 'shot', scope_id: targetShot.scope_id,
        payload: { action_id: latestVideoAction.id, reason: retryReason, source: 'video_route_change' },
      });
    }

    const targetSupersession = routeSupersessions.find((item) => (
      String(item.previous.scope_id || '') === String(targetShot.scope_id || '')
    ));
    if (!retryAction && ['cancelled', 'cancelled_before_submission'].includes(targetSupersession?.outcome)) {
      retryAction = targetSupersession.action;
    }
    if (targetSupersession) {
      const resolvedRuntime = resolvedAutonomyRuntime(updatedRun, { action: targetSupersession.previous });
      if (resolvedRuntime) {
        updatedRun = repo.updateRun(db, run.id, {
          runtime: resolvedRuntime,
          status: 'running',
          waiting_reason: null,
          error_code: null,
          error_message: null,
        });
        repo.appendEvent(db, run.id, 'automation.route_intervention_cleared', {
          stage: 'shot_video', scope_type: 'shot', scope_id: targetShot.scope_id,
          payload: { action_id: targetSupersession.previous.id },
        });
      }
    }

    let bundleResult = null;
    const targetsCurrentShot = targetShot.id != null
      && String(run.current_scope_id || '') === String(targetShot.scope_id);
    if (targetShotApproved && targetsCurrentShot && ['reference_bundle', 'shot_video'].includes(run.current_stage)) {
      bundleResult = await media.ensureReferenceBundleForShot(updatedRun, targetShot);
      if (bundleResult.state === 'refreshed' || run.current_stage === 'shot_video') {
        updatedRun = repo.updateRun(db, run.id, {
          current_stage: 'reference_bundle',
          current_scope_type: 'shot',
          current_scope_id: String(targetShot.scope_id),
          status: 'waiting_review',
          waiting_reason: 'video_route_changed',
          error_code: null,
          error_message: null,
        });
      }
    }

    const selectedRoute = routes.find(({ shot }) => String(shot.scope_id) === String(targetShot.scope_id))?.route
      || routes[0]?.route
      || null;
    repo.appendEvent(db, run.id, 'video_route.updated', {
      stage: updatedRun.current_stage,
      scope_type: scope === 'shot' ? 'shot' : 'run',
      scope_id: scope === 'shot' ? targetShot.scope_id : '',
      payload: {
        scope,
        shot_id: targetShot.id == null ? null : String(targetShot.scope_id),
        mode: scope === 'shot'
          ? (nextPolicy.video_model_overrides?.[String(targetShot.scope_id)] ? 'fixed' : 'inherit')
          : nextPolicy.video_routing_mode,
        model: selectedRoute?.model || null,
        config_id: nextPolicy.video_config_id || null,
        previs_mode: selectedRoute?.previs_mode || null,
        reference_bundle_artifact_id: bundleResult?.artifact?.id || null,
        reference_bundle_refreshed: bundleResult?.state === 'refreshed',
        retry_action_id: retryAction?.id || null,
        superseded_action_ids: routeSupersessions.map((item) => item.previous.id),
        ambiguous_action_ids: routeSupersessions
          .filter((item) => item.outcome === 'ambiguous_external_create')
          .map((item) => item.previous.id),
        in_flight_action_ids: routeSupersessions
          .filter((item) => item.outcome === 'in_flight')
          .map((item) => item.previous.id),
        deferred_until_approval: !targetShotApproved,
        paid_submission: false,
      },
    });
    return {
      summary: repo.getRunSummary(db, run.id),
      routing: {
        ...routingPolicyState(updatedRun, targetShot.id == null ? null : targetShot),
        effective_route: publicRoutingReceipt(selectedRoute),
      },
      effects: {
        reference_bundle_refreshed: bundleResult?.state === 'refreshed',
        route_edit_deferred: !targetShotApproved,
        reference_bundle_artifact_id: bundleResult?.artifact?.id || null,
        retry_authorized: Boolean(retryAction),
        retry_action_id: retryAction?.id || null,
        superseded_action_ids: routeSupersessions.map((item) => item.previous.id),
        ambiguous_action_ids: routeSupersessions
          .filter((item) => item.outcome === 'ambiguous_external_create')
          .map((item) => item.previous.id),
        in_flight_action_ids: routeSupersessions
          .filter((item) => item.outcome === 'in_flight')
          .map((item) => item.previous.id),
        paid_submission: false,
      },
    };
  }

  function currentStageArtifacts(run) {
    const items = repo.listArtifacts(db, run.id, {
      stage: run.current_stage,
      current: true,
      page_size: 200,
    }).items;
    if (!isSequentialShotRun(run) || run.current_scope_id == null) return items;
    return items.filter((item) => (
      item.scope_type === 'shot' && item.scope_id === String(run.current_scope_id)
    ));
  }

  function currentStoryboardRevisionBlocker(run) {
    if (run.current_stage !== 'storyboard_plan'
      || !isSequentialShotRun(run)
      || run.current_scope_id == null) return null;
    const artifact = latestArtifact(
      db, run.id, 'storyboard_plan', 'shot', String(run.current_scope_id)
    );
    return artifact && ['rejected', 'invalidated', 'failed'].includes(artifact.status)
      ? artifact
      : null;
  }

  function completionForRun(run, artifacts = currentStageArtifacts(run)) {
    if (isDirectorDisabled(run) && ['director_plan', 'director_preview'].includes(run.current_stage)) {
      return { complete: true, unresolved: [] };
    }
    if (!isSequentialShotRun(run) || run.current_scope_id == null) {
      return repo.stageCompletion(db, run.id, run.current_stage);
    }
    if (!artifacts.length) {
      return {
        complete: false,
        unresolved: [{
          scope_type: 'shot',
          scope_id: String(run.current_scope_id),
          reason: 'missing_scoped_artifact',
          label: `Shot ${run.current_scope_id}`,
        }],
      };
    }
    const unresolved = artifacts
      .filter((artifact) => artifact.status !== 'approved')
      .map((artifact) => ({
        artifact_id: artifact.id,
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        reason: artifact.status,
        label: artifact.title,
      }));
    if (!unresolved.length && run.current_stage === 'storyboard_plan') {
      const shots = orderedShots(run);
      const currentIndex = shots.findIndex((item) => item.scope_id === String(run.current_scope_id));
      if (currentIndex > 0) {
        const previousVideo = approvedArtifacts(db, run.id, 'shot_video')
          .find((item) => item.scope_id === shots[currentIndex - 1].scope_id && item.content?.included !== false);
        const currentPlan = artifacts[0];
        if (!previousVideo || Number(currentPlan.content?.refined_from_video_artifact_id) !== Number(previousVideo.id)) {
          unresolved.push({
            artifact_id: currentPlan.id,
            scope_type: currentPlan.scope_type,
            scope_id: currentPlan.scope_id,
            reason: 'shot_plan_not_refined',
            label: currentPlan.title,
          });
        }
      }
    }
    return { complete: unresolved.length === 0, unresolved };
  }

  function transitionSequentialStage(run, input = {}, completion = completionForRun(run)) {
    if (!completion.complete) {
      const error = new Error('当前镜头阶段仍有未处理内容');
      error.code = 'STAGE_INCOMPLETE';
      error.details = completion;
      throw error;
    }
    const shots = currentPlannedShots(run);
    if (!shots.length) throw new Error('没有可制作的分镜');
    const currentScopeId = run.current_scope_id == null ? null : String(run.current_scope_id);
    const currentShot = currentScopeId == null
      ? null
      : shots.find((item) => item.scope_id === currentScopeId);
    let nextStage;
    let nextScopeId;
    let skippedStages = [];
    if (run.current_stage === 'storyboard_plan' && currentScopeId == null) {
      nextStage = 'storyboard_images';
      nextScopeId = shots[0].scope_id;
    } else if (run.current_stage === 'storyboard_plan') {
      nextStage = 'storyboard_images';
      nextScopeId = currentScopeId;
    } else if (run.current_stage === 'storyboard_images') {
      const route = classifyShotRoute(currentShot, run.policy);
      nextStage = route.requires_director_preview ? 'director_plan' : 'reference_bundle';
      nextScopeId = currentScopeId;
      if (!route.requires_director_preview) skippedStages = ['director_plan', 'director_preview'];
    } else if (run.current_stage === 'director_plan') {
      nextStage = isDirectorDisabled(run) ? 'reference_bundle' : 'director_preview';
      nextScopeId = currentScopeId;
      if (isDirectorDisabled(run)) skippedStages = ['director_plan', 'director_preview'];
    } else if (run.current_stage === 'director_preview') {
      nextStage = 'reference_bundle';
      nextScopeId = currentScopeId;
    } else if (run.current_stage === 'reference_bundle') {
      nextStage = 'shot_video';
      nextScopeId = currentScopeId;
    } else if (run.current_stage === 'shot_video') {
      const currentIndex = shots.findIndex((item) => item.scope_id === currentScopeId);
      if (currentIndex < 0) throw new Error(`Current shot ${currentScopeId} is not approved`);
      const nextShot = shots[currentIndex + 1];
      nextStage = nextShot ? 'storyboard_plan' : 'final_edit';
      nextScopeId = nextShot?.scope_id || null;
    } else {
      throw new Error(`Stage ${run.current_stage} is outside the sequential shot pipeline`);
    }
    const strategy = graph.normalizeNextStrategy(
      input.next_stage_strategy || (run.manual_next_default ? 'manual_add' : 'auto_generate')
    );
    const updated = repo.updateRun(db, run.id, {
      current_stage: nextStage,
      current_scope_type: nextScopeId == null ? null : 'shot',
      current_scope_id: nextScopeId,
      next_stage_strategy: strategy,
      status: strategy === 'manual_add' ? 'waiting_review' : 'running',
      waiting_reason: strategy === 'manual_add' ? 'manual_content_required' : null,
      error_code: null,
      error_message: null,
      runtime: {
        ...run.runtime,
        client_action_id: null,
        shot_pipeline: {
          ...(run.runtime?.shot_pipeline || {}),
          mode: 'sequential',
          current_shot_id: nextScopeId,
          last_completed_shot_id: run.current_stage === 'shot_video' ? currentScopeId : run.runtime?.shot_pipeline?.last_completed_shot_id || null,
        },
      },
    }, input.expected_version);
    repo.appendEvent(db, run.id, 'run.transitioned', {
      stage: nextStage,
      scope_type: nextScopeId == null ? null : 'shot',
      scope_id: nextScopeId,
      payload: {
        from: run.current_stage,
        to: nextStage,
        from_scope_id: currentScopeId,
        to_scope_id: nextScopeId,
        strategy,
        sequential: true,
        skipped_stages: skippedStages,
      },
    });
    for (const skippedStage of skippedStages) {
      repo.appendEvent(db, run.id, 'stage.skipped', {
        stage: skippedStage,
        scope_type: 'shot',
        scope_id: currentScopeId,
        payload: {
          reason: isDirectorDisabled(run) ? 'director_disabled_for_run' : 'shot_route_without_director_preview',
          route_profile: classifyShotRoute(currentShot, run.policy).profile,
          planned_duration: classifyShotRoute(currentShot, run.policy).planned_duration,
          duration: classifyShotRoute(currentShot, run.policy).duration,
          duration_adjusted: classifyShotRoute(currentShot, run.policy).duration_adjusted,
        },
      });
    }
    return { run: updated, next_stage: graph.getStage(nextStage), completion };
  }

  function currentApprovedSource(run, stage, artifactId) {
    const source = repo.getArtifact(db, artifactId);
    if (!source || source.run_id !== run.id || source.stage !== stage || source.status !== 'approved' || source.content?.included === false) {
      throw new Error(`请选择当前已确认的${graph.getStage(stage)?.label || stage}`);
    }
    const current = latestArtifact(db, run.id, stage, source.scope_type, source.scope_id);
    if (!current || current.id !== source.id) throw new Error('所选上游内容已有新修订，请刷新后重试');
    return source;
  }

  function requiredDependencies(run, stage) {
    if (stage === 'script') return approvedArtifacts(db, run.id, 'story_input');
    if (stage === 'asset_text') return approvedArtifacts(db, run.id, 'script');
    if (stage === 'storyboard_plan') {
      return [
        ...approvedArtifacts(db, run.id, 'script'),
        ...approvedArtifacts(db, run.id, 'asset_text').filter((item) => item.content?.included !== false),
      ];
    }
    return [];
  }

  async function validateArtifactForApproval(artifact) {
    if (!artifact || artifact.content?.included === false) return null;
    const content = artifact.content || {};
    if (artifact.stage === 'final_edit' && content.kind === 'narration_plan') {
      return finalEdit.validateNarrationArtifact(artifact);
    }
    if (artifact.stage === 'shot_video'
      && (content.provider_prompt_receipt?.status === 'truncated'
        || content.approval_blockers?.includes('PROVIDER_PROMPT_TRUNCATED'))) {
      const receipt = content.provider_prompt_receipt || {};
      throw new Error(
        `上游视频提示词被截断（提交 ${receipt.submitted_chars ?? '?'} 字符，上游保存 ${receipt.stored_chars ?? '?'} 字符），必须重新生成后才能批准`
      );
    }
    for (const field of Array.isArray(content.required_fields) ? content.required_fields : []) {
      const value = content[field];
      if (value == null || String(value).trim() === '') throw new Error(`${artifact.title || '当前内容'}的“${field}”不能为空`);
    }
    if (artifact.stage === 'script' && String(content.text || '').trim().length < 20) {
      throw new Error('剧本内容过短，无法进入资源提取');
    }
    if (artifact.stage === 'storyboard_plan') {
      const duration = Number(content.duration);
      if (!Number.isFinite(duration) || duration < 5 || duration > 15) throw new Error('即梦单镜头时长必须在 5 到 15 秒之间');
      const artifactRun = repo.getRun(db, artifact.run_id);
      const route = classifyShotRoute({ content }, artifactRun?.policy || {});
      if (content.route_profile && content.route_profile !== route.profile) {
        throw new Error(`${duration} 秒镜头应使用 ${route.profile === 'short_image_guided' ? '短镜头图片引导' : '长镜头导演台预演'}路线`);
      }
      const transitionMode = String(content.transition_mode || (Number(content.number) === 1 ? 'opening' : 'hard_cut'));
      if (!['opening', 'hard_cut', 'reference_continuation', 'strict_continuation'].includes(transitionMode)) {
        throw new Error('镜头衔接方式必须是开场、独立切镜、尾帧参考续接或严格首帧续拍');
      }
      if (Number(content.number) === 1 && transitionMode !== 'opening') throw new Error('第一镜必须使用开场衔接方式');
      if (!String(content.cut_in || '').trim() || !String(content.cut_out || '').trim() || !String(content.boundary_prompt || '').trim()) {
        throw new Error('镜头必须明确填写切入状态、切出状态和边界提示词');
      }
      if (transitionMode === 'hard_cut' && !String(content.cut_motivation || '').trim()) {
        throw new Error('硬切镜头必须写明可见的切镜依据');
      }
      if (transitionMode === 'strict_continuation') {
        if (!String(content.continuous_take_id || '').trim()) throw new Error('严格续拍必须填写连续镜头编号');
        // The selected model's first-frame support is advisory.  Keep the
        // editorial choice intact and let the provider return the actionable
        // capability error instead of blocking a user-selected model here.
      }
    }
    if (artifact.stage === 'director_plan') {
      const source = content.source_artifact_id ? repo.getArtifact(db, content.source_artifact_id) : null;
      const artifactRun = repo.getRun(db, artifact.run_id);
      director.normalizeDirectorDocument(
        content.document,
        source?.content?.duration || content.document?.timeline?.duration,
        artifactRun?.policy?.aspect_ratio
      );
    }
    if (artifact.stage === 'reference_bundle') {
      const images = Array.isArray(content.images) ? content.images : [];
      const videos = Array.isArray(content.videos) ? content.videos : [];
      const audios = Array.isArray(content.audios) ? content.audios : [];
      const source = content.source_artifact_id ? repo.getArtifact(db, content.source_artifact_id) : null;
      const artifactRun = repo.getRun(db, artifact.run_id);
      const classified = classifyShotRoute(
        source || { content: { duration: 5 } },
        artifactRun?.policy || {}
      );
      const route = content.routing_receipt
        ? { ...content.routing_receipt, ...classified }
        : classified;
      const limits = content.limits || route.limits || {};
      const warnings = [];
      if (!images.length) warnings.push('reference_image_missing');
      if (content.transition_mode === 'reference_continuation'
        && !images.some((item) => item.source === 'continuity_first_frame')) warnings.push('continuity_frame_missing');
      if (content.transition_mode === 'strict_continuation'
        && !images.some((item) => item.role === 'first_frame')) warnings.push('strict_first_frame_missing');
      if (route.uses_reference_video && !videos.length) warnings.push('reference_video_missing');
      if (!route.uses_reference_video && videos.length) warnings.push('reference_video_not_declared');
      if (Number.isFinite(Number(limits.images)) && images.length > Number(limits.images)) warnings.push('image_count_over_contract');
      if (Number.isFinite(Number(limits.videos)) && videos.length > Number(limits.videos)) warnings.push('video_count_over_contract');
      if (Number.isFinite(Number(limits.audios)) && audios.length > Number(limits.audios)) warnings.push('audio_count_over_contract');
      for (const item of [...images, ...videos, ...audios]) {
        if (!String(item?.path || '').trim()) throw new Error('参考包包含无效文件项');
      }
      // Store the advisory result on the value returned to callers.  Approval
      // remains successful; dispatch includes the same warnings in its
      // receipt so an upstream rejection can be fixed without losing the
      // user's model or media choices.
      return { reference_warnings: [...new Set(warnings)] };
    }
    if (graph.getStage(artifact.stage)?.media === 'image') {
      if (!artifact.media_path) throw new Error('缺少图片文件');
      return validateImage(artifact.media_path, { min_width: 128, min_height: 128 });
    }
    if (graph.getStage(artifact.stage)?.media === 'video') {
      if (!artifact.media_path) throw new Error('缺少视频文件');
      const receipt = await validateVideo(artifact.media_path, {});
      if (artifact.stage === 'final_edit' && (receipt.video_codec !== 'h264' || receipt.audio_codec !== 'aac')) {
        throw new Error('最终成片必须是 H.264 视频和 AAC 音频');
      }
      return receipt;
    }
    return null;
  }

  async function runTextAction(run, descriptor) {
    if (!descriptor.prompt_id) throw new Error(`文本 action ${descriptor.stage} 缺少 prompt_id`);
    const resolvedPrompt = promptRuntime.resolvePair(db, descriptor.prompt_id, descriptor.prompts, {
      variables: descriptor.prompt_variables,
      additional_locked_suffix: descriptor.additional_locked_suffix,
    });
    const basePrompts = resolvedPrompt.prompts;
    const sceneKey = descriptor.scene_key || `production_${descriptor.stage}`;
    const maxTokens = descriptor.max_tokens || 8000;
    const attempt = actionAttempt(db, run.id, descriptor.stage, descriptor.scope_id);
    const actionKey = generationKey(descriptor.stage, descriptor.scope_id, attempt);
    const cost = accounting.textReservation(db, run, {
      system: basePrompts.system,
      user: basePrompts.user,
      model: descriptor.model || undefined,
      scene_key: sceneKey,
      max_tokens: maxTokens * (descriptor.repair_on_normalize_error ? 2 : 1),
    });
    const reservation = repo.reserveAction(db, {
      run_id: run.id,
      action_key: actionKey,
      stage: descriptor.stage,
      scope_type: descriptor.scope_type,
      scope_id: descriptor.scope_id,
      kind: descriptor.kind || 'text_generate',
      attempt,
      request: {
        prompt_hash: resolvedPrompt.receipt.combined_hash,
        prompt_snapshot: resolvedPrompt.receipt,
        model: cost.model || descriptor.model || null,
        provider: cost.provider || null,
        scene_key: sceneKey,
      },
      cost,
    });
    const action = reservation.action;
    if (reservation.reused && action.status === 'completed' && action.result) {
      return action.result.__text_action_result || action.result;
    }
    if (reservation.reused && ['submitted', 'waiting', 'reserved'].includes(action.status)) {
      return { waiting: true, action_id: action.id };
    }
    if (reservation.reused && ['failed', 'ambiguous'].includes(action.status)) {
      const error = new Error(action.error_message || '上一次生成失败，请明确重试');
      error.code = action.status === 'ambiguous' ? 'AMBIGUOUS_ACTION' : 'ACTION_FAILED';
      throw error;
    }
    repo.updateAction(db, action.id, { status: 'submitted' });
    const normalizationRepairLimit = descriptor.repair_on_normalize_error ? 1 : 0;
    let normalizationRepairAttempts = 0;
    let result;
    const providerOutputs = [];
    try {
      while (true) {
        const prompts = normalizationRepairAttempts === 0
          ? basePrompts
          : (() => {
            const validationError = String(result?.normalization_error || '').slice(0, 1200);
            const repair = promptRegistry.resolveRuntime(db, 'production.normalization_repair.suffix', {
              default_content: `VALIDATION REPAIR: The previous JSON response failed local validation. Return one corrected JSON object only, with no Markdown or explanation. Fix only this bounded validator error: ${validationError}`,
              variables: { validation_error: validationError },
            });
            return {
              system: `${basePrompts.system}\n\n${repair.content}`,
              user: `${basePrompts.user}\n\nThe previous JSON failed local validation. Correct the JSON and return the complete object again. Validator error: ${validationError}`,
            };
          })();
        let raw;
        try {
          raw = await adapters.generateText(prompts.user, prompts.system, {
            model: descriptor.model || undefined,
            temperature: descriptor.temperature == null ? 0.65 : descriptor.temperature,
            max_tokens: maxTokens,
            scene_key: sceneKey,
          });
          providerOutputs.push(String(raw || ''));
        } catch (error) {
          throw error;
        }
        try {
          result = descriptor.normalize(raw);
          break;
        } catch (error) {
          if (normalizationRepairAttempts >= normalizationRepairLimit) throw error;
          normalizationRepairAttempts += 1;
          result = { normalization_error: error.message };
        }
      }
      const persistedResult = {
        __text_action_result: result,
        normalization_repair_attempts: normalizationRepairAttempts,
        prompt_receipt: resolvedPrompt.receipt,
      };
      repo.updateAction(db, action.id, {
        status: 'completed',
        result: persistedResult,
        cost: accounting.textSettlement(db, action.id, {
          system: basePrompts.system,
          user: basePrompts.user,
          output: providerOutputs.join('\n'),
        }),
      });
      return result;
    } catch (error) {
      repo.updateAction(db, action.id, {
        status: 'failed', error_code: error.code || 'AI_GENERATION_FAILED', error_message: error.message,
        ...(providerOutputs.length ? {
          cost_status: 'settled',
          cost: accounting.textSettlement(db, action.id, {
            system: basePrompts.system, user: basePrompts.user, output: providerOutputs.join('\n'),
          }),
        } : {}),
      });
      throw error;
    }
  }

  const shotOperations = createProductionShotService(db, { runTextAction });

  function createGeneratedArtifact(run, input) {
    return repo.createArtifact(db, {
      run_id: run.id,
      stage: input.stage,
      scope_type: input.scope_type,
      scope_id: input.scope_id,
      title: input.title,
      content: input.content,
      status: 'draft',
      source_action_id: input.source_action_id,
      depends_on: input.depends_on || [],
    });
  }

  function automationScope(run, input = {}) {
    const artifact = input.artifact || null;
    const action = input.action || null;
    const source = input.source || null;
    return {
      stage: String(input.stage || artifact?.stage || action?.stage || run.current_stage || 'unknown'),
      scope_type: String(input.scope_type || artifact?.scope_type || action?.scope_type || source?.scope_type || run.current_scope_type || 'run'),
      scope_id: input.scope_id ?? artifact?.scope_id ?? action?.scope_id ?? source?.scope_id ?? run.current_scope_id ?? '',
    };
  }

  function latestFailureAction(run, input = {}) {
    if (input.action) return input.action;
    const failedRecord = (input.failures || []).find((item) => item?.action)?.action;
    if (failedRecord) return failedRecord;
    const failedListed = (input.actions || []).find((item) => ['failed', 'ambiguous'].includes(item?.status));
    if (failedListed) return failedListed;
    const scope = automationScope(run, input);
    const action = repo.getLatestAction(db, run.id, {
      stage: scope.stage,
      scope_type: scope.scope_type,
      scope_id: scope.scope_id,
    });
    return action && ['failed', 'ambiguous'].includes(action.status) ? action : null;
  }

  function persistAutonomyAttempt(run, input = {}) {
    const scope = automationScope(run, input);
    const recorded = autonomy.recordAttempt(run, { ...scope, ...input });
    const updatedRun = repo.updateRun(db, run.id, { runtime: recorded.runtime });
    repo.appendEvent(db, run.id, 'automation.attempt_recorded', {
      ...scope,
      payload: {
        object_key: recorded.key,
        kind: input.kind === 'review' ? 'review' : 'generation',
        count: recorded.count,
        limit: recorded.limit,
        decision: input.decision || null,
        error_code: autonomy.sanitizeFailureText(input.error_code || input.code, 120) || null,
        action: autonomy.sanitizeFailureText(input.action_name || input.action, 120) || null,
      },
    });
    return { ...recorded, run: updatedRun, scope };
  }

  function escalateAutonomy(recorded, input = {}) {
    const runtime = JSON.parse(JSON.stringify(recorded.run.runtime || {}));
    const objects = runtime.autonomy?.objects || {};
    const object = objects[recorded.key] || recorded.object || {};
    object.escalated = true;
    object.escalation_reason = input.reason || object.escalation_reason || 'automation_limit_reached';
    objects[recorded.key] = object;
    const summary = autonomy.escalationSummary(object);
    runtime.autonomy = {
      ...(runtime.autonomy || {}),
      objects,
      intervention: {
        object_key: recorded.key,
        stage: recorded.scope.stage,
        scope_type: recorded.scope.scope_type,
        scope_id: String(recorded.scope.scope_id ?? ''),
        reason: object.escalation_reason,
        summary,
        created_at: new Date().toISOString(),
      },
    };
    const run = repo.updateRun(db, recorded.run.id, {
      runtime,
      status: 'waiting_review',
      waiting_reason: input.waiting_reason || object.escalation_reason,
      error_code: input.error_code || 'AUTOMATION_LIMIT_REACHED',
      error_message: input.error_message || summary.reason,
    });
    repo.appendEvent(db, run.id, 'automation.escalated', {
      ...recorded.scope,
      payload: runtime.autonomy.intervention,
    });
    return { state: 'waiting_review', reason: run.waiting_reason, intervention: summary, run };
  }

  function clearAutonomyObject(run, artifact) {
    const scope = automationScope(run, { artifact });
    const key = autonomy.objectKey(scope);
    const runtime = autonomy.clearObject(run, scope);
    if (runtime.autonomy?.intervention?.object_key === key) delete runtime.autonomy.intervention;
    return repo.updateRun(db, run.id, { runtime, status: 'running', waiting_reason: null, error_code: null, error_message: null });
  }

  function resolvedAutonomyRuntime(run, scope) {
    const normalizedScope = automationScope(run, scope);
    const key = autonomy.objectKey(normalizedScope);
    const hasObject = Boolean(autonomy.objectState(run, normalizedScope));
    const ownsIntervention = run.runtime?.autonomy?.intervention?.object_key === key;
    if (!hasObject && !ownsIntervention) return null;
    const runtime = autonomy.clearObject(run, normalizedScope);
    if (runtime.autonomy?.intervention?.object_key === key) delete runtime.autonomy.intervention;
    return runtime;
  }

  function reviewModelCandidates(run) {
    const candidates = [];
    const add = (value) => {
      const model = String(value || '').trim();
      if (model && !candidates.includes(model)) candidates.push(model);
    };
    add(run.review_profile?.model);
    try {
      const configs = db.prepare(
        `SELECT default_model, model FROM ai_service_configs
          WHERE deleted_at IS NULL AND is_active = 1 AND service_type = 'text'
          ORDER BY is_default DESC, priority DESC, id ASC`
      ).all();
      for (const config of configs) {
        add(config.default_model);
        const models = repo.parseJson(config.model, config.model || []);
        if (Array.isArray(models)) models.forEach(add);
        else add(models);
      }
    } catch (_) {}
    return candidates.length ? candidates.slice(0, 4) : [undefined];
  }

  async function diagnoseAutomationFailure(run, recorded, failure, failedAction) {
    const rawPrompts = autonomy.diagnosticPrompts({
      ...recorded.scope,
      code: failure.code,
      message: failure.message,
      model: failedAction?.request?.model || failedAction?.request?.routing_receipt?.model || null,
      attempt: recorded.count,
      allow_model_switch: failure.allow_model_switch && run.policy?.allow_auto_model_switch !== false,
    });
    const resolvedPrompt = promptRuntime.resolvePair(
      db, 'production.automation_diagnosis.system', rawPrompts
    );
    const prompts = resolvedPrompt.prompts;
    const sceneKey = 'production_automation_diagnosis';
    const cost = accounting.textReservation(db, run, {
      ...prompts, model: run.review_profile?.model || undefined, scene_key: sceneKey, max_tokens: 900,
    });
    const attempt = repo.nextActionAttempt(
      db, run.id, recorded.scope.stage, recorded.scope.scope_type, recorded.scope.scope_id, 'automation_diagnosis'
    );
    const reservation = repo.reserveAction(db, {
      run_id: run.id,
      action_key: `${recorded.scope.stage}:diagnose:${recorded.scope.scope_type}:${recorded.scope.scope_id}:a${attempt}`,
      stage: recorded.scope.stage,
      scope_type: recorded.scope.scope_type,
      scope_id: recorded.scope.scope_id,
      kind: 'automation_diagnosis',
      attempt,
      request: {
        failure_code: failure.code,
        failure_category: failure.category,
        source_action_id: failedAction?.id || null,
        sanitized_message: failure.message,
        prompt_snapshot: resolvedPrompt.receipt,
        model: cost.model || null,
        provider: cost.provider || null,
      },
      cost,
    });
    if (reservation.reused && reservation.action.status === 'completed') return reservation.action.result;
    repo.updateAction(db, reservation.action.id, { status: 'submitted' });
    try {
      const raw = await adapters.generateText(prompts.user, prompts.system, {
        model: run.review_profile?.model || undefined,
        temperature: 0.1,
        max_tokens: 900,
        scene_key: sceneKey,
      });
      const diagnosis = autonomy.normalizeDiagnosis(raw, {
        allow_model_switch: failure.allow_model_switch,
        reason: failure.message,
      });
      repo.updateAction(db, reservation.action.id, {
        status: 'completed',
        result: { ...diagnosis, prompt_receipt: resolvedPrompt.receipt },
        cost: accounting.textSettlement(db, reservation.action.id, { ...prompts, output: raw }),
      });
      return diagnosis;
    } catch (error) {
      const safeError = autonomy.sanitizeFailureText(error.message, 800);
      repo.updateAction(db, reservation.action.id, {
        status: 'failed', error_code: error.code || 'AUTOMATION_DIAGNOSIS_FAILED', error_message: safeError,
      });
      return {
        ...autonomy.normalizeDiagnosis(null, {
          allow_model_switch: failure.allow_model_switch,
          reason: failure.message,
        }),
        diagnostic_error: safeError,
        fallback: true,
      };
    }
  }

  async function reviseArtifactAutomatically(run, artifact, reason, sourceDecision, actionSuffix = '') {
    const textRewriteStages = new Set(['script', 'asset_text', 'storyboard_plan']);
    const isNarrationPlan = artifact.stage === 'final_edit' && artifact.content?.kind === 'narration_plan';
    if (textRewriteStages.has(artifact.stage) || isNarrationPlan) {
      const suggestion = await suggestArtifact(artifact.id, {
        instruction: `根据自动审批或校验意见重写并修复，保持原 JSON 字段结构。修改意见：${reason}`,
        reason,
        model: run.review_profile?.model || undefined,
        action_key: `automatic-${artifact.id}-${actionSuffix || artifact.revision}`,
      });
      const replacement = repo.editArtifact(db, artifact.id, { content: suggestion.candidate });
      repo.appendEvent(db, run.id, 'automation.artifact_revised', {
        stage: artifact.stage, scope_type: artifact.scope_type, scope_id: artifact.scope_id,
        payload: {
          source_artifact_id: artifact.id,
          replacement_artifact_id: replacement.id,
          source_decision: sourceDecision || null,
          reason: autonomy.sanitizeFailureText(reason, 800),
        },
      });
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
      return { state: 'progressed', reason: 'ai_revised', artifacts: [replacement], artifact: replacement };
    }
    const queued = repo.queueArtifactRevision(db, artifact.id, { reason, source_decision: sourceDecision });
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return { state: 'progressed', reason: 'ai_regenerate', artifacts: [queued], artifact: queued };
  }

  async function tryAutomaticVideoModelSwitch(run, recorded, failedAction, diagnosis, failure = {}) {
    if (recorded.scope.stage !== 'shot_video'
      || run.policy?.allow_auto_model_switch === false) return null;
    const preferences = automationPreferences.get(db);
    const moderationFallbackAuthorized = failure.category === 'content_moderation_failure'
      && preferences.moderation_fallback_enabled === true
      && Boolean(String(preferences.moderation_fallback_model || '').trim());
    if (diagnosis.action !== 'switch_model' && !moderationFallbackAuthorized) return null;
    const shot = routingShot(run, recorded.scope.scope_id, true);
    const options = await media.listVideoRoutingOptions(run, shot);
    const attemptedModels = new Set(
      (recorded.object?.attempts || []).map((item) => String(item.model || '').trim()).filter(Boolean)
    );
    const failedModel = String(failedAction?.request?.model || failedAction?.request?.routing_receipt?.model || '').trim();
    if (failedModel) attemptedModels.add(failedModel);
    const selectable = (options.options || []).filter((option) => (
      // Manual selection is intentionally permissive.  Unattended switching
      // still requires a locally evidenced compatible candidate.
      option.compatible === true
      && !attemptedModels.has(option.model)
    ));
    const requestedFallback = String(preferences.moderation_fallback_model || '').trim();
    const preferred = moderationFallbackAuthorized
      ? selectable.find((option) => option.model.toLowerCase() === requestedFallback.toLowerCase()) || null
      : null;
    const candidates = selectable.filter((option) => (
      !option.requires_explicit_confirmation || run.policy?.allow_expensive_bypass === true
    )).sort((left, right) => {
      const leftPrice = Number.isFinite(Number(left.estimated_price)) ? Number(left.estimated_price) : Number.MAX_SAFE_INTEGER;
      const rightPrice = Number.isFinite(Number(right.estimated_price)) ? Number(right.estimated_price) : Number.MAX_SAFE_INTEGER;
      return leftPrice - rightPrice || String(left.model).localeCompare(String(right.model));
    });
    const candidate = preferred || candidates[0];
    if (!candidate) return null;
    const fallbackAuthorized = preferred?.model === candidate.model;
    const switchReceipt = {
      trigger_category: failure.category || 'provider_or_content_failure',
      requested_fallback_model: moderationFallbackAuthorized ? requestedFallback : null,
      selected_model: candidate.model,
      designated_fallback_used: fallbackAuthorized,
      expensive_model_authorized: fallbackAuthorized && candidate.requires_explicit_confirmation === true,
      settings_snapshot: {
        moderation_fallback_enabled: preferences.moderation_fallback_enabled,
        moderation_fallback_model: preferences.moderation_fallback_model,
      },
    };
    repo.updateAction(db, failedAction.id, {
      result: { ...(failedAction.result || {}), automatic_diagnosis: diagnosis, automatic_model_switch: switchReceipt },
    });
    const liveRun = repo.getRun(db, run.id);
    const changed = await updateVideoRouting(run.id, {
      expected_version: liveRun.version,
      scope: 'shot',
      shot_id: shot.scope_id,
      mode: 'fixed',
      model: candidate.model,
      confirm_expensive: candidate.requires_explicit_confirmation
        && (fallbackAuthorized || liveRun.policy?.allow_expensive_bypass === true),
      authorize_retry: failedAction.status === 'failed',
      retry_reason: diagnosis.correction || '自动诊断后切换兼容视频模型',
    });
    repo.appendEvent(db, run.id, 'automation.video_model_switched', {
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
      payload: {
        from_model: failedModel || null,
        to_model: candidate.model,
        source_action_id: failedAction.id,
        estimated_price: candidate.estimated_price,
        high_price_authorized: candidate.requires_explicit_confirmation === true,
        trigger_category: failure.category || null,
        fallback_authorized: fallbackAuthorized,
        settings_snapshot: switchReceipt.settings_snapshot,
      },
    });
    return {
      state: 'progressed',
      reason: fallbackAuthorized ? 'automatic_moderation_fallback_switched' : 'automatic_model_switched',
      routing: changed.routing,
      effects: changed.effects,
      switch_receipt: switchReceipt,
    };
  }

  async function recoverAutomationFailure(run, input = {}) {
    const liveRun = repo.getRun(db, run.id) || run;
    if (liveRun.review_owner === 'human') return null;
    const failedAction = latestFailureAction(liveRun, input);
    const code = input.code || input.error_code || failedAction?.error_code || input.error?.code || 'AUTOMATION_FAILURE';
    const message = input.message || input.error_message || failedAction?.error_message || input.error?.message || input.reason || '自动流程遇到未分类失败';
    const failure = autonomy.classifyFailure({
      code,
      message,
      stage: automationScope(liveRun, { ...input, action: failedAction }).stage,
    });
    if (failure.category === 'configuration_binding_failure' && failedAction?.status === 'failed') {
      const generation = failedAction.generation_id
        ? videoService.getById(db, failedAction.generation_id)
        : null;
      const configId = Number(
        failedAction.request?.video_config_id
        || liveRun.policy?.video_config_id
        || generation?.video_config_id
        || generation?.provider_config_snapshot?.config_id
        || 0
      );
      const config = Number.isSafeInteger(configId) && configId > 0
        ? aiConfigService.getConfig(db, configId)
        : null;
      if (config && config.service_type === 'video' && config.is_active !== false) {
        repo.updateAction(db, failedAction.id, {
          status: 'cancelled',
          result: {
            ...(failedAction.result || {}),
            retry_authorized: true,
            retry_reason: '已确认视频配置仍有效；按修复后的绑定规则重试同一模型',
            retry_authorized_by: 'production_autonomy',
            stale_config_binding_recovered: true,
            video_config_id: configId,
          },
        });
        repo.updateRun(db, liveRun.id, {
          policy: { ...(liveRun.policy || {}), video_config_id: configId },
          status: 'running', waiting_reason: null, error_code: null, error_message: null,
        });
        repo.appendEvent(db, liveRun.id, 'automation.video_config_binding_recovered', {
          ...automationScope(liveRun, { ...input, action: failedAction }),
          payload: {
            action_id: failedAction.id,
            generation_id: failedAction.generation_id || null,
            video_config_id: configId,
            model: failedAction.request?.model || null,
            paid_submission: false,
          },
        });
        return { state: 'progressed', reason: 'video_config_binding_recovered', paid_submission: false };
      }
    }
    if (failure.counts_as_failure === false) {
      const scope = automationScope(liveRun, input);
      const runtime = resolvedAutonomyRuntime(liveRun, scope) || liveRun.runtime;
      const healed = repo.updateRun(db, liveRun.id, {
        runtime,
        status: 'running', waiting_reason: null, error_code: null, error_message: null,
      });
      repo.appendEvent(db, healed.id, 'automation.workflow_converged', {
        ...scope,
        payload: { code: failure.code, reason: failure.message || message },
      });
      return { state: 'progressed', reason: 'workflow_converged', run: healed };
    }
    const recorded = persistAutonomyAttempt(liveRun, {
      ...automationScope(liveRun, { ...input, action: failedAction }),
      kind: input.kind === 'review' ? 'review' : 'generation',
      decision: input.decision,
      error_code: failure.code,
      reason: failure.message || message,
      model: failedAction?.request?.model || failedAction?.request?.routing_receipt?.model || null,
      action_name: input.action_name || (failure.recoverable ? 'diagnose_and_retry' : 'stop'),
      force_escalate: !failure.recoverable,
      escalation_reason: failure.stop_reason,
    });
    if (!failure.recoverable) {
      return escalateAutonomy(recorded, {
        reason: failure.stop_reason,
        waiting_reason: failure.stop_reason,
        error_code: failure.code,
        error_message: failure.message || message,
      });
    }

    let diagnosis = await diagnoseAutomationFailure(recorded.run, recorded, failure, failedAction);
    if (diagnosis.action === 'stop' && !recorded.exhausted) {
      diagnosis = {
        ...diagnosis,
        requested_action: 'stop',
        action: failure.allow_model_switch ? 'switch_model' : 'retry_same_model',
        stop_deferred_until_limit: true,
      };
    }
    if (failedAction) {
      repo.updateAction(db, failedAction.id, {
        result: { ...(failedAction.result || {}), automatic_diagnosis: diagnosis },
      });
    }
    if (recorded.exhausted) {
      return escalateAutonomy(recorded, {
        reason: 'automation_limit_reached',
        waiting_reason: 'automation_limit_reached',
        error_code: 'AUTOMATION_LIMIT_REACHED',
        error_message: diagnosis.correction || failure.message || message,
      });
    }

    if (input.artifact) {
      try {
        return await reviseArtifactAutomatically(
          recorded.run, input.artifact, diagnosis.correction || failure.message || message, input.decision || 'validation_failed', `recovery-${recorded.count}`
        );
      } catch (error) {
        const revisionAction = latestFailureAction(repo.getRun(db, run.id), {
          stage: input.artifact.stage,
          scope_type: input.artifact.scope_type,
          scope_id: input.artifact.scope_id,
        });
        if (revisionAction?.status === 'failed') {
          repo.updateAction(db, revisionAction.id, {
            status: 'cancelled',
            result: {
              ...(revisionAction.result || {}),
              retry_authorized: true,
              retry_reason: autonomy.sanitizeFailureText(error.message, 800),
              retry_authorized_by: 'production_autonomy',
            },
          });
        }
        repo.updateRun(db, run.id, {
          status: 'running', waiting_reason: null,
          error_code: error.code || 'AUTOMATIC_REVISION_FAILED',
          error_message: autonomy.sanitizeFailureText(error.message, 1200),
        });
        return {
          state: 'progressed',
          reason: 'automatic_revision_retry_scheduled',
          action: revisionAction,
          diagnosis,
        };
      }
    }

    if (failedAction?.status === 'failed') {
      try {
        const switched = await tryAutomaticVideoModelSwitch(recorded.run, recorded, failedAction, diagnosis, failure);
        if (switched) return switched;
      } catch (switchError) {
        log.warn('Automatic video model switch failed; retrying the explicit failed action when safe', {
          run_id: run.id,
          action_id: failedAction.id,
          error: autonomy.sanitizeFailureText(switchError.message, 500),
        });
      }
      repo.updateAction(db, failedAction.id, {
        status: 'cancelled',
        result: {
          ...(failedAction.result || {}),
          automatic_diagnosis: diagnosis,
          retry_authorized: true,
          retry_reason: diagnosis.correction || failure.message || '自动诊断后重试',
          retry_authorized_by: 'production_autonomy',
        },
      });
      repo.appendEvent(db, run.id, 'action.retry_authorized', {
        ...recorded.scope,
        payload: {
          action_id: failedAction.id,
          reason: diagnosis.correction || failure.message,
          source: 'production_autonomy',
        },
      });
    }
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return { state: 'progressed', reason: 'automatic_recovery_scheduled', diagnosis };
  }

  async function prepareAiReview(run, artifact, prompts) {
    const attempt = repo.nextActionAttempt(
      db, run.id, artifact.stage, artifact.scope_type, artifact.scope_id, 'ai_review'
    );
    let evidence = null;
    try {
      evidence = await prepareReviewEvidence(artifact);
      const resolvedBase = promptRuntime.resolvePair(db, 'production.review.system', prompts);
      let effectiveUser = resolvedBase.prompts.user;
      let visualPromptReceipt = null;
      if (evidence) {
        const evidenceDescription = evidence.receipt.kind === 'source_image'
          ? '附图是当前待审原图。'
          : `附图从左到右依次为视频首段、中段、尾段代表帧，抽帧时间为 ${JSON.stringify(evidence.receipt.sampled_at_seconds)} 秒。`;
        const defaultVisualSuffix = `视觉证据：${evidenceDescription} 只把附图中明确可见且会阻断后续制作的问题列为 blocking issue。抽帧覆盖有限、局部看不清或审美仍可优化时不得转人工：没有明确阻断就 approved；可以通过重新生成解决的问题则 rejected。只有媒体缺失、损坏或必须由人授权/核对外部事实时才 needs_human。`;
        const visualResolved = promptRegistry.resolveRuntime(db, 'production.visual_review.suffix', {
          default_content: defaultVisualSuffix,
          variables: { evidence_description: evidenceDescription },
        });
        effectiveUser = `${effectiveUser}\n${visualResolved.content}`;
        visualPromptReceipt = {
          prompt_id: visualResolved.id,
          prompt_version: visualResolved.version,
          customized: visualResolved.customized,
          content_hash: visualResolved.content_hash,
          content: visualResolved.content,
        };
      }
      const effectivePrompts = { system: resolvedBase.prompts.system, user: effectiveUser };
      const sceneKey = evidence ? 'production_visual_review' : 'production_review';
      const candidateModels = evidence ? reviewModelCandidates(run) : [run.review_profile?.model || undefined];
      const cost = accounting.textReservation(db, run, {
        ...effectivePrompts,
        model: candidateModels[0],
        scene_key: sceneKey,
        max_tokens: (evidence ? 1400 : 1200) * Math.max(1, candidateModels.length),
      });
      const reservation = repo.reserveAction(db, {
        run_id: run.id,
        action_key: `${artifact.stage}:review:${artifact.id}:a${attempt}`,
        stage: artifact.stage,
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        kind: 'ai_review',
        attempt,
        request: {
          artifact_id: artifact.id,
          criteria: run.review_profile,
          visual_evidence: evidence?.receipt || null,
          prompt_snapshot: resolvedBase.receipt,
          visual_prompt_snapshot: visualPromptReceipt,
          model: cost.model || null,
          provider: cost.provider || null,
        },
        cost,
      });
      if (reservation.reused && reservation.action.status === 'completed') {
        try { evidence?.cleanup?.(); } catch (_) {}
        return { verdict: reservation.action.result, action: reservation.action, evidence: evidence?.receipt || null };
      }
      if (reservation.reused && ['submitted', 'waiting'].includes(reservation.action.status)) {
        try { evidence?.cleanup?.(); } catch (_) {}
        return { waiting: true, action: reservation.action, evidence: evidence?.receipt || null };
      }
      const submittedAction = repo.updateAction(db, reservation.action.id, { status: 'submitted' });
      return {
        prepared: true,
        artifact,
        prompts,
        evidence,
        effectivePrompts,
        resolvedBase,
        visualPromptReceipt,
        submittedAction,
      };
    } catch (error) {
      try { evidence?.cleanup?.(); } catch (_) {}
      return { error, action: error.reviewAction || null, evidence: evidence?.receipt || null };
    }
  }

  async function executePreparedAiReview(run, prepared, options = {}) {
    if (!prepared?.prepared) return prepared;
    const {
      evidence, effectivePrompts, resolvedBase, visualPromptReceipt, submittedAction,
    } = prepared;
    const effectiveUser = effectivePrompts.user;
    try {
      try {
        let raw;
        let reviewModel = run.review_profile?.model || null;
        if (evidence) {
          const visualUser = effectiveUser;
          let lastError = null;
          for (const candidate of reviewModelCandidates(run)) {
            try {
              raw = await adapters.generateTextWithVision(visualUser, resolvedBase.prompts.system, evidence.imageSource, {
                temperature: 0.1,
                max_tokens: 1400,
                scene_key: 'production_visual_review',
                model: candidate,
              });
              reviewModel = candidate || null;
              break;
            } catch (error) { lastError = error; }
          }
          if (raw == null) throw lastError || new Error('没有可用的多模态审核模型');
        } else {
          raw = await adapters.generateText(effectiveUser, resolvedBase.prompts.system, {
            temperature: 0.1,
            max_tokens: 1200,
            scene_key: 'production_review',
            model: run.review_profile?.model || undefined,
          });
        }
        const verdict = { ...textStages.normalizeReview(raw, log), review_model: reviewModel };
        const persistedResult = {
          ...verdict,
          visual_evidence: evidence?.receipt || null,
          prompt_receipt: resolvedBase.receipt,
          visual_prompt_receipt: visualPromptReceipt,
        };
        const settlement = accounting.textSettlement(db, submittedAction.id, { ...effectivePrompts, output: raw });
        if (options.defer_persistence === true) {
          return {
            verdict,
            action: submittedAction,
            evidence: evidence?.receipt || null,
            deferred_persistence: { status: 'completed', result: persistedResult, cost: settlement },
          };
        }
        const action = repo.updateAction(db, submittedAction.id, {
          status: 'completed', result: persistedResult, cost: settlement,
        });
        return { verdict, action, evidence: evidence?.receipt || null };
      } catch (error) {
        const failurePatch = {
          status: 'failed',
          error_code: error.code || 'AI_REVIEW_FAILED',
          error_message: autonomy.sanitizeFailureText(error.message, 1200),
        };
        if (options.defer_persistence === true) {
          return {
            error,
            action: submittedAction,
            evidence: evidence?.receipt || null,
            deferred_persistence: failurePatch,
          };
        }
        error.reviewAction = repo.updateAction(db, submittedAction.id, failurePatch);
        throw error;
      }
    } finally {
      try { evidence?.cleanup?.(); } catch (_) {}
    }
  }

  async function executeAiReview(run, artifact, prompts, options = {}) {
    const prepared = await prepareAiReview(run, artifact, prompts);
    return executePreparedAiReview(run, prepared, options);
  }

  function persistDeferredAiReview(reviewResult) {
    const patch = reviewResult?.deferred_persistence;
    if (!patch || !reviewResult?.action?.id) return reviewResult;
    const action = repo.updateAction(db, reviewResult.action.id, patch);
    if (reviewResult.error) reviewResult.error.reviewAction = action;
    return { ...reviewResult, action, deferred_persistence: undefined };
  }

  async function applyReviewPolicy(run, artifacts) {
    if (run.review_owner === 'human') {
      repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'stage_review' });
      return { state: 'waiting_review', artifacts };
    }

    const reviewed = [];
    const aiCandidates = [];
    for (const artifact of artifacts) {
      if (artifact.status === 'approved') { reviewed.push(artifact); continue; }
      try {
        await validateArtifactForApproval(artifact);
      } catch (error) {
        return recoverAutomationFailure(repo.getRun(db, run.id), {
          artifact,
          error,
          error_code: error.code || 'ARTIFACT_VALIDATION_FAILED',
          action_name: 'repair_invalid_artifact',
        });
      }

      const deterministicOnly = run.review_owner === 'auto_accept' || graph.getStage(artifact.stage)?.subjective === false;
      if (deterministicOnly) {
        const outcome = repo.reviewArtifact(db, artifact.id, {
          reviewer_type: 'deterministic', decision: 'approved',
          reason: run.review_owner === 'auto_accept'
            ? '全自动模式：主观审批自动通过；结构、媒体、引用与编码校验已执行'
            : '确定性阶段校验通过',
        });
        reviewed.push(outcome.artifact);
        run = clearAutonomyObject(repo.getRun(db, run.id), outcome.artifact);
        continue;
      }

      const priorReviews = repo.listReviews(db, run.id, {
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        page_size: 20,
      }).items.filter((item) => Number(item.artifact_id) !== Number(artifact.id));
      const prompts = textStages.reviewPrompts(artifact, {
        ...(run.review_profile || {}),
        previous_reviews: priorReviews,
      });
      aiCandidates.push({ artifact, prompts });
    }

    const parallelStages = new Set(['asset_text', 'asset_images']);
    const mayRunInParallel = aiCandidates.length > 1
      && aiCandidates.every((item) => parallelStages.has(item.artifact.stage));
    const reviewConcurrency = mayRunInParallel
      ? automationPreferences.get(db).review_concurrency
      : 1;
    const preparedReviews = [];
    for (const { artifact, prompts } of aiCandidates) {
      preparedReviews.push(await prepareAiReview(run, artifact, prompts));
    }
    const rawReviewResults = await mapWithConcurrency(
      preparedReviews,
      reviewConcurrency,
      async (prepared) => {
        try {
          return await executePreparedAiReview(run, prepared, { defer_persistence: true });
        } catch (error) {
          return {
            error,
            action: error.reviewAction || prepared?.submittedAction || null,
            evidence: prepared?.evidence?.receipt || prepared?.evidence || null,
          };
        }
      }
    );
    const followups = [];
    for (let index = 0; index < aiCandidates.length; index++) {
      const { artifact, prompts } = aiCandidates[index];
      const reviewResult = persistDeferredAiReview(rawReviewResults[index]);
      if (reviewResult.error) {
        followups.push({ type: 'error', artifact, reviewResult });
        continue;
      }
      if (reviewResult.waiting) {
        followups.push({ type: 'waiting', artifact, reviewResult });
        continue;
      }
      const verdict = reviewResult.verdict;
      const outcome = repo.reviewArtifact(db, artifact.id, {
        reviewer_type: 'ai',
        decision: verdict.decision,
        reason: verdict.reason,
        confidence: verdict.confidence,
        scores: verdict.scores,
        criteria_version: run.review_profile?.version || 'default-v1',
        prompt_snapshot: prompts.system,
        evidence: reviewResult.evidence || {},
      });
      reviewed.push(outcome.artifact);
      if (verdict.decision === 'approved') {
        run = clearAutonomyObject(repo.getRun(db, run.id), outcome.artifact);
        continue;
      }

      const recorded = persistAutonomyAttempt(repo.getRun(db, run.id), {
        artifact: outcome.artifact,
        kind: 'review',
        decision: verdict.decision,
        reason: verdict.reason,
        model: verdict.review_model || run.review_profile?.model || null,
        action_name: 'revise_and_review_again',
      });
      if (verdict.decision === 'needs_human' && verdict.requires_human_authority === true) {
        followups.push({ type: 'human_authority', artifact: outcome.artifact, verdict, recorded });
        continue;
      }
      if (recorded.exhausted) {
        followups.push({ type: 'exhausted', artifact: outcome.artifact, verdict, recorded });
        continue;
      }
      followups.push({ type: 'revise', artifact: outcome.artifact, verdict, recorded });
    }

    const followup = followups[0];
    if (followup?.type === 'error') {
      const { artifact, reviewResult } = followup;
      return recoverAutomationFailure(repo.getRun(db, run.id), {
        artifact: null,
        stage: artifact.stage,
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        kind: 'review',
        error: reviewResult.error,
        action: reviewResult.action,
        action_name: 'retry_ai_review',
      });
    }
    if (followup?.type === 'waiting') {
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null });
      return {
        state: 'waiting_task', reason: 'ai_review_in_progress',
        action: followup.reviewResult.action, artifacts: reviewed,
      };
    }
    if (followup?.type === 'human_authority') {
      return escalateAutonomy(followup.recorded, {
        reason: 'human_authority_required',
        waiting_reason: 'human_authority_required',
        error_code: 'HUMAN_AUTHORITY_REQUIRED',
        error_message: followup.verdict.reason,
      });
    }
    if (followup?.type === 'exhausted') {
      return escalateAutonomy(followup.recorded, {
        reason: 'automation_limit_reached',
        waiting_reason: 'automation_limit_reached',
        error_code: 'AUTOMATION_LIMIT_REACHED',
        error_message: followup.verdict.reason,
      });
    }
    if (followup?.type === 'revise') {
      try {
        const revision = await reviseArtifactAutomatically(
          repo.getRun(db, run.id), followup.artifact, followup.verdict.reason,
          followup.verdict.decision, `review-${followup.recorded.count}`
        );
        return { ...revision, artifacts: [...reviewed, ...(revision.artifacts || [])], verdict: followup.verdict };
      } catch (error) {
        return recoverAutomationFailure(repo.getRun(db, run.id), {
          stage: followup.artifact.stage,
          scope_type: followup.artifact.scope_type,
          scope_id: followup.artifact.scope_id,
          error,
          action: latestFailureAction(repo.getRun(db, run.id), {
            stage: followup.artifact.stage,
            scope_type: followup.artifact.scope_type,
            scope_id: followup.artifact.scope_id,
          }),
          action_name: 'retry_artifact_revision',
        });
      }
    }
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null });
    return { state: 'approved', artifacts: reviewed };
  }

  async function resumeAutomaticArtifactRevision(run, artifact) {
    const reviews = repo.listReviews(db, run.id, { artifact_id: artifact.id, page_size: 20 }).items;
    const review = reviews.find((item) => item.decision !== 'approved') || null;
    const object = autonomy.objectState(run, automationScope(run, { artifact }));
    if (object?.escalated) {
      const recorded = {
        run,
        key: autonomy.objectKey(automationScope(run, { artifact })),
        scope: automationScope(run, { artifact }),
        object,
      };
      return escalateAutonomy(recorded, {
        reason: object.escalation_reason || 'automation_limit_reached',
        waiting_reason: object.escalation_reason || 'automation_limit_reached',
        error_code: 'AUTOMATION_LIMIT_REACHED',
        error_message: object.last_failure?.reason || review?.reason || '自动修订已达到上限',
      });
    }
    const reason = review?.reason || run.error_message || '恢复上次未完成的自动修订';
    try {
      return await reviseArtifactAutomatically(
        run, artifact, reason, review?.decision || 'recovery', `resume-${artifact.revision}`
      );
    } catch (error) {
      return recoverAutomationFailure(repo.getRun(db, run.id), {
        stage: artifact.stage,
        scope_type: artifact.scope_type,
        scope_id: artifact.scope_id,
        error,
        action: latestFailureAction(repo.getRun(db, run.id), {
          stage: artifact.stage,
          scope_type: artifact.scope_type,
          scope_id: artifact.scope_id,
        }),
        action_name: 'resume_artifact_revision',
      });
    }
  }

  async function normalizeAutomaticStageOutcome(run, result) {
    if (!result || run.review_owner === 'human' || result.state !== 'waiting_review') return result;
    if (result.reason === 'human_authority_required'
      || result.intervention?.reason === 'human_authority_required'
      || run.runtime?.autonomy?.intervention?.reason === 'human_authority_required') {
      return result;
    }
    const liveRun = repo.getRun(db, run.id);
    const automaticWaitReasons = new Set([
      'stage_handler_pending',
      'video_prompt_plan_in_progress',
      'image_generation',
      'video_generation',
      'superseded_video_waiting',
      'final_merge',
      'provider_task_pending',
      'video_download_pending',
      'video_download_retry',
      'status_convergence_pending',
    ]);
    if (automaticWaitReasons.has(result.reason)) {
      const scope = automationScope(liveRun, result);
      const runtime = resolvedAutonomyRuntime(liveRun, scope);
      const providerWait = new Set([
        'image_generation',
        'video_generation',
        'superseded_video_waiting',
        'final_merge',
        'provider_task_pending',
        'video_download_pending',
        'video_download_retry',
      ]).has(result.reason);
      const healed = repo.updateRun(db, liveRun.id, {
        ...(runtime ? { runtime } : {}),
        status: providerWait ? 'waiting_provider' : 'running',
        waiting_reason: providerWait ? result.reason : null,
        error_code: null,
        error_message: null,
      });
      if (runtime) {
        repo.appendEvent(db, healed.id, 'automation.wait_state_cleared', {
          ...scope,
          payload: { reason: result.reason },
        });
      }
      return {
        ...result,
        state: providerWait ? 'waiting_provider' : 'waiting_task',
        run: healed,
      };
    }
    const normalReviewReasons = new Set([
      'reference_bundle_review_required',
      'reference_bundle_stale',
      'video_dispatch_state_changed',
      'video_route_changed',
    ]);
    const artifact = result.artifact ? repo.getArtifact(db, result.artifact.id) : null;
    const reviewQueued = artifact
      && ['draft', 'reviewing'].includes(artifact.status)
      && artifact.stage === liveRun.current_stage;
    if (normalReviewReasons.has(result.reason) || reviewQueued) {
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
      return { ...result, state: 'progressed', reason: 'automatic_review_queued' };
    }
    const failureRecord = (result.failures || []).find((item) => item?.action || item?.error) || null;
    return recoverAutomationFailure(liveRun, {
      ...result,
      action: failureRecord?.action || result.action,
      source: failureRecord?.source || result.source,
      error: failureRecord?.error,
      code: failureRecord?.action?.error_code || result.action?.error_code || String(result.reason || 'AUTOMATION_FAILURE').toUpperCase(),
      message: failureRecord?.action?.error_message || result.action?.error_message || liveRun.error_message || result.reason,
      action_name: 'recover_stage_failure',
    });
  }

  async function generateScript(run) {
    const source = approvedArtifacts(db, run.id, 'story_input')[0];
    if (!source) throw new Error('找不到已确认的故事输入');
    const prompts = textStages.scriptPrompts(source.content.story, run.policy);
    const result = await runTextAction(run, {
      stage: 'script', scope_type: 'run', scope_id: '', prompts,
      prompt_id: 'production.script.system',
      normalize: textStages.normalizeScript, max_tokens: 12000, temperature: 0.7,
    });
    if (result.waiting) return { state: 'waiting_task', ...result };
    let artifact = latestArtifact(db, run.id, 'script');
    if (!artifact) artifact = createGeneratedArtifact(run, {
      stage: 'script', scope_type: 'run', scope_id: '', title: '短片剧本',
      content: result, depends_on: [source.id],
    });
    return applyReviewPolicy(run, [artifact]);
  }

  async function generateAssetText(run) {
    const script = approvedArtifacts(db, run.id, 'script')[0];
    if (!script) throw new Error('请先确认剧本');
    const prompts = textStages.resourcePrompts(script.content.text, run.policy);
    const result = await runTextAction(run, {
      stage: 'asset_text', scope_type: 'collection', scope_id: '', prompts,
      prompt_id: 'production.assets.system',
      normalize: (raw) => textStages.normalizeResources(raw, log), max_tokens: 12000, temperature: 0.45,
    });
    if (result.waiting) return { state: 'waiting_task', ...result };
    const existing = repo.listArtifacts(db, run.id, { stage: 'asset_text', current: true, page_size: 200 }).items;
    if (existing.length) return applyReviewPolicy(run, existing);
    const artifacts = [];
    for (const type of ['characters', 'scenes', 'props']) {
      const scopeType = type === 'characters' ? 'character' : type === 'scenes' ? 'scene' : 'prop';
      for (let index = 0; index < result[type].length; index++) {
        const item = result[type][index];
        const scopeId = `${scopeType}-${index + 1}`;
        artifacts.push(createGeneratedArtifact(run, {
          stage: 'asset_text', scope_type: scopeType, scope_id: scopeId,
          title: item.name, content: item, depends_on: [script.id],
        }));
      }
    }
    return applyReviewPolicy(run, artifacts);
  }

  async function generateStoryboardPlan(run) {
    const script = approvedArtifacts(db, run.id, 'script')[0];
    const assets = approvedArtifacts(db, run.id, 'asset_text').filter((item) => item.content.included !== false);
    if (!script || !assets.length) throw new Error('请先确认剧本和资源');
    const resourceDigest = assets.map((item) => ({ type: item.scope_type, ...item.content }));
    const videoCapability = getYinziVideoCapability(run.policy?.video_model);
    const durationMin = Math.max(5, Number(run.policy?.video_duration_min || videoCapability?.duration_min) || 5);
    const prompts = textStages.storyboardPrompts(script.content.text, resourceDigest, {
      ...run.policy,
      max_total_seconds: run.budget.max_video_seconds,
      video_duration_min: durationMin,
      strict_first_frame_supported: capabilitySupportsRole(videoCapability, 'image', 'first_frame'),
    });
    const result = await runTextAction(run, {
      stage: 'storyboard_plan', scope_type: 'collection', scope_id: '', prompts,
      prompt_id: 'production.storyboard.system',
      prompt_variables: {
        min_shot_seconds: durationMin,
        transition_rule: capabilitySupportsRole(videoCapability, 'image', 'first_frame')
          ? '默认硬切；仅在确有必要且提供严格首帧时使用 strict_continuation。'
          : '默认硬切；连续画面只能把上一镜尾帧作为普通参考图。',
      },
      normalize: (raw) => textStages.normalizeShots(raw, log, run.budget.max_shots, {
        duration_min: durationMin,
        strict_first_frame_supported: capabilitySupportsRole(videoCapability, 'image', 'first_frame'),
      }),
      max_tokens: 14000, temperature: 0.45,
    });
    if (result.waiting) return { state: 'waiting_task', ...result };
    const existing = repo.listArtifacts(db, run.id, { stage: 'storyboard_plan', current: true, page_size: 200 }).items;
    if (existing.length) return applyReviewPolicy(run, existing);
    const dependencies = [script.id, ...assets.map((item) => item.id)];
    const artifacts = result.shots.map((shot, index) => createGeneratedArtifact(run, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: String(shot.number || index + 1),
      title: shot.title, content: shot, depends_on: dependencies,
    }));
    return applyReviewPolicy(run, artifacts);
  }

  async function ensureScopedShotRevision(run) {
    const scopeId = String(run.current_scope_id || '');
    if (!scopeId) throw new Error('Sequential shot refinement requires a current shot scope');
    const roughShot = latestArtifact(db, run.id, 'storyboard_plan', 'shot', scopeId);
    if (!roughShot || roughShot.status !== 'approved') {
      throw new Error(`Shot ${scopeId} has no approved rough plan to refine`);
    }
    const shots = orderedShots(run);
    const shotIndex = shots.findIndex((item) => item.scope_id === scopeId);
    if (shotIndex <= 0) return { state: 'stage_ready', artifacts: [roughShot] };
    const previousShot = shots[shotIndex - 1];
    const previousVideo = approvedArtifacts(db, run.id, 'shot_video')
      .find((item) => item.scope_id === previousShot.scope_id && item.content?.included !== false);
    if (!previousVideo) {
      throw new Error(`Shot ${scopeId} cannot be refined before shot ${previousShot.scope_id} video approval`);
    }
    if (Number(roughShot.content?.refined_from_video_artifact_id) === Number(previousVideo.id)) {
      return { state: 'stage_ready', artifacts: [roughShot] };
    }
    const assets = approvedArtifacts(db, run.id, 'asset_text')
      .filter((item) => item.content?.included !== false)
      .map((item) => ({ artifact_id: item.id, type: item.scope_type, scope_id: item.scope_id, ...item.content }));
    const approvalEvidence = repo.listReviews(db, run.id, {
      artifact_id: previousVideo.id,
      page_size: 20,
    }).items.map((review) => ({
      decision: review.decision,
      reason: review.reason,
      confidence: review.confidence,
      scores: review.scores,
      evidence: review.evidence,
    }));
    const prompts = textStages.shotContinuityRevisionPrompts({
      previous_shot: previousShot.content,
      previous_video: {
        artifact_id: previousVideo.id,
        media_path: previousVideo.media_path,
        content_hash: previousVideo.content_hash,
        validation: previousVideo.content?.validation,
        provider_generation_id: previousVideo.content?.provider_generation_id,
      },
      approval_evidence: approvalEvidence,
      rough_shot: roughShot.content,
      assets,
      strict_first_frame_supported: capabilitySupportsRole(
        getYinziVideoCapability(run.policy?.video_model), 'image', 'first_frame'
      ),
      duration_min: Math.max(5, Number(run.policy?.video_duration_min
        || getYinziVideoCapability(run.policy?.video_model)?.duration_min) || 5),
    });
    const result = await runTextAction(run, {
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: scopeId,
      kind: 'storyboard_refine',
      prompts,
      prompt_id: 'production.storyboard_refine.system',
      prompt_variables: {
        continuation_rule: capabilitySupportsRole(
          getYinziVideoCapability(run.policy?.video_model), 'image', 'first_frame'
        )
          ? 'Strict continuation is allowed only with an exact first-frame input.'
          : 'Strict continuation is unavailable; use a hard cut or an ordinary tail-frame reference.',
      },
      normalize: (raw) => ({
        shot: textStages.normalizeShotRevision(raw, log, roughShot.content?.number || scopeId, {
          strict_first_frame_supported: capabilitySupportsRole(
            getYinziVideoCapability(run.policy?.video_model), 'image', 'first_frame'
          ),
          duration_min: Math.max(5, Number(run.policy?.video_duration_min
            || getYinziVideoCapability(run.policy?.video_model)?.duration_min) || 5),
        }),
      }),
      max_tokens: 9000,
      temperature: 0.35,
      scene_key: 'production_storyboard_refine',
    });
    if (result.waiting) return { state: 'waiting_task', ...result };
    const artifact = createGeneratedArtifact(run, {
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: scopeId,
      title: result.shot.title,
      content: {
        ...result.shot,
        rough_source_artifact_id: roughShot.id,
        refined_from_shot_artifact_id: previousShot.id,
        refined_from_video_artifact_id: previousVideo.id,
        refinement_basis: 'approved_predecessor_lineage',
        included: true,
      },
      depends_on: [previousShot.id, previousVideo.id, ...assets.map((item) => item.artifact_id)],
    });
    return { state: 'progressed', reason: 'shot_plan_refined', artifact };
  }

  function recoverScopedShotRevision(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const scopeId = String(run.current_scope_id || '');
    if (run.current_stage !== 'storyboard_plan' || !isSequentialShotRun(run) || !scopeId) {
      const error = new Error('当前不在顺序分镜修订阶段，不能使用本地恢复');
      error.code = 'STORYBOARD_RECOVERY_NOT_ALLOWED';
      throw error;
    }
    const failedAction = input.action_id
      ? repo.getAction(db, Number(input.action_id))
      : repo.getLatestAction(db, run.id, {
        stage: 'storyboard_plan', scope_type: 'shot', scope_id: scopeId, kind: 'storyboard_refine',
      });
    const failureMessage = String(failedAction?.error_message || '');
    const structuralFailure = /分镜结果为空|缺少动作|缺少构图|JSON|parse|truncat|截断|Unexpected/i.test(failureMessage);
    if (!failedAction
      || failedAction.run_id !== run.id
      || failedAction.stage !== 'storyboard_plan'
      || failedAction.scope_id !== scopeId
      || failedAction.kind !== 'storyboard_refine'
      || failedAction.status !== 'failed'
      || !structuralFailure) {
      const error = new Error('只有顺序分镜 JSON 截断或字段缺失失败才能从粗分镜本地恢复');
      error.code = 'STORYBOARD_RECOVERY_NOT_ALLOWED';
      throw error;
    }

    const scopedArtifacts = repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: scopeId, page_size: 200,
    }).items;
    const roughShot = scopedArtifacts.find((item) => (
      item.status === 'approved'
      && !item.content?.refinement_basis
      && !item.content?.recovered_from_failed_action_id
    ));
    if (!roughShot) throw new Error(`镜头 ${scopeId} 没有可用于恢复的已确认粗分镜`);

    const allApprovedPlans = repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', current: true, status: 'approved', page_size: 200,
    }).items.concat(roughShot).filter((item, index, items) => items.findIndex((entry) => entry.id === item.id) === index)
      .sort(compareShots);
    const shotIndex = allApprovedPlans.findIndex((item) => item.id === roughShot.id);
    if (shotIndex <= 0) throw new Error('第一镜头不需要顺序分镜恢复');
    const previousShot = allApprovedPlans[shotIndex - 1];
    const previousVideo = approvedArtifacts(db, run.id, 'shot_video')
      .find((item) => item.scope_id === previousShot.scope_id && item.content?.included !== false);
    if (!previousVideo) throw new Error(`镜头 ${previousShot.scope_id} 的成片尚未确认，不能恢复下一镜头`);

    const capability = getYinziVideoCapability(run.policy?.video_model);
    const recoveryFingerprint = repo.hashJson({
      rough_shot_artifact_id: roughShot.id,
      previous_shot_artifact_id: previousShot.id,
      previous_video_artifact_id: previousVideo.id,
      failed_action_id: failedAction.id,
      strict_first_frame_supported: capabilitySupportsRole(capability, 'image', 'first_frame'),
    });
    const existing = scopedArtifacts.find((item) => item.content?.local_recovery_fingerprint === recoveryFingerprint);
    if (existing) {
      if (run.status === 'failed') {
        repo.updateRun(db, run.id, {
          status: 'waiting_review', waiting_reason: 'storyboard_local_recovery',
          error_code: null, error_message: null,
        });
      }
      return { state: 'waiting_review', reason: 'storyboard_local_recovery', artifact: existing, reused: true };
    }

    const assets = approvedArtifacts(db, run.id, 'asset_text')
      .filter((item) => item.content?.included !== false);
    const recoveredShot = textStages.recoverShotRevisionFromApprovedRough(
      roughShot.content,
      previousShot.content,
      {
        expected_number: roughShot.content?.number || scopeId,
        strict_first_frame_supported: capabilitySupportsRole(capability, 'image', 'first_frame'),
        duration_min: Math.max(5, Number(run.policy?.video_duration_min || capability?.duration_min) || 5),
      }
    );
    const artifact = createGeneratedArtifact(run, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: scopeId,
      title: recoveredShot.title,
      content: {
        ...recoveredShot,
        rough_source_artifact_id: roughShot.id,
        refined_from_shot_artifact_id: previousShot.id,
        refined_from_video_artifact_id: previousVideo.id,
        refinement_basis: 'approved_rough_plan_local_recovery',
        recovered_from_failed_action_id: failedAction.id,
        local_recovery_fingerprint: recoveryFingerprint,
        local_recovery_notice: '由已确认粗分镜本地恢复，未再次调用文本、图片或视频模型',
        included: true,
      },
      depends_on: [roughShot.id, previousShot.id, previousVideo.id, ...assets.map((item) => item.id)],
    });
    repo.updateRun(db, run.id, {
      status: 'waiting_review', waiting_reason: 'storyboard_local_recovery',
      error_code: null, error_message: null,
    });
    repo.appendEvent(db, run.id, 'storyboard.local_recovered', {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: scopeId,
      payload: {
        artifact_id: artifact.id,
        rough_source_artifact_id: roughShot.id,
        previous_shot_artifact_id: previousShot.id,
        previous_video_artifact_id: previousVideo.id,
        failed_action_id: failedAction.id,
        transition_mode: artifact.content?.transition_mode,
        tail_frame_used: false,
      },
    });
    return { state: 'waiting_review', reason: 'storyboard_local_recovery', artifact, reused: false };
  }

  async function ensureDirectorPlans(run) {
    if (isDirectorDisabled(run)) return { state: 'stage_ready', artifacts: [] };
    const allShots = approvedArtifacts(db, run.id, 'storyboard_plan')
      .filter((item) => item.content.included !== false);
    const shots = isSequentialShotRun(run) && run.current_scope_id != null
      ? allShots.filter((item) => item.scope_id === String(run.current_scope_id))
      : allShots;
    if (!shots.length) throw new Error('请先确认分镜脚本');
    const existing = repo.listArtifacts(db, run.id, {
      stage: 'director_plan', current: true, page_size: 200,
    }).items;
    const assets = approvedArtifacts(db, run.id, 'asset_text')
      .filter((item) => item.content.included !== false)
      .map((item) => ({
        type: item.scope_type,
        name: item.content.name,
        description: item.content.description,
      }));
    for (const shot of shots) {
      const target = existing.find((item) => item.scope_id === shot.scope_id);
      if (
        target
        && Number(target.content?.source_artifact_id) === Number(shot.id)
        && ['draft', 'reviewing', 'approved'].includes(target.status)
      ) continue;
      const prompts = director.directorPrompts(
        shot.content,
        assets,
        run.policy?.aspect_ratio || '16:9'
      );
      const result = await runTextAction(run, {
        stage: 'director_plan',
        scope_type: 'shot',
        scope_id: shot.scope_id,
        prompts,
        prompt_id: 'production.director.system',
        prompt_variables: director.directorPromptVariables(run.policy?.aspect_ratio || '16:9'),
        normalize: (raw) => ({
          document: director.parseDirectorDocument(raw, shot.content, log, run.policy?.aspect_ratio),
        }),
        max_tokens: 10000,
        temperature: 0.25,
        repair_on_normalize_error: true,
      });
      if (result.waiting) return { state: 'waiting_task', ...result };
      const artifact = createGeneratedArtifact(run, {
        stage: 'director_plan',
        scope_type: 'shot',
        scope_id: shot.scope_id,
        title: `${shot.title} 导演台方案`,
        content: {
          source_artifact_id: shot.id,
          source_revision: shot.revision,
          document: result.document,
          scene_summary: `${shot.content.visual}；${shot.content.action}；镜头 ${shot.content.camera_movement}`,
          included: true,
        },
        depends_on: [shot.id],
      });
      return { state: 'progressed', artifact };
    }
    return { state: 'stage_ready', artifacts: existing };
  }

  async function ensureStageArtifacts(run) {
    if (run.current_stage === 'storyboard_plan' && isSequentialShotRun(run) && run.current_scope_id != null) {
      return ensureScopedShotRevision(run);
    }
    if (run.current_stage === 'asset_images' || run.current_stage === 'storyboard_images') {
      return media.ensureImageStage(run, run.current_stage);
    }
    if (run.current_stage === 'director_plan') return ensureDirectorPlans(run);
    if (run.current_stage === 'director_preview') {
      if (isDirectorDisabled(run)) return { state: 'stage_ready', artifacts: [] };
      return media.requestDirectorCapture(run);
    }
    if (run.current_stage === 'reference_bundle') return media.ensureReferenceBundles(run);
    if (run.current_stage === 'shot_video') return media.ensureShotVideos(run);
    if (run.current_stage === 'final_edit') return finalEdit.ensureFinalEdit(run);
    return null;
  }

  async function advance(runId, input = {}) {
    const owner = input.lease_owner || `api-${crypto.randomUUID()}`;
    const lease = repo.claimLease(db, runId, owner, input.lease_ttl_ms || 45000);
    if (!lease.claimed) return { state: lease.reason === 'busy' ? 'waiting_task' : 'failed', reason: lease.reason, run: lease.run };
    try {
      let run = repo.getRun(db, runId);
      const legacyIntervention = run.runtime?.autonomy?.intervention || null;
      if (run.review_owner !== 'human' && legacyIntervention?.object_key) {
        const legacyObject = run.runtime?.autonomy?.objects?.[legacyIntervention.object_key];
        const attempts = Array.isArray(legacyObject?.attempts) ? legacyObject.attempts : [];
        const onlyObsoleteConvergenceFailures = attempts.length > 0 && attempts.every((attempt) => (
          String(attempt?.error_code || '').toUpperCase() === 'SOURCE_CHANGED_WHILE_ACTION_ACTIVE'
          || /source_changed_while_action_active/i.test(String(attempt?.reason || ''))
        ));
        if (onlyObsoleteConvergenceFailures) {
          const runtime = JSON.parse(JSON.stringify(run.runtime || {}));
          delete runtime.autonomy.objects[legacyIntervention.object_key];
          delete runtime.autonomy.intervention;
          run = repo.updateRun(db, run.id, {
            runtime, status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          repo.appendEvent(db, run.id, 'automation.legacy_convergence_intervention_cleared', {
            stage: legacyIntervention.stage || run.current_stage,
            scope_type: legacyIntervention.scope_type || run.current_scope_type,
            scope_id: legacyIntervention.scope_id ?? run.current_scope_id,
            payload: { object_key: legacyIntervention.object_key },
          });
        }
      }
      const initialRevisionBlocker = currentStoryboardRevisionBlocker(run);
      if (run.review_owner !== 'human' && run.runtime?.autonomy?.intervention) {
        return {
          state: 'waiting_review',
          reason: run.runtime.autonomy.intervention.reason || 'automation_limit_reached',
          intervention: run.runtime.autonomy.intervention.summary || null,
          run,
        };
      }
      if (run.review_owner !== 'human' && initialRevisionBlocker) {
        run = repo.updateRun(db, run.id, {
          status: 'running', waiting_reason: null, error_code: null, error_message: null,
        });
        return { ...(await resumeAutomaticArtifactRevision(run, initialRevisionBlocker)), run: repo.getRun(db, run.id) };
      }
      const recoverableRejectedRevisionFailure = run.status === 'failed'
        && run.waiting_reason === 'revision_required'
        && initialRevisionBlocker?.status === 'rejected'
        && run.error_code === 'ADVANCE_FAILED'
        && /no approved rough plan to refine/i.test(String(run.error_message || ''));
      if (recoverableRejectedRevisionFailure) {
        run = repo.updateRun(db, run.id, {
          status: 'waiting_review',
          waiting_reason: 'revision_required',
          error_code: null,
          error_message: null,
        });
        return {
          state: 'waiting_review',
          reason: 'revision_required',
          artifacts: [initialRevisionBlocker],
          run,
        };
      }
      if (run.status === 'failed' && run.review_owner !== 'human') {
        return recoverAutomationFailure(run, {
          code: run.error_code || 'ADVANCE_FAILED',
          message: run.error_message || '无人值守任务在上一次推进中失败',
          action: latestFailureAction(run),
          action_name: 'recover_failed_run',
        });
      }
      if (['paused', 'cancelled', 'completed', 'failed'].includes(run.status)) {
        return { state: run.status, run };
      }
      if (initialRevisionBlocker) {
        run = repo.updateRun(db, run.id, {
          status: 'waiting_review',
          waiting_reason: 'revision_required',
          error_code: null,
          error_message: null,
        });
        return {
          state: 'waiting_review',
          reason: 'revision_required',
          artifacts: [initialRevisionBlocker],
          run,
        };
      }
      if (run.next_stage_strategy === 'manual_add') {
        const current = currentStageArtifacts(run);
        if (!current.length) {
          run = repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'manual_content_required' });
          return { state: 'waiting_review', reason: 'manual_content_required', run };
        }
      }

      if (isDirectorDisabled(run) && ['director_plan', 'director_preview'].includes(run.current_stage)) {
        const waitingCaptures = repo.listActions(db, run.id, {
          stage: 'director_preview',
          scope_type: 'shot',
          scope_id: run.current_scope_id,
          kind: 'client_capture',
          page_size: 100,
        }).items.filter((item) => item.status === 'waiting'
          && item.stage === 'director_preview'
          && item.kind === 'client_capture'
          && String(item.scope_id || '') === String(run.current_scope_id || ''));
        for (const action of waitingCaptures) {
          repo.updateAction(db, action.id, {
            status: 'cancelled',
            result: {
              ...(action.result || {}),
              cancelled_reason: 'director_disabled_for_run',
              cancelled_at: new Date().toISOString(),
            },
          });
        }
        const transitioned = transitionSequentialStage(run, {
          next_stage_strategy: run.manual_next_default ? 'manual_add' : 'auto_generate',
        }, { complete: true, unresolved: [] });
        return { state: 'progressed', transition: transitioned, run: transitioned.run };
      }

      let currentArtifacts = currentStageArtifacts(run);
      if (run.review_owner !== 'human') {
        const interruptedRevision = currentArtifacts.find((artifact) => {
          if (!['rejected', 'reviewing'].includes(artifact.status)) return false;
          const latestReview = repo.listReviews(db, run.id, { artifact_id: artifact.id, page_size: 1 }).items[0];
          return latestReview && latestReview.decision !== 'approved';
        });
        if (interruptedRevision) {
          return { ...(await resumeAutomaticArtifactRevision(run, interruptedRevision)), run: repo.getRun(db, run.id) };
        }
      }
      const awaitingReview = currentArtifacts.filter((item) => ['draft', 'reviewing'].includes(item.status));
      const imageStageNeedsReconciliation = ['asset_images', 'storyboard_images'].includes(run.current_stage)
        && run.next_stage_strategy !== 'manual_add';
      if (imageStageNeedsReconciliation || (!awaitingReview.length && run.next_stage_strategy !== 'manual_add')) {
        const ensured = await ensureStageArtifacts(run);
        if (ensured && ensured.state !== 'stage_ready') {
          const normalized = await normalizeAutomaticStageOutcome(repo.getRun(db, run.id), ensured);
          return { ...normalized, run: repo.getRun(db, run.id) };
        }
        currentArtifacts = currentStageArtifacts(run);
      }
      if (currentArtifacts.length) {
        const drafts = currentArtifacts.filter((item) => ['draft', 'reviewing'].includes(item.status));
        if (drafts.length) {
          const reviewed = await applyReviewPolicy(run, drafts);
          if (reviewed.state !== 'approved') return { ...reviewed, run: repo.getRun(db, run.id) };
          run = repo.getRun(db, run.id);
          currentArtifacts = currentStageArtifacts(run);
        }
        const completion = completionForRun(run, currentArtifacts);
        if (completion.complete) {
          if (run.review_owner === 'human') {
            run = repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'stage_transition' });
            return { state: 'waiting_review', reason: 'stage_transition', run, completion };
          }
          const transitionInput = {
            next_stage_strategy: run.manual_next_default ? 'manual_add' : 'auto_generate',
          };
          const transitioned = isSequentialShotRun(run) && SEQUENTIAL_SHOT_STAGES.includes(run.current_stage)
            ? transitionSequentialStage(run, transitionInput, completion)
            : repo.transitionRun(db, run.id, transitionInput);
          return { state: transitioned.run.status === 'completed' ? 'completed' : 'progressed', transition: transitioned, run: transitioned.run };
        }
        const finalOutputNeedsComposition = run.current_stage === 'final_edit'
          && completion.unresolved.length > 0
          && completion.unresolved.every((item) => (
            item.reason === 'missing_final_video' || item.reason === 'final_video_outdated'
          ));
        if (finalOutputNeedsComposition && run.next_stage_strategy !== 'manual_add') {
          run = repo.getRun(db, run.id);
          const ensured = await ensureStageArtifacts(run);
          if (ensured && ensured.state !== 'stage_ready') {
            const normalized = await normalizeAutomaticStageOutcome(repo.getRun(db, run.id), ensured);
            return { ...normalized, run: repo.getRun(db, run.id) };
          }
        }
        run = repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'unresolved_items' });
        if (run.review_owner !== 'human') {
          const normalized = await normalizeAutomaticStageOutcome(run, {
            state: 'waiting_review',
            reason: 'unresolved_items',
            code: 'UNRESOLVED_STAGE_ITEMS',
            message: JSON.stringify(completion.unresolved).slice(0, 1200),
          });
          return { ...normalized, run: repo.getRun(db, run.id), completion };
        }
        return { state: 'waiting_review', reason: 'unresolved_items', run, completion };
      }

      if (run.current_stage === 'story_input') {
        const transitioned = repo.transitionRun(db, run.id, { next_stage_strategy: run.next_stage_strategy });
        return { state: 'progressed', transition: transitioned, run: transitioned.run };
      }
      if (run.current_stage === 'script') return { ...(await generateScript(run)), run: repo.getRun(db, run.id) };
      if (run.current_stage === 'asset_text') return { ...(await generateAssetText(run)), run: repo.getRun(db, run.id) };
      if (run.current_stage === 'storyboard_plan') return { ...(await generateStoryboardPlan(run)), run: repo.getRun(db, run.id) };

      if (run.review_owner !== 'human') {
        const normalized = await normalizeAutomaticStageOutcome(run, {
          state: 'waiting_review', reason: 'stage_handler_pending', code: 'STAGE_HANDLER_PENDING',
        });
        return { ...normalized, run: repo.getRun(db, run.id) };
      }
      run = repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'stage_handler_pending' });
      return { state: 'waiting_review', reason: 'stage_handler_pending', run };
    } catch (error) {
      const current = repo.getRun(db, runId);
      if (current && current.review_owner !== 'human' && !['cancelled', 'completed', 'paused'].includes(current.status)) {
        try {
          return await recoverAutomationFailure(current, {
            error,
            code: error.code || 'ADVANCE_FAILED',
            message: error.message,
            action: latestFailureAction(current),
            action_name: 'recover_advance_failure',
          });
        } catch (recoveryError) {
          repo.updateRun(db, runId, {
            status: 'waiting_review',
            waiting_reason: 'automation_recovery_failed',
            error_code: recoveryError.code || 'AUTOMATION_RECOVERY_FAILED',
            error_message: autonomy.sanitizeFailureText(recoveryError.message, 1200),
          });
          return {
            state: 'waiting_review',
            reason: 'automation_recovery_failed',
            error: autonomy.sanitizeFailureText(recoveryError.message, 1200),
            run: repo.getRun(db, runId),
          };
        }
      }
      if (current && !['cancelled', 'completed'].includes(current.status)) {
        repo.updateRun(db, runId, {
          status: 'failed', error_code: error.code || 'ADVANCE_FAILED', error_message: error.message,
        });
      }
      throw error;
    } finally {
      repo.releaseLease(db, runId, owner);
    }
  }

  function transition(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    if (isSequentialShotRun(run) && SEQUENTIAL_SHOT_STAGES.includes(run.current_stage)) {
      const artifacts = currentStageArtifacts(run);
      return transitionSequentialStage(run, input, completionForRun(run, artifacts));
    }
    return repo.transitionRun(db, runId, input);
  }

  async function addManualArtifact(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const stage = String(input.stage || run.current_stage);
    if (stage !== run.current_stage) throw new Error('只能向当前阶段新增内容');
    if (isDirectorDisabled(run) && ['director_plan', 'director_preview'].includes(stage)) {
      const error = new Error('本任务已关闭 3D 导演台，不会创建导演台 JSON 或预演视频');
      error.code = 'DIRECTOR_DISABLED';
      throw error;
    }
    const stageDefinition = graph.getStage(stage);
    if (!stageDefinition) throw new Error(`未知阶段 ${stage}`);

    let source = null;
    let scopeType = String(input.scope_type || stageDefinition.scope || 'run');
    let scopeId = input.scope_id == null ? '' : String(input.scope_id);
    const dependencies = [];
    if (stageDefinition.source_stage && stage !== 'final_edit') {
      const sourceId = input.source_artifact_id || input.content?.source_artifact_id;
      if (!sourceId) throw new Error('请先选择这项内容对应的上游对象');
      source = currentApprovedSource(run, stageDefinition.source_stage, Number(sourceId));
      scopeType = source.scope_type;
      scopeId = source.scope_id;
      dependencies.push(source.id);
    } else {
      dependencies.push(...requiredDependencies(run, stage).map((item) => item.id));
    }

    let content = { included: true, ...(input.content || {}) };
    if (source) {
      content = {
        ...content,
        source_artifact_id: source.id,
        source_revision: source.revision,
        included: true,
      };
    }
    if (stage === 'script') {
      scopeType = 'run';
      scopeId = '';
      content = { text: '', required_fields: ['text'], ...content, included: true };
    }
    if (stage === 'asset_text' && !['character', 'scene', 'prop'].includes(scopeType)) {
      throw new Error('资源类型必须是角色、场景或道具');
    }
    if (stage === 'storyboard_plan') {
      const number = Math.max(1, Number(content.number || scopeId) || 1);
      const opening = number === 1;
      content = {
        transition_mode: opening ? 'opening' : 'hard_cut',
        cut_motivation: opening ? '' : '上一镜头动作完整结束后切换到新的独立机位',
        cut_in: opening ? '建立本片开场状态' : '从新的独立机位建立本镜头状态',
        cut_out: '本镜头动作完整结束并形成可剪辑的稳定状态',
        continuous_take_id: '',
        boundary_prompt: opening
          ? '这是成片的开场镜头，从独立完整的开场构图开始。'
          : '这是一次明确硬切后的新摄影镜头，不得延续上一段尚未完成的运镜或动作。',
        ...content,
        number,
        route_profile: Number(content.duration || 5) <= 5 ? 'short_image_guided' : 'long_previs_guided',
        previs_mode: ['auto', 'force', 'skip'].includes(content.previs_mode) ? content.previs_mode : 'auto',
      };
      content.required_fields = [...new Set([
        ...(Array.isArray(content.required_fields) ? content.required_fields : ['title', 'action', 'visual', 'video_prompt']),
        'route_profile', 'transition_mode', 'cut_in', 'cut_out', 'boundary_prompt',
      ])];
    }
    if (stage === 'director_plan') {
      const document = content.document && Object.keys(content.document).length
        ? content.document
        : director.createFallbackDirectorDocument(source.content, run.policy?.aspect_ratio);
      content = {
        ...content,
        document: director.normalizeDirectorDocument(document, source.content?.duration, run.policy?.aspect_ratio),
        scene_summary: content.scene_summary || `${source.content?.visual || ''}；${source.content?.action || ''}`,
      };
    }
    if (stage === 'reference_bundle') {
      const route = classifyShotRoute(source, run.policy);
      content = {
        images: [], videos: [], audios: [],
        ...content,
        // Limits are advisory metadata only.  Preserve a known capability
        // snapshot when the caller has one; otherwise leave it open for a
        // manually selected or newly published upstream model.
        limits: Object.prototype.hasOwnProperty.call(content, 'limits') ? content.limits : null,
        soft_limits: content.soft_limits !== false,
        media_constraints: content.media_constraints || { contract_status: 'unknown' },
        route_profile: route.profile,
        uses_reference_video: route.uses_reference_video,
        requires_director_preview: route.requires_director_preview,
        previs_mode: route.previs_mode,
        director_mode: route.director_mode,
      };
    }
    if (stage === 'shot_video') {
      const bundle = approvedArtifacts(db, run.id, 'reference_bundle')
        .find((item) => item.scope_id === source.scope_id && item.content?.included !== false);
      if (!bundle) throw new Error('请先确认这个镜头的参考包');
      dependencies.push(bundle.id);
      content.bundle_artifact_id = bundle.id;
    }
    if (stage === 'final_edit') {
      scopeType = 'run';
      scopeId = '';
      const shots = approvedArtifacts(db, run.id, 'shot_video').filter((item) => item.content?.included !== false);
      if (!shots.length) throw new Error('请先确认至少一个镜头视频');
      dependencies.push(...shots.map((item) => item.id));
      content.source_shot_artifact_ids = shots.map((item) => item.id);
    }

    let receipt = null;
    if (stageDefinition.media) {
      if (!input.media_path) throw new Error('请先上传真实媒体文件');
      if (stageDefinition.media === 'image') {
        receipt = await validateImage(input.media_path, { min_width: 128, min_height: 128 });
      } else {
        const expectedDuration = source?.content?.duration || source?.content?.document?.timeline?.duration;
        receipt = await validateVideo(input.media_path, expectedDuration ? {
          expected_duration: Number(expectedDuration),
          duration_tolerance: Math.max(2, Number(expectedDuration) * 0.35),
        } : {});
        if (stage === 'final_edit' && (receipt.video_codec !== 'h264' || receipt.audio_codec !== 'aac')) {
          throw new Error('手动成片必须是 H.264 视频和 AAC 音频');
        }
      }
      content.validation = receipt;
      content.uploaded_by_user = true;
    }

    const artifact = repo.createArtifact(db, {
      run_id: run.id,
      stage,
      scope_type: scopeType,
      scope_id: scopeId,
      title: input.title || source?.title || '手动内容',
      content,
      status: 'draft',
      media_path: receipt?.relative_path || input.media_path || null,
      mime_type: input.mime_type || (receipt?.format ? `image/${receipt.format}` : receipt?.signature === 'webm' ? 'video/webm' : receipt ? 'video/mp4' : null),
      content_hash: receipt?.sha256,
      depends_on: [...new Set(dependencies)],
    });
    repo.appendEvent(db, run.id, 'artifact.manual_added', {
      stage, scope_type: artifact.scope_type, scope_id: artifact.scope_id,
      payload: { artifact_id: artifact.id, source_artifact_id: source?.id || null },
    });
    repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'stage_review' });
    return artifact;
  }

  async function reviewArtifact(artifactId, input = {}) {
    const artifact = repo.getArtifact(db, artifactId);
    if (!artifact) throw new Error('产物不存在');
    finalEdit.assertFinalVideoReviewable(artifact);
    if (input.decision === 'approved') await validateArtifactForApproval(artifact);
    const outcome = repo.reviewArtifact(db, artifactId, input);
    if (input.decision === 'approved') {
      const run = repo.getRun(db, artifact.run_id);
      const runtime = resolvedAutonomyRuntime(run, { artifact: outcome.artifact });
      if (runtime) {
        repo.updateRun(db, run.id, {
          runtime,
          status: 'running',
          waiting_reason: null,
          error_code: null,
          error_message: null,
        });
      }
    }
    return outcome;
  }

  function updateArtifact(artifactId, input = {}) {
    const artifact = repo.getArtifact(db, artifactId);
    if (!artifact) throw new Error('产物不存在');
    finalEdit.assertFinalVideoImmutable(artifact);
    const prepared = artifact.stage === 'final_edit' && artifact.content?.kind === 'narration_plan'
      ? finalEdit.normalizeNarrationPlanEdit(artifact, input)
      : input;
    return repo.editArtifact(db, artifactId, prepared);
  }

  async function rebuildFinalEdit(runId, input = {}) {
    const owner = input.lease_owner || `final-rebuild-${crypto.randomUUID()}`;
    const lease = repo.claimLease(db, runId, owner, input.lease_ttl_ms || 45000);
    if (!lease.claimed) {
      return { state: lease.reason === 'busy' ? 'waiting_task' : 'failed', reason: lease.reason, run: lease.run };
    }
    try {
      let run = repo.getRun(db, runId);
      if (!run) throw new Error('制作任务不存在');
      if (run.current_stage !== 'final_edit') throw new Error('只有剪辑交付阶段可以重新合成');
      if (['paused', 'cancelled'].includes(run.status)) throw new Error('请先恢复制作任务再重新合成');
      run = repo.updateRun(db, run.id, {
        status: 'running', waiting_reason: null, error_code: null, error_message: null,
      });
      repo.appendEvent(db, run.id, 'final_edit.rebuild_requested', {
        stage: 'final_edit', scope_type: 'run', scope_id: '',
        payload: { reason: String(input.reason || '用户请求重新剪辑合成').slice(0, 500) },
      });
      const result = await finalEdit.ensureFinalEdit(run, { force_rebuild: true });
      return { ...result, run: repo.getRun(db, run.id) };
    } finally {
      repo.releaseLease(db, runId, owner);
    }
  }

  function authorizeRetry(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const reason = String(input.reason || '').trim();
    if (!reason) throw new Error('请填写本次重试要改进的内容');
    const action = input.action_id
      ? repo.getAction(db, input.action_id)
      : repo.getLatestAction(db, run.id, {
        stage: run.current_stage,
        ...(input.scope_type != null ? { scope_type: input.scope_type } : {}),
        ...(input.scope_id != null ? { scope_id: input.scope_id } : {}),
      });
    if (!action || action.run_id !== run.id || action.stage !== run.current_stage) throw new Error('找不到当前阶段可重试的失败任务');
    if (action.status === 'ambiguous') {
      if (input.ambiguous_resolution !== 'no_result_after_wait') {
        const error = new Error('创建结果不明确，必须先核对上游任务，不能直接重试');
        error.code = 'AMBIGUOUS_ACTION';
        throw error;
      }
      const reconciledAt = new Date().toISOString();
      const updatedAction = repo.updateAction(db, action.id, {
        status: 'cancelled',
        result: {
          ...(action.result || {}),
          retry_authorized: true,
          retry_reason: reason,
          ambiguous_reconciled: true,
          ambiguous_resolution: input.ambiguous_resolution,
          reconciled_at: reconciledAt,
        },
      });
      repo.appendEvent(db, run.id, 'action.ambiguous_reconciled', {
        stage: action.stage, scope_type: action.scope_type, scope_id: action.scope_id,
        payload: { action_id: action.id, resolution: input.ambiguous_resolution, reason },
      });
      const resolvedRuntime = resolvedAutonomyRuntime(run, { action });
      repo.updateRun(db, run.id, {
        ...(resolvedRuntime ? { runtime: resolvedRuntime } : {}),
        status: 'running', waiting_reason: null, error_code: null, error_message: null,
      });
      return { action: updatedAction, summary: repo.getRunSummary(db, run.id) };
    }
    if (action.status !== 'failed') throw new Error('只有已明确失败的任务可以重试');
    const updatedAction = repo.updateAction(db, action.id, {
      status: 'cancelled',
      result: { ...(action.result || {}), retry_authorized: true, retry_reason: reason },
    });
    repo.appendEvent(db, run.id, 'action.retry_authorized', {
      stage: action.stage, scope_type: action.scope_type, scope_id: action.scope_id,
      payload: { action_id: action.id, reason },
    });
    const resolvedRuntime = resolvedAutonomyRuntime(run, { action });
    repo.updateRun(db, run.id, {
      ...(resolvedRuntime ? { runtime: resolvedRuntime } : {}),
      status: 'running', waiting_reason: null, error_code: null, error_message: null,
    });
    return { action: updatedAction, summary: repo.getRunSummary(db, run.id) };
  }

  async function assist(input) {
    const run = input.run_id ? repo.getRun(db, input.run_id) : null;
    const context = {
      ...(input.context || {}),
      ...(run ? {
        story: approvedArtifacts(db, run.id, 'story_input')[0]?.content?.story || '',
        script: approvedArtifacts(db, run.id, 'script')[0]?.content?.text || '',
      } : {}),
    };
    const rawPrompts = textStages.fieldAssistPrompts({ ...input, context });
    const resolvedPrompt = promptRuntime.resolvePair(db, 'production.field_assist.system', rawPrompts);
    const prompts = resolvedPrompt.prompts;
    const maxTokens = Math.min(4000, Math.max(300, Number(input.max_tokens) || 1800));
    const sceneKey = 'production_field_assist';
    const cost = accounting.textReservation(db, run, {
      ...prompts, model: input.model || undefined, scene_key: sceneKey, max_tokens: maxTokens,
    });
    let action = null;
    let standaloneCostKey = null;
    if (run) {
      const stage = run.current_stage || 'story_input';
      const scopeType = run.current_scope_type || 'run';
      const scopeId = run.current_scope_id || '';
      const attempt = repo.nextActionAttempt(db, run.id, stage, scopeType, scopeId, 'field_assist');
      const actionKey = `field_assist:${stage}:${scopeType}:${scopeId}:${String(input.field_key || input.field || 'text')}:a${attempt}`;
      action = repo.reserveAction(db, {
        run_id: run.id, action_key: actionKey, stage, scope_type: scopeType, scope_id: scopeId,
        kind: 'field_assist', attempt,
        request: { field_key: input.field_key || input.field, prompt_snapshot: resolvedPrompt.receipt, model: cost.model, provider: cost.provider },
        cost,
      }).action;
      repo.updateAction(db, action.id, { status: 'submitted' });
    } else {
      standaloneCostKey = `production-assist:${crypto.randomUUID()}`;
      costLedger.reserve(db, { ...cost, idempotency_key: standaloneCostKey });
    }
    let value;
    try {
      value = await adapters.generateText(prompts.user, prompts.system, {
      model: input.model || undefined,
      temperature: input.temperature == null ? 0.55 : Number(input.temperature),
        max_tokens: maxTokens,
        scene_key: sceneKey,
      });
      const settlement = accounting.textSettlement(db, action?.id, { ...prompts, output: value });
      if (action) repo.updateAction(db, action.id, { status: 'completed', result: { prompt_receipt: resolvedPrompt.receipt }, cost: settlement });
      else costLedger.transition(db, standaloneCostKey, 'settled', settlement);
      return { value: textStages.cleanText(value, 12000), field_key: input.field_key || input.field };
    } catch (error) {
      if (action) repo.updateAction(db, action.id, { status: 'failed', error_code: error.code || 'FIELD_ASSIST_FAILED', error_message: error.message });
      else costLedger.transition(db, standaloneCostKey, 'uncertain', { note: error.message });
      throw error;
    }
  }

  function preflight(runId, input = {}) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    const checks = [];
    const textConfig = aiClient.getDefaultConfig(db, 'text');
    const assetImageModel = run.policy?.asset_image_model || run.policy?.image_model;
    const storyboardImageModel = run.policy?.storyboard_image_model || run.policy?.image_model;
    let imageConfig = null;
    let storyboardImageConfig = null;
    let imageConfigError = null;
    let storyboardImageConfigError = null;
    try {
      imageConfig = imageClient.getDefaultImageConfig(
        db, assetImageModel || undefined, undefined, 'image', run.policy?.asset_image_config_id
      );
    } catch (error) { imageConfigError = error; }
    try {
      storyboardImageConfig = imageClient.getDefaultImageConfig(
        db, storyboardImageModel || undefined, undefined, 'storyboard_image', run.policy?.storyboard_image_config_id
      );
    } catch (error) { storyboardImageConfigError = error; }
    const videoConfig = videoClient.getDefaultVideoConfig(
      db,
      run.policy?.video_model || undefined,
      run.policy?.video_config_id,
    );
    checks.push({ key: 'text_model', label: '文本模型', ok: !!(textConfig?.api_key && textConfig?.model), detail: textConfig ? (textConfig.model || '未选择模型') : '未配置' });
    checks.push({ key: 'image_model', label: '生图模型', ok: !!(imageConfig?.api_key && imageConfig?.model), detail: imageConfigError?.message || (imageConfig ? (imageConfig.model || '未选择模型') : '未配置') });
    checks.push({ key: 'storyboard_image_model', label: '分镜图模型', ok: !!(storyboardImageConfig?.api_key && storyboardImageConfig?.model), detail: storyboardImageConfigError?.message || (storyboardImageConfig ? (storyboardImageConfig.model || '未选择模型') : '未配置') });
    checks.push({
      key: 'video_model',
      label: '视频模型',
      ok: !!(videoConfig?.api_key && videoConfig?.base_url),
      detail: videoConfig
        ? (run.policy?.video_model || videoConfig.default_model || videoConfig.model || '模型将在镜头路由时选择')
        : '未配置视频 URL / Key',
    });
    checks.push({ key: 'ffmpeg', label: 'FFmpeg', ok: hasLocalFfmpeg(), detail: hasLocalFfmpeg() ? '可用' : '未找到' });
    checks.push({ key: 'ffprobe', label: 'FFprobe', ok: hasLocalFfprobe(), detail: hasLocalFfprobe() ? '可用' : '未找到' });
    const capability = getYinziVideoCapability(run.policy?.video_model);
    const automaticRouting = run.policy?.video_routing_mode === 'auto';
    const contractKnown = !run.policy?.video_model || !!capability;
    checks.push({
      key: 'provider_contract',
      label: '参考媒体契约',
      // A local capability hint is advisory. It can improve automatic route
      // selection and explain likely provider limits, but it must never turn
      // a user-selected model into a preflight blocker. The provider remains
      // the final authority and its actionable error is preserved on failure.
      ok: true,
      blocking: false,
      advisory: !contractKnown,
      detail: automaticRouting
        ? `自动按镜头路由：即梦统一按 5-15 秒提交；${isDirectorDisabled(run) ? '3D 导演台已关闭，只使用图片、音频与文本参考' : '连续长镜头可使用 3D 预演参考视频'}；付费前刷新实时目录`
        : capability
        ? `${capability.max_images} 图 / ${isDirectorDisabled(run) ? 0 : capability.max_videos} 视频 / ${capability.max_audios} 音频，${capability.duration_min}-${capability.duration_max} 秒；${capabilitySupportsRole(capability, 'image', 'first_frame') ? '支持严格首帧' : '不支持严格首帧，可选普通尾帧参考或真实切镜点硬切'}`
        : '本地尚未登记该模型能力提示；仍可提交，若上游拒绝会显示原始原因并可调整参考包后重试',
    });
    if (input.browser) {
      const directorDisabled = isDirectorDisabled(run);
      checks.push({
        key: 'webgl', label: '浏览器 WebGL',
        ok: directorDisabled || input.browser.webgl !== false,
        detail: directorDisabled ? '3D 导演台已关闭，无需此能力' : input.browser.webgl === false ? '不可用' : '可用',
      });
      checks.push({
        key: 'media_recorder', label: '浏览器录制',
        ok: directorDisabled || input.browser.media_recorder !== false,
        detail: directorDisabled ? '3D 导演台已关闭，无需此能力' : input.browser.media_recorder === false ? '不可用' : '可用',
      });
    }
    const issues = checks.filter((check) => !check.ok);
    return { ok: issues.length === 0, checks, issues, budget: run.budget, usage: run.usage, model: run.policy?.video_model || videoConfig?.model || null };
  }

  async function suggestArtifact(artifactId, input = {}) {
    const artifact = repo.getArtifact(db, artifactId);
    if (!artifact) throw new Error('产物不存在');
    finalEdit.assertFinalVideoImmutable(artifact);
    const attempt = repo.nextActionAttempt(db, artifact.run_id, artifact.stage, artifact.scope_type, artifact.scope_id, 'ai_rewrite');
    const actionKey = input.action_key
      ? `${artifact.stage}:rewrite:${artifact.id}:${String(input.action_key)}`
      : `${artifact.stage}:rewrite:${artifact.id}:a${attempt}`;
    const rawPrompts = textStages.fieldAssistPrompts({
      field_key: `完整${artifact.stage}对象`,
      current_value: JSON.stringify(artifact.content),
      instruction: input.instruction || input.reason || '根据上下文和反馈重写，保留 JSON 对象结构',
      constraints: '只输出 JSON 对象，字段结构与当前内容一致',
      context: input.context || {},
    });
    rawPrompts.system = rawPrompts.system.replace(
      '不得输出解释、标题、Markdown 围栏或 JSON 包装',
      '只输出 JSON 对象，不得输出解释或 Markdown 围栏'
    );
    const resolvedPrompt = promptRuntime.resolvePair(db, 'production.field_assist.system', rawPrompts, {
      additional_locked_suffix: '只输出 JSON 对象，不得输出解释或 Markdown 围栏。字段结构必须与当前内容一致。',
    });
    const prompts = resolvedPrompt.prompts;
    const run = repo.getRun(db, artifact.run_id);
    const cost = accounting.textReservation(db, run, {
      ...prompts, model: input.model || undefined, scene_key: 'production_artifact_suggest', max_tokens: 5000,
    });
    const reservation = repo.reserveAction(db, {
      run_id: artifact.run_id,
      action_key: actionKey,
      stage: artifact.stage,
      scope_type: artifact.scope_type,
      scope_id: artifact.scope_id,
      kind: 'ai_rewrite',
      attempt,
      request: {
        artifact_id: artifact.id,
        instruction: input.instruction || input.reason || '',
        prompt_snapshot: resolvedPrompt.receipt,
        model: cost.model || null,
        provider: cost.provider || null,
      },
      cost,
    });
    if (reservation.reused && reservation.action.status === 'completed' && reservation.action.result?.candidate) {
      return { artifact_id: artifact.id, candidate: reservation.action.result.candidate, reused: true };
    }
    if (reservation.reused && ['submitted', 'waiting'].includes(reservation.action.status)) {
      const error = new Error('AI 重写仍在处理中');
      error.code = 'ACTION_IN_PROGRESS';
      throw error;
    }
    repo.updateAction(db, reservation.action.id, { status: 'submitted' });
    try {
      const raw = await adapters.generateText(prompts.user, prompts.system, {
        model: input.model || undefined, temperature: 0.5, max_tokens: 5000,
        scene_key: 'production_artifact_suggest',
      });
      let candidate;
      try { candidate = require('../utils/safeJson').safeParseAIJSON(raw, log); }
      catch (_) {
        const text = textStages.cleanText(raw, 12000);
        candidate = Object.prototype.hasOwnProperty.call(artifact.content || {}, 'text')
          ? { ...artifact.content, text }
          : { ...artifact.content, value: text };
      }
      repo.updateAction(db, reservation.action.id, {
        status: 'completed',
        result: { candidate, prompt_receipt: resolvedPrompt.receipt },
        cost: accounting.textSettlement(db, reservation.action.id, { ...prompts, output: raw }),
      });
      return { artifact_id: artifact.id, candidate, reused: false };
    } catch (error) {
      repo.updateAction(db, reservation.action.id, {
        status: 'failed', error_code: error.code || 'AI_REWRITE_FAILED', error_message: error.message,
      });
      throw error;
    }
  }

  function updateRunControl(runId, input = {}) {
    const { expected_version: expectedVersion, ...patch } = input;
    const run = repo.updateRunControl(db, runId, patch, expectedVersion);
    if (!run) return null;
    repo.appendEvent(db, run.id, 'run.settings_updated', {
      stage: run.current_stage,
      payload: { fields: Object.keys(patch) },
    });
    return repo.getRunSummary(db, run.id);
  }

  return {
    advance,
    transition,
    addManualArtifact,
    updateArtifact,
    reviewArtifact,
    rebuildFinalEdit,
    authorizeRetry,
    getVideoRouting,
    updateVideoRouting,
    validateArtifactForApproval,
    assist,
    suggestArtifact,
    acceptClientResult: (runId, input) => media.acceptDirectorCapture(runId, input),
    recoverScopedShotRevision,
    exportRun: (runId) => finalEdit.materializeExport(runId),
    zipRun: (runId) => finalEdit.createZip(runId),
    preflight,
    applyReviewPolicy,
    updateRunControl,
    skipShot: shotOperations.skipShot,
    restoreShot: shotOperations.restoreShot,
    reviseShot: shotOperations.reviseShot,
    splitShot: shotOperations.splitShot,
    pickupShot: shotOperations.pickupShot,
  };
}

module.exports = { createProductionService };
