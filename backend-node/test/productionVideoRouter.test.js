const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyShotRoute,
  listShotVideoRouteOptions,
  selectShotVideoRoute,
  routingMaterialSignature,
} = require('../src/services/productionVideoRouter');

function price(model, effective, unit = 'per_second') {
  return {
    model,
    endpoint_types: ['openai-video'],
    groups: ['特价视频分组(即梦)'],
    prices: [{
      group: '特价视频分组(即梦)',
      billing_mode: 'fixed_price',
      billing_unit: unit,
      effective_price: effective,
    }],
  };
}

const catalog = {
  pricing_version: 'fixture-v1',
  fetched_at: '2026-08-07T00:00:00.000Z',
  video: [
    price('cc-seedance2.0 480p-fast-nsp', 0.4656),
    price('cc-seedance2.0 480p-nsp', 0.5148),
    price('mg-seedance2.0 -480p mini', 0.2004),
    price('mg-seedance2.0 -720p fast', 0.4188),
    price('mg-seedance2.0 -480p-fast-gz-15s', 6.9888, 'fixed_duration'),
    price('破甲seedance 720p-fast', 2.1528),
  ],
};

const policy = {
  video_routing_mode: 'auto',
  video_group: '特价视频分组(即梦)',
  video_quality: 'balanced',
};

describe('production video router', () => {
  it('keeps a legacy two-second plan but raises the provider duration to five seconds', () => {
    const route = classifyShotRoute({ content: { duration: 2, shot_type: '特写' } });
    assert.equal(route.profile, 'short_image_guided');
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 5);
    assert.equal(route.duration_adjusted, true);
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
  });

  it('selects the image-only model and prices the effective five-second request', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2, shot_type: '特写' } }, catalog, policy,
    });
    assert.equal(route.model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 5);
    assert.equal(route.duration_adjusted, true);
    assert.equal(route.limits.videos, 0);
    assert.equal(route.estimated_price, 2.328);
    assert.equal(route.catalog_verified, true);
  });

  it('selects the economical reference model for an eight-second take', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, camera_movement: 'continuous follow' } }, catalog, policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, true);
    assert.equal(route.limits.videos, 3);
    assert.equal(route.estimated_price, 1.6032);
  });

  it('lets an eight-second shot explicitly skip director preview and reference video', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, camera_movement: 'continuous follow', previs_mode: 'skip' } },
      catalog,
      policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
  });

  it('lets a persisted shot routing choice skip a storyboard default without editing the approved script', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '6', content: { duration: 12, previs_mode: 'auto' } },
      catalog,
      policy: { ...policy, video_previs_overrides: { 6: 'skip' } },
    });
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
    assert.ok(route.reason_codes.includes('director_preview_skipped_by_user'));
  });

  it('lets auto remove a persisted shot override and return to the storyboard setting', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '6', content: { duration: 12, previs_mode: 'force' } },
      catalog,
      policy: { ...policy, video_previs_overrides: { 6: 'auto' } },
    });
    assert.equal(route.previs_mode, 'force');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, true);
  });

  it('can force a local director preview for a short shot without uploading it', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2, shot_type: 'close-up', previs_mode: 'force' } },
      catalog,
      policy,
    });
    assert.equal(route.model, 'cc-seedance2.0 480p-fast-nsp');
    assert.equal(route.previs_mode, 'force');
    assert.equal(route.requires_director_preview, true);
    assert.equal(route.uses_reference_video, false);
    assert.equal(route.limits.videos, 0);
  });

  it('does not select fixed-duration or expensive bypass products automatically', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 15 } }, catalog, policy,
    });
    assert.equal(route.model, 'mg-seedance2.0 -480p mini');
    assert.equal(route.candidates.some((item) => item.model.includes('gz-15s')), false);
    assert.notEqual(route.model, '破甲seedance 720p-fast');
  });

  it('uses the same visible five-second correction for a fixed compatible model', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 2 } }, catalog,
      policy: { video_routing_mode: 'fixed', video_model: 'mg-seedance2.0 -480p mini' },
    });
    assert.equal(route.planned_duration, 2);
    assert.equal(route.duration, 5);
    assert.equal(route.duration_adjustment_reason, 'jimeng_minimum_5_seconds');
    assert.equal(route.catalog_verified, true);
    assert.equal(route.estimated_price, 1.002);
  });

  it('lets a shot override win over a project fixed model', () => {
    const route = selectShotVideoRoute({
      shot: { scope_id: '5', content: { duration: 5 } },
      catalog,
      policy: {
        ...policy,
        video_routing_mode: 'fixed',
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_model_overrides: { 5: 'cc-seedance2.0 480p-nsp' },
      },
    });
    assert.equal(route.model, 'cc-seedance2.0 480p-nsp');
    assert.deepEqual(route.reason_codes, ['shot_model_override']);
  });

  it('rejects a fixed model that is absent from the configured group', () => {
    assert.throws(() => selectShotVideoRoute({
      shot: { content: { duration: 5 } },
      catalog,
      policy: { video_routing_mode: 'fixed', video_model: 'cc-seedance2.0 480p-nsp', video_group: '不存在的分组' },
    }), (error) => error.code === 'VIDEO_ROUTE_GROUP_UNAVAILABLE');
  });

  it('lists incompatible and expensive manual choices without hiding them', () => {
    const options = listShotVideoRouteOptions({
      shot: { scope_id: '5', content: { duration: 5 } }, catalog, policy,
    });
    const fixed15 = options.find((item) => item.model.includes('gz-15s'));
    const expensive = options.find((item) => item.model === '破甲seedance 720p-fast');
    assert.equal(fixed15.selectable, false);
    assert.equal(fixed15.incompatibility_code, 'VIDEO_ROUTE_DURATION_UNSUPPORTED');
    assert.equal(expensive.selectable, true);
    assert.equal(expensive.requires_explicit_confirmation, true);
    assert.ok(expensive.warnings.includes('expensive_bypass'));
  });

  it('lets the project-level director switch override a forced long-shot preview', () => {
    const route = selectShotVideoRoute({
      shot: { content: { duration: 8, route_profile: 'long_previs_guided', previs_mode: 'force' } },
      catalog,
      policy: { ...policy, director_mode: 'off' },
    });
    assert.equal(route.director_mode, 'off');
    assert.equal(route.previs_mode, 'skip');
    assert.equal(route.requires_director_preview, false);
    assert.equal(route.uses_reference_video, false);
    assert.ok(route.reason_codes.includes('director_disabled_for_run'));
  });

  it('keeps commercial-only catalog changes out of the material signature', () => {
    const first = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog, policy });
    const changed = structuredClone(catalog);
    changed.pricing_version = 'fixture-v2';
    changed.video[0].prices[0].effective_price = 0.9;
    const second = selectShotVideoRoute({ shot: { content: { duration: 2 } }, catalog: changed, policy });
    assert.equal(routingMaterialSignature(first), routingMaterialSignature(second));
    assert.notEqual(first.estimated_price, second.estimated_price);
  });
});
