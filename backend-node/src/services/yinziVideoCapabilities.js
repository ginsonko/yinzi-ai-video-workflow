const AIZZZ_PROFILES = Object.freeze({
  'mg-seedance2.0 -480p': profile('480p'),
  'mg-seedance2.0 -480p fast': profile('480p'),
  'mg-seedance2.0 -480p mini': profile('480p'),
  'mg-seedance2.0 -720p fast': profile('720p'),
  'mg-seedance2.0 -720p mini': profile('720p'),
  'mg-seedance2.0 -720p pro': profile('720p'),
});

function profile(resolution) {
  return Object.freeze({
    provider_contract: 'aizzz-video-v1',
    max_images: 4,
    max_videos: 3,
    max_audios: 1,
    max_total_references: 15,
    max_image_bytes: 30 * 1024 * 1024,
    max_video_bytes: 50 * 1024 * 1024,
    max_audio_bytes: 15 * 1024 * 1024,
    duration_min: 5,
    duration_max: 15,
    duration_step: 1,
    resolution,
    roles: Object.freeze({ image: ['reference'], video: ['reference'], audio: ['reference'] }),
  });
}

function getYinziVideoCapability(model) {
  return AIZZZ_PROFILES[String(model || '').trim().toLowerCase()] || null;
}

function clampYinziVideoDuration(model, duration) {
  const capability = getYinziVideoCapability(model);
  const fallback = capability?.duration_min || 5;
  const rounded = Math.round(Number(duration) || fallback);
  if (!capability) return Math.max(1, rounded);
  return Math.min(capability.duration_max, Math.max(capability.duration_min, rounded));
}

module.exports = {
  getYinziVideoCapability,
  clampYinziVideoDuration,
};
