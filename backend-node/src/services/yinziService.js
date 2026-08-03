const aiConfigService = require('./aiConfigService');
const { getYinziVideoCapability } = require('./yinziVideoCapabilities');

const YINZI_CATALOG_URL = 'https://yinziapi.top/api/pricing';
const YINZI_DEFAULT_BASE_URL = 'https://api.yinziapi.top/v1';
const CATALOG_TTL_MS = 5 * 60 * 1000;

let catalogCache = null;

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
    effective_price: Number.isFinite(Number(price.effective_model_price))
      ? Number(price.effective_model_price)
      : null,
    effective_input_usd: Number.isFinite(Number(price.effective_input_usd))
      ? Number(price.effective_input_usd)
      : null,
    effective_output_usd: Number.isFinite(Number(price.effective_output_usd))
      ? Number(price.effective_output_usd)
      : null,
  }));
}

function normalizeCatalogItem(item) {
  const endpointTypes = Array.isArray(item?.supported_endpoint_types)
    ? item.supported_endpoint_types.map((v) => String(v))
    : [];
  const prices = normalizePricing(item);
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
  };
}

function recommendedRank(kind, model) {
  const recommendations = {
    text: ['gpt-5.4-mini', 'deepseek-v4-flash', 'gpt-5.6-terra', 'gpt-5.4', 'gpt-5.6-sol'],
    image: ['gpt-image-2', 'flux-2-pro', 'seedream-v5-lite'],
    video: ['mg-seedance2.0 -480p mini', 'mg-seedance2.0 -480p fast', 'mg-seedance2.0 -720p mini'],
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
  const all = payload.data.map(normalizeCatalogItem).filter((item) => item.model);
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

async function fetchYinziCatalog(fetchImpl = fetch) {
  const now = Date.now();
  if (catalogCache && now - catalogCache.cachedAt < CATALOG_TTL_MS) {
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
    catalogCache = { cachedAt: now, value: normalized };
    return normalized;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('模型目录请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function yinziConfigDefinitions(input) {
  const baseUrl = normalizeYinziBaseUrl(input.base_url);
  const textKey = String(input.text_api_key || '').trim();
  const imageKey = String(input.image_api_key || '').trim();
  const videoKey = String(input.video_api_key || '').trim();
  const textModel = normalizeOpaqueModel(input.text_model);
  const imageModel = normalizeOpaqueModel(input.image_model);
  const videoModel = normalizeOpaqueModel(input.video_model);
  if (!textKey || !imageKey || !videoKey) throw new Error('文本、图片、视频 API Key 均为必填');
  if (!textModel || !imageModel || !videoModel) throw new Error('文本、图片、视频模型均为必填');
  const shared = { base_url: baseUrl, provider: 'yinzi', priority: 100, is_default: true };
  const settings = JSON.stringify({ catalog_url: YINZI_CATALOG_URL, local_media_persistence: true });
  return [
    { ...shared, service_type: 'text', name: 'YinziAPI 文本', api_protocol: 'openai', api_key: textKey, model: [textModel], default_model: textModel, endpoint: '/chat/completions', query_endpoint: '', settings },
    { ...shared, service_type: 'image', name: 'YinziAPI 文本生图', api_protocol: 'openai', api_key: imageKey, model: [imageModel], default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, service_type: 'storyboard_image', name: 'YinziAPI 分镜图', api_protocol: 'openai', api_key: imageKey, model: [imageModel], default_model: imageModel, endpoint: '/images/generations', query_endpoint: '', settings },
    { ...shared, service_type: 'video', name: 'YinziAPI 视频', api_protocol: 'yinzi', api_key: videoKey, model: [videoModel], default_model: videoModel, endpoint: '/videos', query_endpoint: '/videos/{taskId}', settings },
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
    configured,
  };
}

module.exports = {
  YINZI_CATALOG_URL,
  YINZI_DEFAULT_BASE_URL,
  normalizeYinziBaseUrl,
  normalizeYinziCatalog,
  fetchYinziCatalog,
  yinziConfigDefinitions,
  upsertYinziConfigs,
};
