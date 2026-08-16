const aiConfigService = require('../services/aiConfigService');
const response = require('../response');

function list(db) {
  return (req, res) => {
    const list = aiConfigService.listConfigs(db, req.query.service_type).map(aiConfigService.toPublicConfig);
    response.success(res, list);
  };
}

function get(db) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const config = aiConfigService.getConfig(db, id);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, aiConfigService.toPublicConfig(config));
  };
}

function vendorLock(cfg) {
  return (req, res) => {
    const status = aiConfigService.getVendorLockStatus(cfg);
    response.success(res, status);
  };
}

function create(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许添加配置');
    }
    const body = req.body || {};
    if (!body.service_type || !body.name || !body.provider || !body.base_url) {
      return response.badRequest(res, '缺少必填字段: service_type, name, provider, base_url');
    }
    if (body.api_key === undefined || body.api_key === null) {
      return response.badRequest(res, '缺少必填字段: api_key');
    }
    try {
      const config = require('../services/configMutationService').withAutomaticSnapshot(db, `新增 AI 配置 ${body.name}`, () => (
        aiConfigService.createConfig(db, log, { ...body, model: body.model ?? [] })
      )).result;
      response.created(res, aiConfigService.toPublicConfig(config));
    } catch (err) {
      log.errorw('Create AI config failed', { error: err.message });
      response.internalError(res, '创建失败');
    }
  };
}

function update(db, log, cfg) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');

    let body = req.body || {};
    // 锁定模式下只允许修改 api_key、default_model、is_default
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      const allowed = {};
      if (body.api_key !== undefined) allowed.api_key = body.api_key;
      if (body.default_model !== undefined) allowed.default_model = body.default_model;
      if (body.is_default !== undefined) allowed.is_default = body.is_default;
      body = allowed;
    }

    const config = require('../services/configMutationService').withAutomaticSnapshot(db, `修改 AI 配置 #${id}`, () => (
      aiConfigService.updateConfig(db, log, id, body)
    )).result;
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, aiConfigService.toPublicConfig(config));
  };
}

function remove(db, log, cfg) {
  return (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '当前为厂商锁定模式，不允许删除配置');
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const ok = require('../services/configMutationService').withAutomaticSnapshot(db, `删除 AI 配置 #${id}`, () => (
      aiConfigService.deleteConfig(db, log, id)
    )).result;
    if (!ok) return response.notFound(res, '配置不存在');
    response.success(res, { message: '删除成功' });
  };
}

function bulkUpdateKey(db, log, cfg) {
  return (req, res) => {
    if (!aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '批量换Key仅在厂商锁定模式下可用');
    }
    const { api_key } = req.body || {};
    if (!api_key || !api_key.trim()) {
      return response.badRequest(res, '请提供新的 API Key');
    }
    try {
      const count = require('../services/configMutationService').withAutomaticSnapshot(db, '批量更新 AI 配置凭据', () => (
        aiConfigService.bulkUpdateApiKey(db, log, api_key.trim())
      )).result;
      response.success(res, { updated: count, message: `已更新 ${count} 条配置的 API Key` });
    } catch (err) {
      log.error('Bulk update api_key failed', { error: err.message });
      response.internalError(res, '批量换Key失败');
    }
  };
}

function modelCapabilities(db) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const config = aiConfigService.getConfig(db, id);
    if (!config) return response.notFound(res, '配置不存在');
    response.success(res, {
      config_id: id,
      service_type: config.service_type,
      models: aiConfigService.modelCapabilityStates(config),
    });
  };
}

function updateModelCapabilities(db, log) {
  return (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return response.badRequest(res, '无效的配置ID');
    const body = req.body || {};
    const model = String(body.model || '').trim();
    if (!model) return response.badRequest(res, '模型名不能为空');
    try {
      const result = require('../services/configMutationService').withAutomaticSnapshot(
        db,
        `${body.reset ? '恢复' : '保存'}模型能力提示 #${id}`,
        () => body.reset
          ? aiConfigService.resetModelCapabilityOverride(db, log, id, model)
          : aiConfigService.updateModelCapabilityOverride(db, log, id, model, body.capability || {})
      ).result;
      if (!result) return response.notFound(res, '配置不存在');
      response.success(res, {
        config_id: id,
        model,
        reset: body.reset === true,
        config: aiConfigService.toPublicConfig(result),
        models: aiConfigService.modelCapabilityStates(result),
      });
    } catch (err) {
      log.error('Update model capability override failed', { config_id: id, model, error: err.message });
      response.badRequest(res, err.message || '模型能力提示保存失败');
    }
  };
}

function testConnection(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    let resolved;
    try {
      resolved = aiConfigService.resolveConnectionTestConfig(db, body);
      const result = await aiConfigService.testConnection(resolved.config);
      response.success(res, {
        message: result.authenticated ? '连接与凭据验证成功' : '服务地址已连通',
        config_id: resolved.config_id,
        credential_source: resolved.credential_source,
        service_type: resolved.config.service_type || '',
        model: resolved.config.model || '',
        probe: result.probe,
        authenticated: !!result.authenticated,
        reachable_only: !!result.reachable_only,
        generated_media: false,
      });
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [resolved?.config?.api_key]);
      log.error('AI config test connection failed', {
        config_id: resolved?.config_id ?? body.config_id ?? null,
        error: safeMessage,
      });
      response.badRequest(res, '连接测试失败: ' + safeMessage);
    }
  };
}

function yinziCatalog(log) {
  return async (req, res) => {
    try {
      const { fetchYinziCatalog } = require('../services/yinziService');
      response.success(res, await fetchYinziCatalog());
    } catch (err) {
      log.error('Load Yinzi catalog failed', { error: err.message });
      response.error(res, 502, 'YINZI_CATALOG_ERROR', err.message || 'YinziAPI 模型目录加载失败');
    }
  };
}

function discoverModels(db, log) {
  return async (req, res) => {
    const body = req.body || {};
    let resolved;
    try {
      resolved = aiConfigService.resolveConnectionTestConfig(db, body);
      const discovery = await aiConfigService.discoverModels(resolved.config, {
        db,
        catalog_path: body.catalog_path,
      });
      let pricing = null;
      if (String(resolved.config.provider || '').toLowerCase() === 'yinzi') {
        try { pricing = await require('../services/yinziService').fetchYinziCatalogForConfig(resolved.config); } catch (_) { pricing = null; }
      }
      const catalog = aiConfigService.mergeDiscoveredCatalog(discovery, pricing, {
        provider: resolved.config.provider,
        service_type: body.service_type || resolved.config.service_type || 'video',
        group: body.group || '',
        capability_overrides: aiConfigService.getModelCapabilityOverrides(resolved.config),
      });
      response.success(res, {
        ...discovery,
        catalog,
        config_id: resolved.config_id,
        credential_source: resolved.credential_source,
      });
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [resolved?.config?.api_key]);
      log.error('Discover AI models failed', { config_id: resolved?.config_id ?? body.config_id ?? null, error: safeMessage });
      response.badRequest(res, '模型目录读取失败: ' + safeMessage);
    }
  };
}

function setupYinzi(db, log, cfg) {
  return async (req, res) => {
    if (aiConfigService.getVendorLockStatus(cfg).enabled) {
      return response.badRequest(res, '厂商锁定模式下不能创建 YinziAPI 配置');
    }
    const body = req.body || {};
    try {
      const { prepareYinziSetupInput, upsertYinziConfigs } = require('../services/yinziService');
      const prepared = await prepareYinziSetupInput(body);
      const result = require('../services/configMutationService').withAutomaticSnapshot(db, '一键配置 YinziAPI', () => (
        upsertYinziConfigs(db, log, prepared)
      )).result;
      response.success(res, result);
    } catch (err) {
      const safeMessage = aiConfigService.redactConnectionTestError(err, [
        body.api_key,
        body.universal_api_key,
        body.text_api_key,
        body.image_api_key,
        body.video_api_key,
      ]);
      log.error('Setup Yinzi configs failed', { error: safeMessage });
      response.badRequest(res, safeMessage || 'YinziAPI 配置失败');
    }
  };
}

/** ModelArk / 方舟私有资产库：代理调用 CreateAssetGroup、ListAssets 等（与官方 Action 名一致） */
function modelArkAsset(log) {
  return async (req, res) => {
    const body = req.body || {};
    const action = (body.action || '').toString().trim();
    try {
      const modelArkAssetProxyService = require('../services/modelArkAssetProxyService');
      const data = await modelArkAssetProxyService.callModelArkAsset(
        {
          base_url: body.base_url,
          api_key: body.api_key,
          action,
          body: body.payload,
          path_mode: body.path_mode,
          http_method: body.http_method,
          api_version: body.api_version,
          auth_mode: body.auth_mode,
          access_key_id: body.access_key_id,
          secret_access_key: body.secret_access_key,
          sign_region: body.sign_region,
          sign_service: body.sign_service,
          session_token: body.session_token,
          project_name: body.project_name,
        },
        log
      );
      response.success(res, data);
    } catch (err) {
      log.error('model-ark-asset proxy failed', { error: err.message, action });
      const status = err.status >= 400 && err.status < 600 ? err.status : 400;
      return response.error(res, status, 'MODEL_ARK_ASSET', err.message || '请求失败', err.payload);
    }
  };
}

/** 即梦2角色认证：代理 GET 素材列表（表单未保存也可用当前填写的网关与 Token） */
function listJimeng2MaterialAssets(log) {
  return async (req, res) => {
    const body = req.body || {};
    const base_url = (body.base_url || '').toString().trim().replace(/\/$/, '');
    const { normalizeMaterialHubToken } = require('../services/jimengMaterialHubService');
    let api_key = normalizeMaterialHubToken(body.api_key || '');
    if (!base_url || !api_key) {
      return response.badRequest(res, '请先填写网关 URL 与 Token');
    }
    const jimengMaterialHubService = require('../services/jimengMaterialHubService');
    const ctx = { baseUrl: base_url, token: api_key };
    const r = await jimengMaterialHubService.listAssets(ctx, { limit: body.limit, cursor: body.cursor }, log);
    if (!r.ok) {
      return response.badRequest(res, String(r.error || '列出素材失败').slice(0, 800));
    }
    response.success(res, r.data);
  };
}

module.exports = function aiConfigRoutes(db, log, cfg) {
  return {
    list: list(db),
    get: get(db),
    vendorLock: vendorLock(cfg),
    create: create(db, log, cfg),
    update: update(db, log, cfg),
    delete: remove(db, log, cfg),
    testConnection: testConnection(db, log),
    discoverModels: discoverModels(db, log),
    yinziCatalog: yinziCatalog(log),
    setupYinzi: setupYinzi(db, log, cfg),
    listJimeng2MaterialAssets: listJimeng2MaterialAssets(log),
    modelArkAsset: modelArkAsset(log),
    bulkUpdateKey: bulkUpdateKey(db, log, cfg),
    modelCapabilities: modelCapabilities(db),
    updateModelCapabilities: updateModelCapabilities(db, log),
  };
};
