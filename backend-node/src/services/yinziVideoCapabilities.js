const COMMON_LIMITS = Object.freeze({
  provider_contract: 'aizzz-video-v1',
  provider_prompt_hard_max_chars: 4096,
  max_prompt_chars: 4000,
  max_image_bytes: 30 * 1024 * 1024,
  max_video_bytes: 50 * 1024 * 1024,
  max_audio_bytes: 15 * 1024 * 1024,
});

function freezeProfile(input) {
  const roles = Object.fromEntries(Object.entries(input.roles || {})
    .map(([key, values]) => [key, Object.freeze([...(values || [])])]));
  return Object.freeze({
    ...COMMON_LIMITS,
    duration_step: 1,
    automatic_eligible: false,
    expensive_bypass: false,
    requires_director_preview: false,
    reference_video_safety_margin_seconds: 1.2,
    ...input,
    roles: Object.freeze(roles),
    route_profiles: Object.freeze([...(input.route_profiles || [])]),
  });
}

function shortImageGuidedProfile({ quality = 'fast', preferenceRank = 10 } = {}) {
  return freezeProfile({
    family: 'cc-seedance2-free-duration',
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    auto_duration_min: 5,
    auto_duration_max: 15,
    max_images: 9,
    max_videos: 0,
    max_audios: 3,
    max_total_references: 12,
    max_reference_video_seconds_total: 0,
    resolution: '480p',
    quality_tier: quality,
    automatic_eligible: true,
    preference_rank: preferenceRank,
    requires_director_preview: false,
    route_profiles: ['short_image_guided'],
    roles: { image: ['reference'], video: [], audio: ['reference'] },
  });
}

function longPrevisProfile(resolution, quality, preferenceRank) {
  return freezeProfile({
    family: 'mg-seedance2-reference',
    duration_mode: 'range',
    duration_min: 5,
    duration_max: 15,
    auto_duration_min: 5,
    auto_duration_max: 15,
    max_images: 4,
    max_videos: 3,
    max_audios: 1,
    max_total_references: 8,
    max_reference_video_seconds_total: 15,
    resolution,
    quality_tier: quality,
    automatic_eligible: true,
    preference_rank: preferenceRank,
    requires_director_preview: true,
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: ['reference'], audio: ['reference'] },
  });
}

function multimodalSeedanceProfile({
  family,
  resolution,
  quality,
  preferenceRank,
  maxImages,
  maxVideos,
  maxAudios,
  maxReferenceVideoSeconds,
  durationMode = 'free',
  durationMin = 5,
  durationMax = 15,
  autoDurationMin = 5,
  autoDurationMax = 15,
  automaticEligible = true,
  exclusionReason = null,
} = {}) {
  return freezeProfile({
    family,
    duration_mode: durationMode,
    duration_min: durationMin,
    duration_max: durationMax,
    auto_duration_min: autoDurationMin,
    auto_duration_max: autoDurationMax,
    max_images: maxImages,
    max_videos: maxVideos,
    max_audios: maxAudios,
    max_total_references: maxImages + maxVideos + maxAudios,
    max_reference_video_seconds_total: maxReferenceVideoSeconds,
    resolution,
    quality_tier: quality,
    automatic_eligible: automaticEligible,
    preference_rank: preferenceRank,
    ...(exclusionReason ? { exclusion_reason: exclusionReason } : {}),
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: {
      image: maxImages > 0 ? ['reference'] : [],
      video: maxVideos > 0 ? ['reference'] : [],
      audio: maxAudios > 0 ? ['reference'] : [],
    },
  });
}

function conservativeManualProfile(family, resolution = '720p') {
  return freezeProfile({
    provider_contract: 'yinzi-openai-video-v1',
    family,
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    max_images: 1,
    max_videos: 0,
    max_audios: 0,
    max_total_references: 1,
    max_reference_video_seconds_total: 0,
    resolution,
    quality_tier: 'manual',
    automatic_eligible: false,
    exclusion_reason: 'conservative_manual_contract',
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: [], audio: [] },
  });
}

function fixedFifteenProfile(resolution, quality = 'fast', options = {}) {
  const maxImages = Number(options.maxImages ?? 9);
  const maxVideos = Number(options.maxVideos ?? 3);
  const maxAudios = Number(options.maxAudios ?? 3);
  const automaticEligible = options.automaticEligible === true;
  return freezeProfile({
    family: options.family || 'seedance2-fixed-15s',
    duration_mode: 'fixed',
    duration_min: 15,
    duration_max: 15,
    fixed_duration_seconds: 15,
    max_images: maxImages,
    max_videos: maxVideos,
    max_audios: maxAudios,
    max_total_references: maxImages + maxVideos + maxAudios,
    max_reference_video_seconds_total: maxVideos > 0 ? 15 : 0,
    resolution,
    quality_tier: quality,
    automatic_eligible: automaticEligible,
    preference_rank: Number(options.preferenceRank ?? 100),
    ...(!automaticEligible ? { exclusion_reason: options.exclusionReason || 'fixed_15_second_product' } : {}),
    requires_director_preview: maxVideos > 0,
    route_profiles: ['long_previs_guided'],
    roles: {
      image: maxImages > 0 ? ['reference'] : [],
      video: maxVideos > 0 ? ['reference'] : [],
      audio: maxAudios > 0 ? ['reference'] : [],
    },
  });
}

const CURRENT_YINZI_JIMENG_MODELS = Object.freeze([
  '官转-seedance2.0 720p-fast',
  '官转-seedance2.0 720p-pro',
  '破甲seedance 720p-fast',
  'cm-seedance2.0 -720p-15s',
  'cm-seedance2.0特价fast-720p-gz-15s',
  'seedance-2.5-720p',
  'seedance2.0 -720p-fast-15s',
  'seedance2.0 720p-pro-nv-nsp',
  'seedance2.0特价pro-720p-gz-15s',
  'seedance2.0特价pro-720p-gz-15s-nsp',
]);

const AIZZZ_PROFILES = Object.freeze({
  'cc-seedance2.0 480p-fast-nsp': shortImageGuidedProfile({ quality: 'fast', preferenceRank: 10 }),
  'cc-seedance2.0 480p-nsp': shortImageGuidedProfile({ quality: 'balanced', preferenceRank: 20 }),

  'mg-seedance2.0 -480p mini': longPrevisProfile('480p', 'economy', 10),
  'mg-seedance2.0 -480p fast': longPrevisProfile('480p', 'fast', 20),
  'mg-seedance2.0 -480p': longPrevisProfile('480p', 'balanced', 30),
  'mg-seedance2.0 -720p mini': longPrevisProfile('720p', 'economy', 40),
  'mg-seedance2.0 -720p fast': longPrevisProfile('720p', 'fast', 50),
  'mg-seedance2.0 -720p pro': longPrevisProfile('720p', 'quality', 60),

  'af-seedance-2.0': multimodalSeedanceProfile({
    family: 'af-seedance2-reference', resolution: '720p', quality: 'balanced', preferenceRank: 12,
    maxImages: 4, maxVideos: 3, maxAudios: 1, maxReferenceVideoSeconds: 15,
  }),
  'af-seedance-2.0-fast': multimodalSeedanceProfile({
    family: 'af-seedance2-reference', resolution: '720p', quality: 'fast', preferenceRank: 11,
    maxImages: 4, maxVideos: 3, maxAudios: 1, maxReferenceVideoSeconds: 15,
  }),
  '官转-seedance2.0 720p-fast': multimodalSeedanceProfile({
    family: 'official-seedance2-reference', resolution: '720p', quality: 'fast', preferenceRank: 70,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  '官转-seedance2.0 720p-pro': multimodalSeedanceProfile({
    family: 'official-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 80,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'seedance-2.5-480p': multimodalSeedanceProfile({
    family: 'seedance2.5-reference', resolution: '480p', quality: 'balanced', preferenceRank: 35,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
  }),
  'seedance-2.5-720p': multimodalSeedanceProfile({
    family: 'seedance2.5-reference', resolution: '720p', quality: 'quality', preferenceRank: 55,
    maxImages: 30, maxVideos: 0, maxAudios: 10, maxReferenceVideoSeconds: 0,
    durationMode: 'range', durationMin: 4, durationMax: 30, autoDurationMin: 5, autoDurationMax: 15,
  }),
  '特价seedance-2.5-480p': multimodalSeedanceProfile({
    family: 'seedance2.5-discount-reference', resolution: '480p', quality: 'economy', preferenceRank: 25,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
  }),
  '特价seedance-2.5-720p': multimodalSeedanceProfile({
    family: 'seedance2.5-discount-reference', resolution: '720p', quality: 'balanced', preferenceRank: 45,
    maxImages: 30, maxVideos: 10, maxAudios: 10, maxReferenceVideoSeconds: 29,
  }),
  'ca-seedance 2.0 720pro-15s': multimodalSeedanceProfile({
    family: 'ca-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 100,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
    automaticEligible: false, exclusionReason: 'manual_fixed_price_product',
  }),
  'cav2-seedance 2.0 720pro-15s': multimodalSeedanceProfile({
    family: 'cav2-seedance2-reference', resolution: '720p', quality: 'quality', preferenceRank: 110,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
    automaticEligible: false, exclusionReason: 'manual_fixed_price_product',
  }),

  'cm-seedance2.0 -720p-15s': multimodalSeedanceProfile({
    family: 'cm-seedance2-reference', resolution: '720p', quality: 'balanced', preferenceRank: 90,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'cm-seedance2.0特价fast-720p-gz-15s': fixedFifteenProfile('720p', 'fast', {
    family: 'cm-seedance2-discount-fixed', automaticEligible: true, preferenceRank: 25,
  }),
  'seedance2.0 -720p-fast-15s': multimodalSeedanceProfile({
    family: 'seedance2-fast-request-priced', resolution: '720p', quality: 'fast', preferenceRank: 30,
    maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferenceVideoSeconds: 15,
  }),
  'seedance2.0 720p-pro-nv-nsp': multimodalSeedanceProfile({
    family: 'seedance2-pro-no-video', resolution: '720p', quality: 'quality', preferenceRank: 5,
    maxImages: 9, maxVideos: 0, maxAudios: 3, maxReferenceVideoSeconds: 0,
  }),
  'seedance2.0特价pro-720p-gz-15s': fixedFifteenProfile('720p', 'quality', {
    family: 'seedance2-pro-discount-fixed', automaticEligible: true, preferenceRank: 40,
  }),
  'seedance2.0特价pro-720p-gz-15s-nsp': fixedFifteenProfile('720p', 'quality', {
    family: 'seedance2-pro-discount-fixed-no-video', automaticEligible: true,
    preferenceRank: 35, maxVideos: 0,
  }),

  'mg-seedance2.0 -480p-fast-gz-15s': fixedFifteenProfile('480p', 'fast'),
  'mg-seedance2.0 -480p-gz-15s': fixedFifteenProfile('480p', 'balanced'),
  'mg-seedance2.0 -720p-mini-gz-15s': fixedFifteenProfile('720p', 'economy'),
  'mg-seedance2.0 -720p-fast-gz-15s': fixedFifteenProfile('720p', 'fast'),
  'mg-seedance2.0 -720p-gz-15s': fixedFifteenProfile('720p', 'balanced'),
  'xx-seedance 720p-mini-nyp-15s': fixedFifteenProfile('720p', 'economy'),
  'xx-seedance 720p-fast-nyp-15s': fixedFifteenProfile('720p', 'fast'),
  'xx-seedance 720p-pro-nyp-15s': fixedFifteenProfile('720p', 'quality'),
  'xx-seedance 1080p-pro-nyp-15s': fixedFifteenProfile('1080p', 'quality'),
  'seedance2.0 -720p-15s': fixedFifteenProfile('720p', 'quality'),
  'seedance2.0 -720p-gz-15s': fixedFifteenProfile('720p', 'quality'),

  '破甲seedance 720p-fast': freezeProfile({
    family: 'seedance2-expensive-bypass',
    duration_mode: 'free',
    duration_min: 5,
    duration_max: 15,
    max_images: 9,
    max_videos: 3,
    max_audios: 3,
    max_total_references: 15,
    max_reference_video_seconds_total: 15,
    resolution: '720p',
    quality_tier: 'bypass',
    automatic_eligible: false,
    expensive_bypass: true,
    exclusion_reason: 'explicit_user_approval_required',
    requires_director_preview: true,
    route_profiles: ['short_image_guided', 'long_previs_guided'],
    roles: { image: ['reference'], video: ['reference'], audio: ['reference'] },
  }),

  'grok-imagine-video': conservativeManualProfile('grok-imagine-video', '720p'),
  'minimax-h3-2k': conservativeManualProfile('minimax-h3-2k', '2k'),
  'kling video 3.0 omni': conservativeManualProfile('kling-video-3-omni', '1080p'),
});

const CANONICAL_MODEL_NAMES = Object.freeze({
  'minimax-h3-2k': 'MiniMax-H3-2k',
  'kling video 3.0 omni': 'Kling VIDEO 3.0 Omni',
});

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function getYinziVideoCapability(model) {
  return AIZZZ_PROFILES[normalizeModelName(model)] || null;
}

function listYinziVideoCapabilities() {
  return Object.entries(AIZZZ_PROFILES).map(([model, capability]) => ({
    model: CANONICAL_MODEL_NAMES[model] || model,
    capability,
  }));
}

function capabilitySupportsRole(capability, mediaType, role) {
  return Array.isArray(capability?.roles?.[mediaType])
    && capability.roles[mediaType].includes(role);
}

function capabilitySupportsRoute(capability, routeProfile) {
  return Array.isArray(capability?.route_profiles)
    && capability.route_profiles.includes(routeProfile);
}

function capabilityAcceptsDuration(capability, duration, options = {}) {
  const seconds = Number(duration);
  if (!capability || !Number.isFinite(seconds)) return false;
  if (capability.duration_mode === 'fixed') {
    return seconds === Number(capability.fixed_duration_seconds || capability.duration_min);
  }
  const min = options.automatic
    ? Number(capability.auto_duration_min ?? capability.duration_min)
    : Number(capability.duration_min);
  const max = options.automatic
    ? Number(capability.auto_duration_max ?? capability.duration_max)
    : Number(capability.duration_max);
  return seconds >= min && seconds <= max;
}

function supportsStrictFirstFrame(model) {
  return capabilitySupportsRole(getYinziVideoCapability(model), 'image', 'first_frame');
}

function clampYinziVideoDuration(model, duration) {
  const capability = getYinziVideoCapability(model);
  const fallback = capability?.duration_min || 5;
  const rounded = Math.round(Number(duration) || fallback);
  if (!capability) return Math.max(1, rounded);
  if (capability.duration_mode === 'fixed') {
    return Number(capability.fixed_duration_seconds || capability.duration_min);
  }
  return Math.min(capability.duration_max, Math.max(capability.duration_min, rounded));
}

module.exports = {
  CURRENT_YINZI_JIMENG_MODELS,
  getYinziVideoCapability,
  listYinziVideoCapabilities,
  capabilitySupportsRole,
  capabilitySupportsRoute,
  capabilityAcceptsDuration,
  supportsStrictFirstFrame,
  clampYinziVideoDuration,
};
