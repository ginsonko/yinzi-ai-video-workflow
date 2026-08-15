const crypto = require('node:crypto');
const {
  getYinziVideoCapability,
  listYinziVideoCapabilities,
  capabilitySupportsRoute,
  capabilityAcceptsDuration,
  capabilitySupportsRole,
} = require('./yinziVideoCapabilities');

const ROUTE_PROFILES = Object.freeze({
  SHORT: 'short_image_guided',
  LONG: 'long_previs_guided',
});

function classifyShotRoute(shot, policy = {}) {
  const content = shot?.content || shot || {};
  const plannedDuration = Math.max(1, Math.round(Number(content.duration) || 5));
  const duration = Math.max(5, plannedDuration);
  const requested = String(content.route_profile || '').trim();
  const profile = requested === ROUTE_PROFILES.SHORT || requested === ROUTE_PROFILES.LONG
    ? requested
    : plannedDuration <= 5 ? ROUTE_PROFILES.SHORT : ROUTE_PROFILES.LONG;
  const shotId = shot?.scope_id ?? content.scope_id ?? content.number;
  const policyPrevisOverrides = policy.video_previs_overrides && typeof policy.video_previs_overrides === 'object'
    ? policy.video_previs_overrides
    : {};
  const policyPrevisMode = shotId == null ? '' : String(policyPrevisOverrides[String(shotId)] || '').trim();
  const contentPrevisMode = ['auto', 'force', 'skip'].includes(content.previs_mode)
    ? content.previs_mode
    : 'auto';
  const requestedPrevisMode = ['force', 'skip'].includes(policyPrevisMode)
    ? policyPrevisMode
    : contentPrevisMode;
  const directorMode = String(policy.director_mode || 'auto') === 'off' ? 'off' : 'auto';
  const previsMode = directorMode === 'off' ? 'skip' : requestedPrevisMode;
  const isLongTake = profile === ROUTE_PROFILES.LONG;
  const transitionMode = String(content.transition_mode || '').trim();
  return {
    profile,
    planned_duration: plannedDuration,
    duration,
    duration_adjusted: duration !== plannedDuration,
    duration_adjustment_reason: duration !== plannedDuration ? 'jimeng_minimum_5_seconds' : null,
    // Reference support is a capability of the chosen model; using it is a
    // per-shot editorial decision. Explicit skip must win for every duration.
    uses_reference_video: isLongTake && previsMode !== 'skip',
    requires_director_preview: previsMode === 'force' || (isLongTake && previsMode !== 'skip'),
    previs_mode: previsMode,
    director_mode: directorMode,
    transition_mode: transitionMode,
    requires_strict_first_frame: transitionMode === 'strict_continuation',
  };
}

function normalizeCatalog(catalog) {
  const items = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.video) ? catalog.video : [];
  return items.map((item) => ({
    ...item,
    model: String(item?.model || item?.model_name || '').trim(),
    endpoint_types: item?.endpoint_types || item?.supported_endpoint_types || [],
    groups: item?.groups || item?.enable_groups || [],
    prices: Array.isArray(item?.prices) ? item.prices : [],
  })).filter((item) => item.model);
}

function shotModelOverride(shot, policy = {}) {
  const contentOverride = String(shot?.content?.video_model_override || '').trim();
  if (contentOverride) return contentOverride;
  const shotId = shot?.scope_id ?? shot?.content?.number;
  if (shotId == null) return '';
  const overrides = policy.video_model_overrides && typeof policy.video_model_overrides === 'object'
    ? policy.video_model_overrides
    : {};
  return String(overrides[String(shotId)] || '').trim();
}

function priceForCatalogItem(item, group) {
  const prices = Array.isArray(item?.prices) ? item.prices : [];
  const matching = group ? prices.filter((price) => price.group === group) : prices;
  const usable = (matching.length ? matching : prices)
    .filter((price) => Number.isFinite(Number(price.effective_price)));
  if (!usable.length) return null;
  return usable.sort((left, right) => Number(left.effective_price) - Number(right.effective_price))[0];
}

function estimatePrice(price, duration) {
  if (!price || !Number.isFinite(Number(price.effective_price))) return null;
  if (price.billing_unit === 'per_second') {
    return Number((Number(price.effective_price) * Number(duration)).toFixed(4));
  }
  return Number(Number(price.effective_price).toFixed(4));
}

function qualityPenalty(capability, qualityPolicy) {
  const tier = capability?.quality_tier;
  if (qualityPolicy === 'quality') {
    if (capability?.resolution === '720p' && tier === 'quality') return -40;
    if (capability?.resolution === '720p') return -20;
  }
  if (qualityPolicy === 'economy' && tier === 'economy') return -30;
  if (qualityPolicy === 'speed' && tier === 'fast') return -30;
  return 0;
}

function materialRoutePayload(route) {
  return {
    profile: route.profile,
    model: route.model,
    planned_duration: route.planned_duration,
    duration: route.duration,
    duration_adjusted: route.duration_adjusted,
    resolution: route.resolution,
    requires_director_preview: route.requires_director_preview,
    uses_reference_video: route.uses_reference_video,
    director_mode: route.director_mode,
    transition_mode: route.transition_mode,
    requires_strict_first_frame: route.requires_strict_first_frame,
    limits: route.limits,
    roles: route.roles,
  };
}

function routingMaterialSignature(route) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(materialRoutePayload(route)))
    .digest('hex');
}

function fixedModelRoute(shot, model, policy = {}) {
  const classified = classifyShotRoute(shot, policy);
  const capability = getYinziVideoCapability(model);
  if (!capability) {
    return {
      ...classified,
      model: String(model || '').trim(),
      capability: null,
      catalog_verified: false,
      automatic: false,
      resolution: policy.video_resolution || null,
      limits: null,
      roles: null,
      reason_codes: ['fixed_unknown_contract'],
      estimated_price: null,
      billing_unit: null,
    };
  }
  if (!capabilityAcceptsDuration(capability, classified.duration)) {
    const error = new Error(`${model} 不支持 ${classified.duration} 秒镜头，系统不会静默修改分镜时长`);
    error.code = 'VIDEO_ROUTE_DURATION_UNSUPPORTED';
    throw error;
  }
  if (classified.uses_reference_video && Number(capability.max_videos) < 1) {
    const error = new Error(`${model} 不支持参考视频，不能用于 ${classified.duration} 秒长镜头路线`);
    error.code = 'VIDEO_ROUTE_REFERENCE_UNSUPPORTED';
    throw error;
  }
  if (classified.requires_strict_first_frame && !capabilitySupportsRole(capability, 'image', 'first_frame')) {
    const error = new Error(`${model} does not support strict first-frame continuation`);
    error.code = 'STRICT_FIRST_FRAME_UNSUPPORTED';
    throw error;
  }
  const route = {
    ...classified,
    model: String(model || '').trim(),
    capability,
    catalog_verified: false,
    automatic: false,
    resolution: policy.video_resolution || capability.resolution,
    limits: {
      images: capability.max_images,
      videos: classified.uses_reference_video ? capability.max_videos : 0,
      audios: capability.max_audios,
    },
    roles: capability.roles,
    reason_codes: ['fixed_model_override'],
    estimated_price: null,
    billing_unit: null,
  };
  route.material_signature = routingMaterialSignature(route);
  return route;
}

function selectShotVideoRoute(input) {
  const { shot, catalog, policy = {} } = input || {};
  const classified = classifyShotRoute(shot, policy);
  const routingMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  const manualModel = shotModelOverride(shot, policy);
  if (routingMode === 'fixed' || manualModel) {
    const fixed = fixedModelRoute(shot, manualModel || policy.video_model, policy);
    const catalogItems = normalizeCatalog(catalog);
    if (!catalogItems.length) {
      const error = new Error('实时视频模型目录不可用，固定模型也不会在未核对目录时提交');
      error.code = 'VIDEO_ROUTE_CATALOG_UNAVAILABLE';
      throw error;
    }
    const catalogItem = catalogItems.find((item) => item.model === fixed.model);
    if (!catalogItem) {
      const error = new Error(`当前实时目录中找不到视频模型 ${fixed.model}`);
      error.code = 'VIDEO_ROUTE_MODEL_UNAVAILABLE';
      throw error;
    }
    const group = String(policy.video_group || '').trim();
    if (group && !catalogItem.groups.includes(group)) {
      const error = new Error(`视频模型 ${fixed.model} 不在当前分组 ${group} 中`);
      error.code = 'VIDEO_ROUTE_GROUP_UNAVAILABLE';
      throw error;
    }
    const price = priceForCatalogItem(catalogItem, group);
    fixed.reason_codes = manualModel ? ['shot_model_override'] : fixed.reason_codes;
    fixed.catalog_verified = true;
    fixed.catalog_version = String(catalog?.pricing_version || '');
    fixed.catalog_fetched_at = catalog?.fetched_at || null;
    fixed.group = group || price?.group || catalogItem.groups?.[0] || null;
    fixed.billing_unit = price?.billing_unit || null;
    fixed.unit_price = price?.effective_price ?? null;
    fixed.estimated_price = estimatePrice(price, fixed.duration);
    fixed.material_signature = routingMaterialSignature(fixed);
    return fixed;
  }

  const catalogItems = normalizeCatalog(catalog);
  if (!catalogItems.length) {
    const error = new Error('实时视频模型目录不可用，自动路由已在付费提交前停止');
    error.code = 'VIDEO_ROUTE_CATALOG_UNAVAILABLE';
    throw error;
  }
  const qualityPolicy = String(policy.video_quality || 'balanced');
  const group = String(policy.video_group || '').trim();
  const allowFixed = policy.allow_fixed_15s === true;
  const allowBypass = policy.allow_expensive_bypass === true;
  const evaluated = [];
  for (const item of catalogItems) {
    const capability = getYinziVideoCapability(item.model);
    const reasons = [];
    if (!capability) reasons.push('unknown_contract');
    if (capability && !capabilitySupportsRoute(capability, classified.profile)) reasons.push('profile_mismatch');
    if (capability && !capabilityAcceptsDuration(capability, classified.duration, { automatic: true })) reasons.push('duration_mismatch');
    if (capability && classified.uses_reference_video && capability.max_videos < 1) reasons.push('video_reference_required');
    if (capability && classified.requires_strict_first_frame
      && !capabilitySupportsRole(capability, 'image', 'first_frame')) reasons.push('strict_first_frame_required');
    if (capability && !capability.automatic_eligible) reasons.push(capability.exclusion_reason || 'not_automatic');
    if (capability?.duration_mode === 'fixed' && !allowFixed) reasons.push('fixed_duration_disabled');
    if (capability?.expensive_bypass && !allowBypass) reasons.push('expensive_bypass_disabled');
    if (group && Array.isArray(item.groups) && !item.groups.includes(group)) reasons.push('group_unavailable');
    const price = priceForCatalogItem(item, group);
    const estimated = estimatePrice(price, classified.duration);
    const shortMultimodalPenalty = capability
      && !classified.uses_reference_video
      && capability.max_videos > 0
      && classified.profile === ROUTE_PROFILES.SHORT ? 5 : 0;
    const score = Number(capability?.preference_rank || 1000)
      + qualityPenalty(capability, qualityPolicy)
      + shortMultimodalPenalty
      + (estimated == null ? 25 : estimated);
    evaluated.push({ item, capability, price, estimated, reasons: [...new Set(reasons)], score });
  }
  const eligible = evaluated.filter((candidate) => candidate.reasons.length === 0)
    .sort((left, right) => left.score - right.score || left.item.model.localeCompare(right.item.model));
  if (!eligible.length) {
    const error = new Error(`${classified.duration} 秒镜头没有满足媒体、时长和费用策略的视频模型`);
    error.code = 'VIDEO_ROUTE_NO_ELIGIBLE_MODEL';
    error.details = evaluated.map((candidate) => ({ model: candidate.item.model, reasons: candidate.reasons }));
    throw error;
  }
  const selected = eligible[0];
  const capability = selected.capability;
  const route = {
    ...classified,
    model: selected.item.model,
    capability,
    catalog_verified: true,
    catalog_version: String(catalog?.pricing_version || ''),
    catalog_fetched_at: catalog?.fetched_at || null,
    group: group || selected.price?.group || selected.item.groups?.[0] || null,
    automatic: true,
    resolution: policy.video_resolution || capability.resolution,
    limits: {
      images: capability.max_images,
      videos: classified.uses_reference_video ? capability.max_videos : 0,
      audios: capability.max_audios,
    },
    roles: capability.roles,
    billing_unit: selected.price?.billing_unit || null,
    unit_price: selected.price?.effective_price ?? null,
    estimated_price: selected.estimated,
    queue_signal: 'unknown',
    reason_codes: classified.profile === ROUTE_PROFILES.SHORT
      ? [
        'short_complete_visual_beat',
        ...(classified.duration_adjusted ? ['provider_minimum_duration_5s'] : ['free_duration_exact_fit']),
        'image_references_only',
        ...(classified.director_mode === 'off' ? ['director_disabled_for_run'] : []),
        ...(classified.previs_mode === 'force' ? ['director_preview_forced_locally'] : []),
      ]
      : classified.previs_mode === 'skip'
        ? [
          'long_continuous_take',
          classified.director_mode === 'off' ? 'director_disabled_for_run' : 'director_preview_skipped_by_user',
          'image_references_only',
          ...(classified.duration_adjusted ? ['provider_minimum_duration_5s'] : []),
        ]
        : ['long_continuous_take', 'reference_video_supported', 'director_preview_required'],
    candidates: eligible.slice(0, 4).map((candidate) => ({
      model: candidate.item.model,
      estimated_price: candidate.estimated,
      billing_unit: candidate.price?.billing_unit || null,
      resolution: candidate.capability.resolution,
      quality_tier: candidate.capability.quality_tier,
    })),
  };
  route.material_signature = routingMaterialSignature(route);
  return route;
}

function listShotVideoRouteOptions(input) {
  const { shot, catalog, policy = {} } = input || {};
  const items = normalizeCatalog(catalog);
  const group = String(policy.video_group || '').trim();
  const projectMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  const currentModel = shotModelOverride(shot, policy)
    || (projectMode === 'fixed' ? String(policy.video_model || '').trim() : '');
  return items.map((item) => {
    const capability = getYinziVideoCapability(item.model);
    const groupAvailable = !group || item.groups.includes(group);
    let route = null;
    let error = null;
    try {
      route = fixedModelRoute(shot, item.model, policy);
    } catch (caught) {
      error = caught;
    }
    const price = priceForCatalogItem(item, group);
    const warnings = [];
    if (capability?.expensive_bypass) warnings.push('expensive_bypass');
    if (capability?.duration_mode === 'fixed') warnings.push('fixed_duration_product');
    if (!capability) warnings.push('unknown_contract');
    if (!groupAvailable) warnings.push('group_unavailable');
    const compatible = Boolean(route && capability && groupAvailable);
    return {
      model: item.model,
      name: item.name || item.model,
      groups: item.groups,
      group,
      group_available: groupAvailable,
      compatible,
      selectable: compatible,
      incompatibility_code: !groupAvailable
        ? 'VIDEO_ROUTE_GROUP_UNAVAILABLE'
        : error?.code || (!capability ? 'VIDEO_ROUTE_UNKNOWN_CONTRACT' : null),
      incompatibility_reason: !groupAvailable
        ? `不在当前分组 ${group}`
        : error?.message || (!capability ? '本地尚未登记该模型的媒体契约' : null),
      warnings,
      requires_explicit_confirmation: capability?.expensive_bypass === true,
      resolution: capability?.resolution || null,
      quality_tier: capability?.quality_tier || null,
      duration_mode: capability?.duration_mode || null,
      duration_min: capability?.duration_min ?? null,
      duration_max: capability?.duration_max ?? null,
      fixed_duration_seconds: capability?.fixed_duration_seconds ?? null,
      limits: capability ? {
        images: capability.max_images,
        videos: route?.uses_reference_video ? capability.max_videos : 0,
        audios: capability.max_audios,
      } : null,
      roles: capability?.roles || null,
      billing_unit: price?.billing_unit || null,
      unit_price: price?.effective_price ?? null,
      estimated_price: route ? estimatePrice(price, route.duration) : null,
      route: route ? {
        profile: route.profile,
        planned_duration: route.planned_duration,
        duration: route.duration,
        uses_reference_video: route.uses_reference_video,
        requires_director_preview: route.requires_director_preview,
      } : null,
      selected: item.model === currentModel,
    };
  });
}

function staticRoutePreview(shot, policy = {}) {
  const catalog = {
    pricing_version: '',
    fetched_at: null,
    video: listYinziVideoCapabilities().map(({ model, capability }) => ({
      model,
      endpoint_types: ['openai-video'],
      groups: [],
      prices: [],
      capabilities: capability,
    })),
  };
  const previewPolicy = { ...policy, video_group: '' };
  const route = selectShotVideoRoute({ shot, catalog, policy: previewPolicy });
  return { ...route, catalog_verified: false, reason_codes: [...route.reason_codes, 'static_catalog_preview'] };
}

module.exports = {
  ROUTE_PROFILES,
  classifyShotRoute,
  fixedModelRoute,
  shotModelOverride,
  selectShotVideoRoute,
  listShotVideoRouteOptions,
  routingMaterialSignature,
  staticRoutePreview,
};
