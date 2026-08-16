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

function priceForCatalogItem(item, group, duration = null) {
  const prices = Array.isArray(item?.prices) ? item.prices : [];
  const matching = group ? prices.filter((price) => price.group === group) : prices;
  const usable = (matching.length ? matching : prices)
    .filter((price) => estimatePrice(price, duration) != null);
  if (!usable.length) return null;
  return usable.sort((left, right) => {
    const estimatedDiff = Number(estimatePrice(left, duration)) - Number(estimatePrice(right, duration));
    if (estimatedDiff !== 0) return estimatedDiff;
    return String(left.billing_unit || '').localeCompare(String(right.billing_unit || ''));
  })[0];
}

function estimatePrice(price, duration) {
  if (!price || !Number.isFinite(Number(price.effective_price))) return null;
  if (price.billing_unit === 'per_second') {
    if (!Number.isFinite(Number(duration))) return null;
    return Number((Number(price.effective_price) * Number(duration)).toFixed(4));
  }
  if (['per_request', 'per_generation', 'fixed_duration'].includes(price.billing_unit)) {
    return Number(Number(price.effective_price).toFixed(4));
  }
  return null;
}

function qualityPreferenceRank(capability, qualityPolicy) {
  const tier = capability?.quality_tier;
  const policyOrder = {
    quality: ['quality', 'balanced', 'fast', 'economy'],
    speed: ['fast', 'balanced', 'economy', 'quality'],
    economy: ['economy', 'fast', 'balanced', 'quality'],
    balanced: ['balanced', 'fast', 'quality', 'economy'],
  };
  const order = policyOrder[qualityPolicy] || policyOrder.balanced;
  const index = order.indexOf(tier);
  return index === -1 ? order.length : index;
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
    group: route.group || null,
    group_available: route.group_available !== false,
    contract_status: route.contract_status || (route.capability ? 'known' : 'missing'),
    contract_warnings: route.contract_warnings || [],
    limits: route.limits,
    roles: route.roles,
  };
}

function routingMaterialSignature(route) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(materialRoutePayload(route)))
    .digest('hex');
}

function fixedModelRoute(shot, model, policy = {}, capabilityInput = undefined, capabilityStatus = null) {
  const classified = classifyShotRoute(shot, policy);
  const capability = capabilityInput === undefined ? getYinziVideoCapability(model) : capabilityInput;
  if (!capability) {
    const route = {
      ...classified,
      model: String(model || '').trim(),
      capability: null,
      catalog_verified: false,
      automatic: false,
      resolution: policy.video_resolution || null,
      limits: null,
      roles: null,
      reason_codes: ['fixed_unknown_contract'],
      contract_status: 'missing',
      contract_warnings: ['unknown_contract'],
      estimated_price: null,
      billing_unit: null,
    };
    route.material_signature = routingMaterialSignature(route);
    return route;
  }
  const contractWarnings = [];
  if (!capabilityAcceptsDuration(capability, classified.duration)) contractWarnings.push('duration_mismatch');
  if (classified.uses_reference_video && Number(capability.max_videos) < 1) contractWarnings.push('video_reference_unsupported');
  if (classified.requires_strict_first_frame && !capabilitySupportsRole(capability, 'image', 'first_frame')) contractWarnings.push('strict_first_frame_unsupported');
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
    contract_status: capabilityStatus || 'known',
    contract_warnings: contractWarnings,
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
  const catalogItems = normalizeCatalog(catalog);
  if (routingMode === 'fixed' || manualModel) {
    const selectedModel = manualModel || policy.video_model;
    const catalogItem = catalogItems.find((item) => item.model.toLowerCase() === String(selectedModel || '').toLowerCase());
    const fixed = fixedModelRoute(
      shot,
      selectedModel,
      policy,
      catalogItem?.capabilities,
      catalogItem?.contract_status || null,
    );
    const group = String(policy.video_group || '').trim();
    const groupAvailable = !group || Boolean(catalogItem?.groups?.includes(group));
    const price = catalogItem ? priceForCatalogItem(catalogItem, group, fixed.duration) : null;
    fixed.reason_codes = manualModel ? ['shot_model_override'] : fixed.reason_codes;
    fixed.catalog_verified = Boolean(catalogItem);
    fixed.catalog_version = String(catalog?.pricing_version || '');
    fixed.catalog_fetched_at = catalog?.fetched_at || null;
    fixed.group = group || price?.group || catalogItem?.groups?.[0] || null;
    fixed.group_available = groupAvailable;
    fixed.contract_warnings = [
      ...(fixed.contract_warnings || []),
      ...(!catalogItem ? ['model_not_in_catalog'] : []),
      ...(group && !groupAvailable ? ['group_unavailable'] : []),
    ];
    fixed.billing_unit = price?.billing_unit || null;
    fixed.unit_price = price?.effective_price ?? null;
    fixed.estimated_price = estimatePrice(price, fixed.duration);
    fixed.currency = price?.currency || null;
    fixed.material_signature = routingMaterialSignature(fixed);
    return fixed;
  }

  if (!catalogItems.length) {
    const error = new Error('实时视频模型目录不可用，自动路由已在付费提交前停止');
    error.code = 'VIDEO_ROUTE_CATALOG_UNAVAILABLE';
    throw error;
  }
  const qualityPolicy = String(policy.video_quality || 'balanced');
  const group = String(policy.video_group || '').trim();
  const allowBypass = policy.allow_expensive_bypass === true;
  const evaluated = [];
  for (const item of catalogItems) {
    const capability = item.capabilities || getYinziVideoCapability(item.model);
    const reasons = [];
    if (!capability) reasons.push('unknown_contract');
    if (capability && !capabilitySupportsRoute(capability, classified.profile)) reasons.push('profile_mismatch');
    if (capability && !capabilityAcceptsDuration(capability, classified.duration, { automatic: true })) reasons.push('duration_mismatch');
    if (capability && classified.uses_reference_video && capability.max_videos < 1) reasons.push('video_reference_required');
    if (capability && classified.requires_strict_first_frame
      && !capabilitySupportsRole(capability, 'image', 'first_frame')) reasons.push('strict_first_frame_required');
    if (capability && !capability.automatic_eligible) reasons.push(capability.exclusion_reason || 'not_automatic');
    if (capability?.expensive_bypass && !allowBypass) reasons.push('expensive_bypass_disabled');
    if (group && Array.isArray(item.groups) && !item.groups.includes(group)) reasons.push('group_unavailable');
    const price = priceForCatalogItem(item, group, classified.duration);
    const estimated = estimatePrice(price, classified.duration);
    if (estimated == null) reasons.push('price_unknown');
    const shortMultimodalPenalty = capability
      && !classified.uses_reference_video
      && capability.max_videos > 0
      && classified.profile === ROUTE_PROFILES.SHORT ? 5 : 0;
    evaluated.push({
      item,
      capability,
      price,
      estimated,
      reasons: [...new Set(reasons)],
      quality_rank: qualityPreferenceRank(capability, qualityPolicy),
      short_multimodal_penalty: shortMultimodalPenalty,
    });
  }
  const eligible = evaluated.filter((candidate) => candidate.reasons.length === 0)
    .sort((left, right) => Number(left.estimated) - Number(right.estimated)
      || left.quality_rank - right.quality_rank
      || left.short_multimodal_penalty - right.short_multimodal_penalty
      || Number(left.capability?.preference_rank || 1000) - Number(right.capability?.preference_rank || 1000)
      || left.item.model.localeCompare(right.item.model));
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
    currency: selected.price?.currency || null,
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
      currency: candidate.price?.currency || null,
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
    const capability = item.capabilities || getYinziVideoCapability(item.model);
    const groupAvailable = !group || item.groups.includes(group);
    let route = null;
    let error = null;
    try {
      route = fixedModelRoute(shot, item.model, policy, item.capabilities, item.contract_status || null);
    } catch (caught) {
      error = caught;
    }
    const price = priceForCatalogItem(item, group, route?.duration);
    const warnings = [];
    if (capability?.expensive_bypass) warnings.push('expensive_bypass');
    if (capability?.duration_mode === 'fixed') warnings.push('fixed_duration_product');
    if (!capability) warnings.push('unknown_contract');
    if (!groupAvailable) warnings.push('group_unavailable');
    warnings.push(...(route?.contract_warnings || []));
    const contractIssue = (route?.contract_warnings || []).find((warning) => warning !== 'unknown_contract') || null;
    // A manually selected model is always an allowed attempt.  Compatibility
    // remains advisory so automatic routing and the UI can explain what is
    // known locally, but an unregistered or cross-group model must not be
    // hidden behind a local contract gate.
    const compatible = Boolean(route && capability && groupAvailable && !contractIssue);
    return {
      model: item.model,
      name: item.name || item.model,
      contract_status: item.contract_status || (capability ? 'known' : 'missing'),
      capability_source: item.capability_source || (capability ? 'builtin' : 'unknown'),
      groups: item.groups,
      group,
      group_available: groupAvailable,
      compatible,
      selectable: true,
      incompatibility_code: !groupAvailable
        ? 'VIDEO_ROUTE_GROUP_UNAVAILABLE'
        : error?.code
          || (!capability ? 'VIDEO_ROUTE_UNKNOWN_CONTRACT' : null)
          || (contractIssue === 'duration_mismatch' ? 'VIDEO_ROUTE_DURATION_UNSUPPORTED'
            : contractIssue === 'video_reference_unsupported' ? 'VIDEO_ROUTE_REFERENCE_UNSUPPORTED'
              : contractIssue === 'strict_first_frame_unsupported' ? 'STRICT_FIRST_FRAME_UNSUPPORTED' : null),
      incompatibility_reason: !groupAvailable
        ? `不在当前分组 ${group}`
        : error?.message
          || (!capability ? '本地尚未登记该模型的能力提示；手动选择仍可提交' : null)
          || (contractIssue ? `本地能力提示：${contractIssue}` : null),
      warnings: [...new Set(warnings)],
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
      currency: price?.currency || null,
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
