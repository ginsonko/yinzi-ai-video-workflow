const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  KNOWN_STALE_PRICING_VERSION,
  listDefaultYinziVideoPrices,
  resolveYinziVideoPrices,
} = require('../src/services/yinziVideoDefaults');

describe('Yinzi V0.1.2 video defaults', () => {
  it('freezes 22 unique fallback prices with only video billing units', () => {
    const prices = listDefaultYinziVideoPrices();
    assert.equal(prices.length, 22);
    assert.equal(new Set(prices.map((item) => item.model.toLowerCase())).size, 22);
    assert.equal(prices.every((item) => ['per_request', 'per_second'].includes(item.billing_unit)), true);
    assert.equal(prices.every((item) => item.effective_price > 0), true);
  });

  it('uses a new valid live price after the stale catalog revision changes', () => {
    const live = [{
      group: '特价视频分组(即梦)', billing_mode: 'fixed_price',
      billing_unit: 'per_second', effective_price: 0.1234,
    }];
    assert.equal(
      resolveYinziVideoPrices('mg-seedance2.0 -480p mini', live, KNOWN_STALE_PRICING_VERSION)[0].effective_price,
      0.1664
    );
    assert.equal(
      resolveYinziVideoPrices('mg-seedance2.0 -480p mini', live, 'new-live-revision')[0].effective_price,
      0.1234
    );
  });
});
