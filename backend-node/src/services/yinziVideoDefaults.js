const KNOWN_STALE_PRICING_VERSION = 'a42d372ccf0b5dd13ecf71203521f9d2';
const DEFAULT_PRICE_SOURCE = 'v0.1.2-default';

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

function price(model, group, billingUnit, effectivePrice) {
  return Object.freeze({
    model,
    group,
    billing_mode: 'fixed_price',
    billing_unit: billingUnit,
    effective_price: effectivePrice,
    effective_input_usd: null,
    effective_output_usd: null,
    fixed_duration_seconds: null,
    source: DEFAULT_PRICE_SOURCE,
  });
}

const DEFAULT_VIDEO_PRICES = Object.freeze([
  price('官转-seedance2.0 720p-fast', '特价视频分组(即梦)', 'per_second', 0.845),
  price('官转-seedance2.0 720p-pro', '特价视频分组(即梦)', 'per_second', 0.975),
  price('破甲seedance 720p-fast', '特价视频分组(即梦)', 'per_second', 1.794),
  price('特价seedance-2.5-480p', '特价视频分组(即梦)', 'per_second', 0.3354),
  price('特价seedance-2.5-720p', '特价视频分组(即梦)', 'per_second', 0.4654),
  price('af-seedance-2.0', '特价视频分组(即梦)', 'per_request', 0.3484),
  price('af-seedance-2.0-fast', '特价视频分组(即梦)', 'per_request', 0.2587),
  price('ca-seedance 2.0 720pro-15s', '特价视频分组(即梦)', 'per_request', 3.874),
  price('cav2-seedance 2.0 720pro-15s', '特价视频分组(即梦)', 'per_request', 3.874),
  price('mg-seedance2.0 -480p', '特价视频分组(即梦)', 'per_second', 0.3484),
  price('mg-seedance2.0 -480p fast', '特价视频分组(即梦)', 'per_second', 0.2145),
  price('mg-seedance2.0 -480p mini', '特价视频分组(即梦)', 'per_second', 0.1664),
  price('mg-seedance2.0 -720p fast', '特价视频分组(即梦)', 'per_second', 0.3484),
  price('mg-seedance2.0 -720p mini', '特价视频分组(即梦)', 'per_second', 0.2574),
  price('mg-seedance2.0 -720p pro', '特价视频分组(即梦)', 'per_second', 0.4784),
  price('seedance-2.5-480p', '特价视频分组(即梦)', 'per_second', 0.5044),
  price('seedance-2.5-720p', '特价视频分组(即梦)', 'per_second', 0.7644),
  price('seedance2.0 -720p-15s', '特价视频分组(即梦)', 'per_request', 6.344),
  price('seedance2.0 -720p-gz-15s', '特价视频分组(即梦)', 'per_request', 6.474),
  price('grok-imagine-video', '视频模型渠道', 'per_request', 0.1125),
  price('MiniMax-H3-2k', 'minimax/可灵视频', 'per_second', 0.20475),
  price('Kling VIDEO 3.0 Omni', 'minimax/可灵视频', 'per_request', 0.25),
]);

const DEFAULT_VIDEO_PRICE_BY_MODEL = new Map(
  DEFAULT_VIDEO_PRICES.map((item) => [normalizeModelName(item.model), item])
);

function getDefaultYinziVideoPrice(model) {
  const item = DEFAULT_VIDEO_PRICE_BY_MODEL.get(normalizeModelName(model));
  if (!item) return null;
  const { model: _model, ...priceFields } = item;
  return priceFields;
}

function listDefaultYinziVideoPrices() {
  return DEFAULT_VIDEO_PRICES.map((item) => ({ ...item }));
}

function validVideoPrice(price) {
  return ['per_request', 'per_second'].includes(String(price?.billing_unit || '').toLowerCase())
    && Number.isFinite(Number(price?.effective_price));
}

function resolveYinziVideoPrices(model, livePrices, pricingVersion) {
  const validLive = (Array.isArray(livePrices) ? livePrices : []).filter(validVideoPrice);
  const fallback = getDefaultYinziVideoPrice(model);
  if (fallback && (pricingVersion === KNOWN_STALE_PRICING_VERSION || !validLive.length)) {
    return [fallback];
  }
  return validLive.length ? validLive : fallback ? [fallback] : [];
}

module.exports = {
  DEFAULT_PRICE_SOURCE,
  DEFAULT_VIDEO_PRICES,
  KNOWN_STALE_PRICING_VERSION,
  getDefaultYinziVideoPrice,
  listDefaultYinziVideoPrices,
  resolveYinziVideoPrices,
};
