const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeDiscoveredCatalog } = require('../src/services/aiConfigService');

describe('key-scoped capability catalog merge', () => {
  it('does not invent a builtin profile when the verified catalog marks a model missing', () => {
    const result = mergeDiscoveredCatalog(
      { models: [{ model: 'mg-seedance2.0 -480p mini' }], availability_scope: 'credential', snapshot: { scope_verified: true } },
      {
        catalog_verified: true,
        video: [{
          model: 'mg-seedance2.0 -480p mini', groups: ['video'], capabilities: null,
          capability_source: 'unknown', contract_status: 'missing', prices: [],
        }],
      },
      { provider: 'yinzi', service_type: 'video' }
    );
    assert.equal(result.video[0].capabilities, null);
    assert.equal(result.video[0].contract_status, 'missing');
    assert.equal(result.video[0].catalog_verified, true);
    assert.equal(result.video[0].automatic_eligible, false);
  });

  it('keeps legacy builtin compatibility only for an explicitly unverified fallback', () => {
    const result = mergeDiscoveredCatalog(
      { models: [{ model: 'mg-seedance2.0 -480p mini' }] },
      { catalog_verified: false, source: 'legacy_fallback', video: [] },
      { provider: 'yinzi', service_type: 'video' }
    );
    assert.equal(result.video[0].capabilities.family, 'mg-seedance2-reference');
    assert.equal(result.video[0].catalog_verified, false);
  });
});
