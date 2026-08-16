const aiConfigService = require('./aiConfigService');
const { getYinziVideoCapability } = require('./yinziVideoCapabilities');
const { resolveYinziVideoPrices } = require('./yinziVideoDefaults');
const { selectShotVideoRoute } = require('./productionVideoRouter');
const crypto = require('node:crypto');

const YINZI_CATALOG_URL = 'https://yinziapi.top/api/pricing';
const YINZI_DEFAULT_BASE_URL = 'https://api.yinziapi.top/v1';
const CATALOG_TTL_MS = 5 * 60 * 1000;
const CAPABILITY_CATALOG_TTL_MS = 60 * 1000;

let catalogCache = null;
const capabilityCatalogCache = new Map();

function normalizeYinziBaseUrl(value) {
  const raw = String(value || YINZI_DEFAULT_BASE_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_) {
    throw new Error('Base URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Base URL 仅支持 http 或 https');
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('Base URL 不能包含账号、密码或锚点');
  }
  parsed.search = '';
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!path) path = '/v1';
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

function normalizeOpaqueModel(value) {
  return String(value || '').trim();
}

function normalizePricing(item) {
  const groupPricing = item && item.group_pricing && typeof item.group_pricing === 'object'
    ? Object.values(item.group_pricing)
    : [];
  return groupPricing.map((price) => ({
    group: String(price.group || ''),
    billing_mode: String(price.billing_mode || ''),
    billing_unit: String(price.billing_unit || ''),
    effective_price: price.effective_model_price != null && Number.isFinite(Number(price.effective_model_price))
      ? Number(price.effective_model_price)
      : null,
    effective_input_usd: price.effective_input_usd != null && Number.isFinite(Number(price.effective_input_usd))
      ? Number(price.effective_input_usd)
      : null,
    effective_output_usd: price.effective_output_usd != null && Number.isFinite(Number(price.effective_output_usd))
      ? Number(price.effective_output_usd)
      : null,
    fixed_duration_seconds: price.fixed_duration_seconds != null && Number.isFinite(Number(price.fixed_duration_seconds))
      ? Number(price.fixed_duration_seconds)
      : null,
    currency: 'CNY',
  }));
}

function normalizeCatalogItem(item, pricingVersion = '') {
  const endpointTypes = Array.isArray(item?.supported_endpoint_types)
    ? item.supported_endpoint_types.map((v) => String(v))
    : [];
  const normalizedPrices = normalizePricing(item);
  const prices = endpointTypes.includes('openai-video')
    ? resolveYinziVideoPrices(item?.model_name, normalizedPrices, String(pricingVersion || ''))
    : normalizedPrices;
  const fixedPrices = prices
    .map((p) => p.effective_price)
    .filter((p) => Number.isFinite(p));
  return {
    model: normalizeOpaqueModel(item?.model_name),
    endpoint_types: endpointTypes,
    groups: Array.isArray(item?.enable_groups) ? item.enable_groups.map((v) => String(v)) : [],
    prices,
    cheapest_effective_price: fixedPrices.length ? Math.min(...fixedPrices) : null,
    capabilities: getYinziVideoCapability(item?.model_name),
    capability_source: getYinziVideoCapability(item?.model_name) ? 'builtin_fallback' : 'unknown',
    contract_status: getYinziVideoCapability(item?.model_name) ? 'known' : 'missing',
    automatic_eligible: getYinziVideoCapability(item?.model_name)?.automatic_eligible === true,
  };
}

function recommendedRank(kind, model) {
  const recommendations = {
    text: ['gpt-5.6-sol', 'gpt-5.4-mini', 'deepseek-v4-flash', 'gpt-5.6-terra', 'gpt-5.4'],
    image: ['gpt-image-2', 'flux-2-pro', 'seedream-v5-lite'],
    video: [
      'seedance2.0 720p-pro-nv-nsp',
      'seedance-2.5-720p',
      'seedance2.0 -720p-fast-15s',
      'cm-seedance2.0特价fast-720p-gz-15s',
      '官转-seedance2.0 720p-fast',
    ],
  };
  const index = (recommendations[kind] || []).indexOf(model);
  return index === -1 ? 1000 : index;
}

function sortCatalogItems(kind, items) {
  return items.sort((a, b) => {
    const rankDiff = recommendedRank(kind, a.model) - recommendedRank(kind, b.model);
    if (rankDiff !== 0) return rankDiff;
    return a.model.localeCompare(b.model, 'zh-CN');
  });
}

function normalizeYinziCatalog(payload) {
  if (!payload || payload.success === false || !Array.isArray(payload.data)) {
    throw new Error('模型目录返回格式异常');
  }
  const all = payload.data
    .map((item) => normalizeCatalogItem(item, payload.pricing_version))
    .filter((item) => item.model);
  const image = sortCatalogItems('image', all.filter((item) => item.endpoint_types.includes('image-generation')));
  const video = sortCatalogItems('video', all.filter((item) => item.endpoint_types.includes('openai-video')));
  const text = sortCatalogItems(
    'text',
    all.filter((item) => item.endpoint_types.includes('openai')
      && !item.endpoint_types.includes('image-generation')
      && !item.endpoint_types.includes('openai-video'))
  );
  return {
    source: YINZI_CATALOG_URL,
    pricing_version: String(payload.pricing_version || ''),
    fetched_at: new Date().toISOString(),
    text,
    image,
    video,
  };
}

async function fetchYinziCatalog(fetchImpl = fetch, options = {}) {
  const now = Date.now();
  const useCache = options.use_cache !== false && fetchImpl === fetch;
  if (useCache && catalogCache && now - catalogCache.cachedAt < CATALOG_TTL_MS) {
    return catalogCache.value;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(YINZI_CATALOG_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`模型目录请求失败: HTTP ${res.status}`);
    const normalized = normalizeYinziCatalog(await res.json());
    if (useCache) catalogCache = { cachedAt: now, value: normalized };
    return normalized;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型目录请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function capabilityCatalogUrl(baseUrl) {
  const normalized = normalizeYinziBaseUrl(baseUrl);
  return `${normalized.replace(/\/+$/, '')}/model-capabilities`;
}

function normalizeCapabilityProfile(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const generation = contract.generation && typeof contract.generation === 'object' ? contract.generation : {};
  const duration = generation.duration && typeof generation.duration === 'object' ? generation.duration : {};
  const references = contract.references && typeof contract.references === 'object' ? contract.references : {};
  const limit = (key) => (references[key] && typeof references[key] === 'object' ? references[key] : {});
  const images = limit('images');
  const videos = limit('videos');
  const audios = limit('audios');
  const routing = contract.routing && typeof contract.routing === 'object' ? contract.routing : {};
  const provider = contract.provider && typeof contract.provider === 'object' ? contract.provider : {};
  const provenance = contract.provenance && typeof contract.provenance === 'object' ? contract.provenance : {};
  const profile = {
    provider_contract: String(provider.protocol || 'unknown'),
    duration_mode: String(duration.mode || 'free'),
    duration_min: Number.isFinite(Number(duration.min)) ? Number(duration.min) : 0,
    duration_max: Number.isFinite(Number(duration.max)) ? Number(duration.max) : 0,
    duration_step: Number.isFinite(Number(duration.step)) ? Number(duration.step) : 1,
    fixed_duration_seconds: Number.isFinite(Number(duration.fixed)) ? Number(duration.fixed) : undefined,
    max_images: Number.isFinite(Number(images.max)) ? Number(images.max) : 0,
    max_videos: Number.isFinite(Number(videos.max)) ? Number(videos.max) : 0,
    max_audios: Number.isFinite(Number(audios.max)) ? Number(audios.max) : 0,
    max_total_references: Number.isFinite(Number(references.max_total)) ? Number(references.max_total) : 0,
    max_reference_video_seconds_total: Number.isFinite(Number(videos.max_total_duration_seconds)) ? Number(videos.max_total_duration_seconds) : 0,
    max_prompt_chars: Number.isFinite(Number(references.prompt_max_chars)) ? Number(references.prompt_max_chars) : 0,
    resolution: Array.isArray(generation.resolutions) && generation.resolutions.length ? String(generation.resolutions[0]) : '',
    quality_tier: String(generation.quality || ''),
    automatic_eligible: routing.automatic_eligible === true && routing.manual_only !== true,
    expensive_bypass: routing.expensive === true,
    requires_director_preview: routing.requires_explicit_confirmation === true,
    roles: {
      image: Array.isArray(images.roles) ? images.roles.map((v) => String(v)) : [],
      video: Array.isArray(videos.roles) ? videos.roles.map((v) => String(v)) : [],
      audio: Array.isArray(audios.roles) ? audios.roles.map((v) => String(v)) : [],
    },
    contract_revision: String(contract.revision || ''),
    validation_status: String(provenance.validation_status || ''),
  };
  for (const key of Object.keys(profile)) {
    if (profile[key] === undefined) delete profile[key];
  }
  return profile;
}

function normalizeCapabilityPrice(entry) {
  const price = entry?.local_pricing && typeof entry.local_pricing === 'object' ? entry.local_pricing : {};
  const consumer = entry?.capabilities?.commercial?.consumer_offer && typeof entry.capabilities.commercial.consumer_offer === 'object'
    ? entry.capabilities.commercial.consumer_offer : {};
  const effective = price.use_price === true && Number.isFinite(Number(price.model_price))
    ? Number(price.model_price)
    : Number.isFinite(Number(consumer.unit_price)) ? Number(consumer.unit_price) : null;
  const unit = String(consumer.billing_unit || price.task_profile?.unit || '');
  return {
    group: String(entry.group || ''),
    billing_mode: String(price.billing_mode || ''),
    billing_unit: unit,
    effective_price: effective,
    effective_input_usd: null,
    effective_output_usd: null,
    fixed_duration_seconds: Number.isFinite(Number(entry.capabilities?.generation?.duration?.fixed))
      ? Number(entry.capabilities.generation.duration.fixed) : null,
    currency: String(consumer.currency || 'CNY'),
    source: 'key_scoped_capability_catalog',
  };
}

function normalizeYinziCapabilityCatalog(payload, source) {
  if (!payload || !Array.isArray(payload.models)) {
    throw new Error('Yinzi 能力目录返回格式异常');
  }
  const byModel = new Map();
  for (const entry of payload.models) {
    const model = normalizeOpaqueModel(entry.model);
    if (!model) continue;
    let item = byModel.get(model);
    if (!item) {
      item = { model, endpoint_types: ['openai-video'], groups: [], prices: [], capabilities: null, capability_source: 'unknown', contract_status: 'missing', automatic_eligible: false };
      byModel.set(model, item);
    }
    const group = String(entry.group || '').trim();
    if (group && !item.groups.includes(group)) item.groups.push(group);
    if (entry.local_pricing || entry.capabilities?.commercial?.consumer_offer) item.prices.push(normalizeCapabilityPrice(entry));
    if (entry.capabilities) {
      const profile = normalizeCapabilityProfile(entry.capabilities);
      if (profile) {
        item.capabilities = profile;
        item.capability_source = 'key_scoped_contract';
        item.contract_status = String(entry.contract_status || 'active');
        item.automatic_eligible = entry.automatic_eligible === true && profile.automatic_eligible === true;
      }
    }
  }
  const video = sortCatalogItems('video', [...byModel.values()].map((item) => ({
    ...item,
    cheapest_effective_price: item.prices.map((p) => p.effective_price).filter(Number.isFinite).length
      ? Math.min(...item.prices.map((p) => p.effective_price).filter(Number.isFinite)) : null,
  })));
  return {
    source,
    pricing_version: String(payload.catalog_revision || ''),
    fetched_at: new Date().toISOString(),
    catalog_verified: true,
    availability_scope: 'credential',
    scope_verified: true,
    text: [],
    image: [],
    video,
  };
}

function capabilityCacheKey(config) {
  const base = normalizeYinziBaseUrl(config?.base_url);
  const keyHash = crypto.createHash('sha256').update(String(config?.api_key || '')).digest('hex').slice(0, 16);
  return `${base}\x00${keyHash}`;
}

async function fetchYinziCapabilityCatalog(config, fetchImpl = fetch) {
  const apiKey = String(config?.api_key || '').trim();
  if (!apiKey) throw new Error('能力目录需要 API Key');
  const url = capabilityCatalogUrl(config?.base_url);
  const cacheKey = capabilityCacheKey(config);
  const now = Date.now();
  const cached = capabilityCatalogCache.get(cacheKey);
  if (cached && now - cached.cachedAt < CAPABILITY_CATALOG_TTL_MS) return cached.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    if (!res.ok) {
      const error = new Error(`能力目录请求失败: HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const normalized = normalizeYinziCapabilityCatalog(await res.json(), url);
    capabilityCatalogCache.set(cacheKey, { cachedAt: now, value: normalized });
    return normalized;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('能力目录请求超时');
      timeoutError.code = 'CAPABILITY_CATALOG_NETWORK';
      throw timeoutError;
    }
    if (error?.status == null) error.code = error.code || 'CAPABILITY_CATALOG_NETWORK';
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYinziCatalogForConfig(config, fetchImpl = fetch) {
  try {
    return await fetchYinziCapabilityCatalog(config, fetchImpl);
  } catch (error) {
    const fallbackAllowed = error?.status === 404 || error?.status === 406 || error?.code === 'CAPABILITY_CATALOG_NETWORK';
    if (!fallbackAllowed) throw error;
    const legacy = await fetchYinziCatalog(fetchImpl, { use_cache: fetchImpl === fetch });
    return { ...legacy, source: 'legacy_fallback', catalog_verified: false, fallback_reason: error.message || 'capability catalog unavailable' };
  }
}

function normalizeModelList(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,，]/);
  const seen = new Set();
  return raw.map(normalizeOpaqueModel).filter((model) => {
    const key = model.toLowerCase();
    if (!model || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveYinziKeys(input = {}) {
  const universalKey = String(input.api_key || input.universal_api_key || '').trim();
  const textKey = String(input.text_api_key || '').trim() || universalKey;
  const imageKey = String(input.image_api_key || '').trim() || universalKey;
  const videoKey = String(input.video_api_key || '').trim() || universalKey;
  if (!textKey || !imageKey || !videoKey) {
    throw new Error('请填写一个通用 API Key；只有不同分组时才需要在高级设置覆盖各环节 Key');
  }
  return { universalKey, textKey, imageKey, videoKey };
}

function endpointTypes(item) {
  return Array.isArray(item?.endpoint_types)
    ? item.endpoint_types
    : Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types : [];
}

function modelsForService(items, serviceType) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const endpoints = endpointTypes(item);
    if (serviceType === 'video') return endpoints.includes('openai-video');
    if (serviceType === 'image') return endpoints.includes('image-generation');
    return endpoints.includes('openai')
      && !endpoints.includes('openai-video')
      && !endpoints.includes('image-generation');
  });
}

function preferredModel(requested, available, preferred, fallback) {
  const requestedModel = normalizeOpaqueModel(requested);
  if (requestedModel) return requestedModel;
  const names = (available || []).map((item) => normalizeOpaqueModel(item.model)).filter(Boolean);
  return names.find((model) => model === preferred) || names[0] || fallback;
}

function chooseDefaultYinziVideoModel(videoCatalog, requested = '') {
  const requestedModel = normalizeOpaqueModel(requested);
  if (requestedModel) return requestedModel;
  const items = Array.isArray(videoCatalog) ? videoCatalog : [];
  if (!items.length) return '';
  try {
    return selectShotVideoRoute({
      shot: { content: { duration: 5, previs_mode: 'skip', route_profile: 'short_image_guided' } },
      catalog: { video: items, fetched_at: new Date().toISOString(), pricing_version: '' },
      policy: { video_routing_mode: 'auto', video_quality: 'balanced', director_mode: 'off' },
    }).model;
  } catch (_) {
    return items.find((item) => item.capabilities?.automatic_eligible === true)?.model
      || items.find((item) => item.capabilities?.expensive_bypass !== true)?.model
      || items[0]?.model
      || '';
  }
}

async function prepareYinziSetupInput(input = {}, fetchImpl = fetch) {
  const baseUrl = normalizeYinziBaseUrl(input.base_url);
  const { universalKey, textKey, imageKey, videoKey } = resolveYinziKeys(input);
  const discoveryByKey = new Map();
  const discover = async (apiKey) => {
    if (!discoveryByKey.has(apiKey)) {
      discoveryByKey.set(apiKey, aiConfigService.discoverModels({
        base_url: baseUrl,
        api_key: apiKey,
        provider: 'yinzi',
      }, { fetchImpl }));
    }
    return discoveryByKey.get(apiKey);
  };

  const [textDiscovery, imageDiscovery, videoDiscovery, pricingCatalog] = await Promise.all([
    discover(textKey),
    discover(imageKey),
    discover(videoKey),
    fetchYinziCatalogForConfig({ base_url: baseUrl, api_key: videoKey }, fetchImpl),
  ]);
  const textEntries = modelsForService(textDiscovery.models, 'text');
  const imageEntries = modelsForService(imageDiscovery.models, 'image');
  const videoEntries = modelsForService(videoDiscovery.models, 'video');
  const mergedVideoCatalog = aiConfigService.mergeDiscoveredCatalog(videoDiscovery, pricingCatalog, {
    provider: 'yinzi',
    service_type: 'video',
  });
  const videoCatalog = (mergedVideoCatalog.video || []).filter((item) => endpointTypes(item).includes('openai-video'));
  if (!videoCatalog.length) {
    const error = new Error('当前 Key 没有返回可用视频模型；请展开高级设置填写视频分组 Key 后重试');
    error.code = 'YINZI_VIDEO_MODELS_EMPTY';
    throw error;
  }

  const textModel = preferredModel(input.text_model, textEntries, 'gpt-5.6-sol', 'gpt-5.6-sol');
  const imageModel = preferredModel(input.image_model, imageEntries, 'gpt-image-2', 'gpt-image-2');
  const videoModel = chooseDefaultYinziVideoModel(videoCatalog, input.video_model);
  const warnings = [];
  if (!textEntries.length) warnings.push('当前文本 Key 未返回文本模型，已保留 gpt-5.6-sol 默认值');
  if (!imageEntries.length) warnings.push('当前生图 Key 未返回生图模型，已保留 gpt-image-2 默认值');

  return {
    ...input,
    base_url: baseUrl,
    api_key: universalKey,
    text_api_key: textKey,
    image_api_key: imageKey,
    video_api_key: videoKey,
    text_model: textModel,
    image_model: imageModel,
    video_model: videoModel,
    text_models: normalizeModelList([...textEntries.map((item) => item.model), textModel]),
    image_models: normalizeModelList([...imageEntries.map((item) => item.model), imageModel]),
    video_models: normalizeModelList([...videoCatalog.map((item) => item.model), videoModel]),
    setup_catalog: {
      fetched_at: videoDiscovery.snapshot?.fetched_at || pricingCatalog.fetched_at || new Date().toISOString(),
      scope_verified: videoDiscovery.snapshot?.scope_verified === true,
      pricing_version: pricingCatalog.pricing_version || '',
      video_model_count: videoCatalog.length,
      selected_video_model: videoModel,
      selection_mode: 'lowest_estimated_shot_cost',
      warnings,
    },
  };
}

function yinziConfigDefinitions(input) {
  const baseUrl = normalizeYinziBaseUrl(input.base_url);
  const { textKey, imageKey, videoKey } = resolveYinziKeys(input);
  const textModel = normalizeOpaqueModel(input.text_model);
  const imageModel = normalizeOpaqueModel(input.image_model);
  const videoModel = normalizeOpaqueModel(input.video_model);
  if (!textModel || !imageModel || !videoModel) throw new Error('文本、图片、视频模型均为必填');
  const textModels = normalizeModelList([...(normalizeModelList(input.text_models)), textModel]);
  const imageModels = normalizeModelList([...(normalizeModelList(input.image_models)), imageModel]);
  const videoModels = normalizeModelList([
    ...(normalizeModelList(input.video_models)),
    videoModel,
  ]);
  const shared = { base_url: baseUrl, provider: 'yinzi', priority: 100, is_default: true };
  const commonSettings = { catalog_url: YINZI_CATALOG_URL, local_media_persistence: true };
  const settings = JSON.stringify(commonSettings);
  const videoSettings = JSON.stringify({
    ...commonSettings,
    auto_model_selection: true,
    model_catalog_snapshot: input.setup_catalog || null,
  });
  return [
    { ...shared, service_type: 'text', name: 'YinziAPI 文本', api_protocol: 'openai', api_key: textKey, model: textModels, default_model: textModel, endpoint: '/chat/completions', query_endpoint: '', settings },
    { ...shared, service_type: 'image', name: 'YinziAPI 文本生图', api_protocol: 'openai', api_key: imageKey, model: imageModels, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, service_type: 'storyboard_image', name: 'YinziAPI 分镜图', api_protocol: 'openai', api_key: imageKey, model: imageModels, default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, service_type: 'video', name: 'YinziAPI 视频', api_protocol: 'yinzi', api_key: videoKey, model: videoModels, default_model: videoModel, endpoint: '/videos', query_endpoint: '/videos/{taskId}', settings: videoSettings },
  ];
}

function upsertYinziConfigs(db, log, input) {
  const definitions = yinziConfigDefinitions(input || {});
  const apply = db.transaction(() => definitions.map((definition) => {
    const existing = db.prepare(
      `SELECT id FROM ai_service_configs
       WHERE deleted_at IS NULL AND provider = 'yinzi' AND service_type = ?
       ORDER BY is_default DESC, updated_at DESC, id DESC`
    ).all(definition.service_type);
    let config;
    if (existing.length) {
      config = aiConfigService.updateConfig(db, log, existing[0].id, definition);
      const duplicateIds = existing.slice(1).map((row) => row.id);
      if (duplicateIds.length) {
        const now = new Date().toISOString();
        const softDelete = db.prepare('UPDATE ai_service_configs SET deleted_at = ? WHERE id = ?');
        for (const id of duplicateIds) softDelete.run(now, id);
      }
    } else {
      config = aiConfigService.createConfig(db, log, definition);
    }
    return {
      id: config.id,
      service_type: config.service_type,
      name: config.name,
      model: config.default_model,
      is_default: config.is_default,
    };
  }));
  const configured = apply();
  return {
    provider: 'yinzi',
    base_url: definitions[0].base_url,
    routing_mode: 'auto',
    catalog: input.setup_catalog || null,
    configured,
  };
}

module.exports = {
  YINZI_CATALOG_URL,
  YINZI_DEFAULT_BASE_URL,
  normalizeYinziBaseUrl,
  normalizeYinziCatalog,
  fetchYinziCatalog,
  fetchYinziCapabilityCatalog,
  fetchYinziCatalogForConfig,
  normalizeYinziCapabilityCatalog,
  normalizeModelList,
  chooseDefaultYinziVideoModel,
  prepareYinziSetupInput,
  yinziConfigDefinitions,
  upsertYinziConfigs,
};
