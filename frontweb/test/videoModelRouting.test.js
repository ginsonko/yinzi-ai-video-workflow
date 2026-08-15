import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildShotVideoRoutingPayload,
  buildProjectVideoRoutingPayload,
  catalogModelOption,
  modelMediaLabel,
  modelPriceLabel,
  projectVideoRoutingChanged,
  projectVideoRoutingState,
  shotVideoPrevisMode,
  videoGroupsFromCatalog,
} from '../src/utils/videoModelRouting.js'

const catalog = [
  {
    model: 'balanced-video',
    name: 'Balanced Video',
    groups: ['特价视频分组(即梦)', '视频模型渠道'],
    prices: [
      { group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.02 },
      { group: '视频模型渠道', billing_unit: 'per_second', effective_price: 0.05 },
    ],
    capabilities: {
      resolution: '480p', quality_tier: 'balanced', duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 4, max_videos: 3, max_audios: 1, expensive_bypass: false,
    },
  },
  {
    model: 'bypass-video',
    name: 'Bypass Video',
    groups: ['视频模型渠道'],
    prices: [{ group: '视频模型渠道', billing_unit: 'per_second', effective_price: 0.6 }],
    capabilities: {
      resolution: '720p', quality_tier: 'bypass', duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 4, max_videos: 3, max_audios: 1, expensive_bypass: true,
    },
  },
]

test('normalizes project routing and detects only material project-route changes', () => {
  const policy = {
    video_routing_mode: 'fixed',
    video_model: 'balanced-video',
    video_group: '特价视频分组(即梦)',
    video_quality: 'balanced',
    video_model_overrides: { 5: 'other-video' },
  }
  assert.deepEqual(projectVideoRoutingState(policy), {
    mode: 'fixed', model: 'balanced-video', group: '特价视频分组(即梦)', quality: 'balanced',
  })
  assert.equal(projectVideoRoutingChanged(policy, {
    video_routing_mode: 'fixed', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'balanced',
  }), false)
  assert.equal(projectVideoRoutingChanged(policy, {
    video_routing_mode: 'auto', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'balanced',
  }), true)
})

test('builds a redacted atomic project-routing payload and clears fixed model in auto mode', () => {
  const fixed = buildProjectVideoRoutingPayload({
    video_routing_mode: 'fixed', video_model: ' balanced-video ', video_group: '视频模型渠道', video_quality: 'quality', api_key: 'secret',
  }, { shotId: 5, expectedVersion: 8091, confirmExpensive: true })
  assert.deepEqual(fixed, {
    scope: 'run', shot_id: '5', mode: 'fixed', model: 'balanced-video', group: '视频模型渠道',
    quality: 'quality', confirm_expensive: true, expected_version: 8091,
  })
  assert.equal(Object.hasOwn(fixed, 'api_key'), false)

  const automatic = buildProjectVideoRoutingPayload({
    video_routing_mode: 'auto', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'economy',
  }, { expectedVersion: 3 })
  assert.equal(automatic.model, '')
  assert.equal(automatic.mode, 'auto')
})

test('maps live group, capability and expensive warnings for manual model selection', () => {
  assert.deepEqual(videoGroupsFromCatalog(catalog), ['视频模型渠道', '特价视频分组(即梦)'])
  const option = catalogModelOption(catalog, 'balanced-video', '特价视频分组(即梦)')
  assert.equal(option.selectable, true)
  assert.equal(option.unit_price, 0.02)
  assert.equal(modelMediaLabel(option), '4 图 · 3 视频 · 1 音频')

  const unavailable = catalogModelOption(catalog, 'bypass-video', '特价视频分组(即梦)')
  assert.equal(unavailable.selectable, false)
  assert.match(unavailable.incompatibility_reason, /不在当前分组/)
  assert.equal(unavailable.requires_explicit_confirmation, true)
})

test('never presents an incompatible or unestimated model as free', () => {
  assert.equal(modelPriceLabel({ estimated_price: null, unit_price: null }), '价格待目录刷新')
  assert.equal(modelPriceLabel({
    estimated_price: null,
    unit_price: 0.1125,
    billing_unit: 'per_request',
  }), '$0.1125 / 次')
  assert.equal(modelPriceLabel({
    estimated_price: 1.4312,
    unit_price: 0.20475,
    billing_unit: 'per_second',
  }), '本镜预计 $1.4312')
})

test('builds a shot routing payload that can explicitly omit director media', () => {
  const routing = {
    run_version: 8507,
    project: { director_mode: 'auto' },
    shot: { id: '6', mode: 'inherit', model: '' },
    effective_route: { model: 'balanced-video', previs_mode: 'auto' },
  }
  assert.equal(shotVideoPrevisMode(routing), 'auto')
  assert.deepEqual(buildShotVideoRoutingPayload(routing, {
    mode: 'fixed', model: ' balanced-video ', previs_mode: 'skip',
  }), {
    scope: 'shot', shot_id: '6', mode: 'fixed', model: 'balanced-video', previs_mode: 'skip',
    authorize_retry: false, retry_reason: '', confirm_expensive: false, expected_version: 8507,
  })
})

test('global director off forces the shot payload to skip', () => {
  const routing = {
    run_version: 4,
    project: { director_mode: 'off' },
    shot: { id: '2', mode: 'inherit', model: '' },
    effective_route: { model: 'balanced-video', previs_mode: 'auto' },
  }
  assert.equal(shotVideoPrevisMode(routing), 'skip')
  assert.equal(buildShotVideoRoutingPayload(routing, { previs_mode: 'force' }).previs_mode, 'skip')
})
