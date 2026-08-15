const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const accounting = require('../src/services/productionRuntimeAccounting');

describe('production runtime video accounting', () => {
  it('freezes per-request video cost as one unit instead of multiplying by duration', () => {
    const reservation = accounting.videoReservation(null, {
      policy: { video_provider: 'yinzi', video_group: '特价视频分组(即梦)' },
      budget: {},
    }, {
      provider: 'yinzi', model: 'af-seedance-2.0', duration: 12,
    }, {
      model: 'af-seedance-2.0', billing_unit: 'per_request', unit_price: 0.3484,
      estimated_price: 0.3484,
    });
    assert.equal(reservation.billing_unit, 'per_request');
    assert.equal(reservation.units, 1);
    assert.deepEqual(reservation.usage, { units: 1, duration_seconds: 12 });
    assert.equal(reservation.estimated_microusd, 348400);
  });

  it('keeps per-second video cost proportional to the frozen duration', () => {
    const reservation = accounting.videoReservation(null, {
      policy: { video_provider: 'yinzi', video_group: '特价视频分组(即梦)' },
      budget: {},
    }, {
      provider: 'yinzi', model: 'mg-seedance2.0 -480p mini', duration: 7,
    }, {
      model: 'mg-seedance2.0 -480p mini', billing_unit: 'per_second', unit_price: 0.1664,
      estimated_price: 1.1648,
    });
    assert.equal(reservation.billing_unit, 'per_second');
    assert.equal(reservation.units, 7);
    assert.deepEqual(reservation.usage, { units: 7, duration_seconds: 7 });
    assert.equal(reservation.estimated_microusd, 1164800);
  });
});
