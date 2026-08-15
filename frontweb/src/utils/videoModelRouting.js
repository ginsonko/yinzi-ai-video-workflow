const QUALITY_LABELS = Object.freeze({
  fast: '速度优先',
  balanced: '均衡',
  economy: '成本优先',
  quality: '质量优先',
  bypass: '高价破甲',
})

const BILLING_LABELS = Object.freeze({
  per_second: '/ 秒',
  per_request: '/ 次',
  per_generation: '/ 次',
  fixed_duration: '/ 段',
})

export function modelDurationLabel(option = {}) {
  if (option.duration_mode === 'fixed') return `固定 ${option.fixed_duration_seconds || option.duration_min || '?'} 秒`
  if (option.duration_min != null && option.duration_max != null) return `${option.duration_min}–${option.duration_max} 秒`
  return '时长待核对'
}

export function modelMediaLabel(option = {}) {
  const limits = option.limits || {}
  if (![limits.images, limits.videos, limits.audios].every(Number.isFinite)) return '媒体能力待核对'
  return `${limits.images} 图 · ${limits.videos} 视频 · ${limits.audios} 音频`
}

export function modelQualityLabel(option = {}) {
  const quality = String(option.quality_tier || '')
  return QUALITY_LABELS[quality] || quality || '质量档位待核对'
}

export function modelPriceLabel(option = {}) {
  if (option.estimated_price != null && option.estimated_price !== '') {
    const estimated = Number(option.estimated_price)
    if (Number.isFinite(estimated)) return `本镜预计 $${estimated.toFixed(4)}`
  }
  if (option.unit_price == null || option.unit_price === '') return '价格待目录刷新'
  const unit = Number(option.unit_price)
  if (!Number.isFinite(unit)) return '价格待目录刷新'
  return `$${unit.toFixed(4)} ${BILLING_LABELS[option.billing_unit] || option.billing_unit || ''}`.trim()
}

export function modelCompatibilityLabel(option = {}) {
  if (option.selectable) return '适合当前镜头'
  return option.incompatibility_reason || '不适合当前镜头'
}

export function modelWarnings(option = {}) {
  const warnings = Array.isArray(option.warnings) ? option.warnings : []
  return warnings.map((warning) => ({
    expensive_bypass: '高价破甲通道，需单独确认',
    fixed_duration_product: '固定时长产品',
    unknown_contract: '本地媒体契约未知',
    group_unavailable: '当前 Key 分组不可用',
  })[warning] || warning)
}

export function videoGroupsFromCatalog(catalog = []) {
  return [...new Set((catalog || []).flatMap((item) => Array.isArray(item.groups) ? item.groups : []))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
}

export function catalogModelOption(catalog = [], model = '', group = '') {
  const item = (catalog || []).find((candidate) => candidate.model === model)
  if (!item) return null
  const capability = item.capabilities || {}
  const prices = Array.isArray(item.prices) ? item.prices : []
  const price = prices.find((candidate) => !group || candidate.group === group) || prices[0] || {}
  return {
    ...item,
    ...capability,
    limits: {
      images: Number(capability.max_images),
      videos: Number(capability.max_videos),
      audios: Number(capability.max_audios),
    },
    billing_unit: price.billing_unit || null,
    unit_price: price.effective_price ?? null,
    selectable: !group || (item.groups || []).includes(group),
    incompatibility_reason: group && !(item.groups || []).includes(group) ? `不在当前分组 ${group}` : null,
    warnings: [
      ...(capability.expensive_bypass ? ['expensive_bypass'] : []),
      ...(capability.duration_mode === 'fixed' ? ['fixed_duration_product'] : []),
    ],
    requires_explicit_confirmation: capability.expensive_bypass === true,
  }
}

export function projectVideoRoutingState(policy = {}) {
  const model = String(policy.video_model || '').trim()
  const declaredMode = String(policy.video_routing_mode || '').trim()
  return {
    mode: declaredMode === 'fixed' || (!declaredMode && model) ? 'fixed' : 'auto',
    model,
    group: String(policy.video_group || '').trim(),
    quality: String(policy.video_quality || 'balanced').trim() || 'balanced',
  }
}

export function projectVideoRoutingChanged(policy = {}, draft = {}) {
  const current = projectVideoRoutingState(policy)
  const nextMode = draft.video_routing_mode === 'fixed' ? 'fixed' : 'auto'
  return current.mode !== nextMode
    || current.model !== (nextMode === 'fixed' ? String(draft.video_model || '').trim() : '')
    || current.group !== String(draft.video_group || '').trim()
    || current.quality !== String(draft.video_quality || 'balanced').trim()
}

export function buildProjectVideoRoutingPayload(draft = {}, options = {}) {
  const mode = draft.video_routing_mode === 'fixed' ? 'fixed' : 'auto'
  return {
    scope: 'run',
    shot_id: options.shotId == null ? undefined : String(options.shotId),
    mode,
    model: mode === 'fixed' ? String(draft.video_model || '').trim() : '',
    group: String(draft.video_group || '').trim(),
    quality: String(draft.video_quality || 'balanced').trim() || 'balanced',
    confirm_expensive: options.confirmExpensive === true,
    expected_version: options.expectedVersion,
  }
}

export function shotVideoPrevisMode(routing = {}) {
  if (routing?.project?.director_mode === 'off') return 'skip'
  const candidates = [
    routing?.shot?.previs_mode_override,
    routing?.effective_route?.previs_mode,
    'auto',
  ]
  return candidates.find((value) => ['auto', 'force', 'skip'].includes(value)) || 'auto'
}

export function buildShotVideoRoutingPayload(routing = {}, draft = {}) {
  const mode = draft.mode === 'fixed' ? 'fixed' : 'inherit'
  const requestedPrevisMode = ['auto', 'force', 'skip'].includes(draft.previs_mode)
    ? draft.previs_mode
    : shotVideoPrevisMode(routing)
  const directorDisabled = routing?.project?.director_mode === 'off'
  return {
    scope: 'shot',
    shot_id: routing?.shot?.id == null ? undefined : String(routing.shot.id),
    mode,
    model: mode === 'fixed' ? String(draft.model || '').trim() : '',
    previs_mode: directorDisabled ? 'skip' : requestedPrevisMode,
    authorize_retry: draft.authorize_retry === true && Boolean(routing.failed_action),
    retry_reason: draft.authorize_retry === true ? String(draft.retry_reason || '').trim() : '',
    confirm_expensive: draft.confirm_expensive === true,
    expected_version: routing.run_version,
  }
}
