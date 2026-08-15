const settingsService = require('./settingsService');

const SETTING_KEY = 'production_automation_preferences';
const DEFAULTS = Object.freeze({
  review_concurrency: 3,
  notifications_enabled: true,
  notification_sound_enabled: true,
  moderation_fallback_enabled: false,
  moderation_fallback_model: 'mg-seedance2.0 -480p fast',
});

function normalize(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const concurrency = Number(source.review_concurrency);
  return {
    review_concurrency: Number.isFinite(concurrency)
      ? Math.min(8, Math.max(1, Math.floor(concurrency)))
      : DEFAULTS.review_concurrency,
    notifications_enabled: source.notifications_enabled !== false,
    notification_sound_enabled: source.notification_sound_enabled !== false,
    moderation_fallback_enabled: source.moderation_fallback_enabled === true,
    moderation_fallback_model: String(source.moderation_fallback_model || DEFAULTS.moderation_fallback_model).trim()
      || DEFAULTS.moderation_fallback_model,
  };
}

function get(db) {
  return normalize(settingsService.getGlobalSetting(db, SETTING_KEY, DEFAULTS));
}

function set(db, input) {
  const value = normalize(input);
  settingsService.setGlobalSetting(db, SETTING_KEY, value);
  return value;
}

module.exports = { DEFAULTS, SETTING_KEY, get, normalize, set };
