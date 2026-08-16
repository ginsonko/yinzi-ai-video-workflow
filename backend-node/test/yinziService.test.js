const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizeYinziBaseUrl,
  normalizeYinziCatalog,
  fetchYinziCatalogForConfig,
  upsertYinziConfigs,
} = require('../src/services/yinziService');

function createConfigDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ai_service_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_type TEXT NOT NULL,
      provider TEXT,
      api_protocol TEXT,
      name TEXT,
      base_url TEXT,
      api_key TEXT,
      model TEXT,
      default_model TEXT,
      endpoint TEXT,
      query_endpoint TEXT,
      priority INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      settings TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
  `);
  return db;
}

const log = { info() {}, warn() {}, error() {} };

describe('normalizeYinziCatalog', () => {
  it('preserves opaque model names and groups media endpoints', () => {
    const result = normalizeYinziCatalog({
      success: true,
      pricing_version: 'v1',
      data: [
        { model_name: 'mg-seedance2.0 -480p mini', supported_endpoint_types: ['openai-video', 'openai'], enable_groups: ['视频组'], group_pricing: { v: { group: '视频组', billing_mode: 'fixed_price', billing_unit: 'per_second', effective_model_price: 0.2004 } } },
        { model_name: 'gpt-image-2', supported_endpoint_types: ['image-generation', 'openai'], enable_groups: ['图片组'] },
        { model_name: 'gpt-5.4-mini', supported_endpoint_types: ['openai'], enable_groups: ['文本组'] },
        { model_name: 'gpt-5.6-sol', supported_endpoint_types: ['openai'], enable_groups: ['文本组'] },
      ],
    });
    assert.equal(result.video[0].model, 'mg-seedance2.0 -480p mini');
    assert.equal(result.video[0].cheapest_effective_price, 0.2004);
    assert.equal(result.video[0].capabilities.max_images, 4);
    assert.equal(result.video[0].capabilities.max_videos, 3);
    assert.equal(result.video[0].capabilities.max_audios, 1);
    assert.equal(result.video[0].capabilities.duration_min, 5);
    assert.equal(result.video[0].capabilities.duration_max, 15);
    assert.equal(result.image[0].model, 'gpt-image-2');
    assert.equal(result.text[0].model, 'gpt-5.6-sol');
  });

  it('uses the V0.1.2 video price snapshot while the public catalog is on the known stale revision', () => {
    const staleVideoPrice = (model, unit, value, group = '特价视频分组(即梦)') => ({
      model_name: model,
      supported_endpoint_types: ['openai-video', 'openai'],
      enable_groups: [group],
      group_pricing: {
        [group]: {
          group,
          billing_mode: unit === 'per_million_tokens' ? 'ratio' : 'fixed_price',
          billing_unit: unit,
          effective_model_price: value,
          effective_input_usd: unit === 'per_million_tokens' ? value : null,
          effective_output_usd: unit === 'per_million_tokens' ? value : null,
        },
      },
    });
    const result = normalizeYinziCatalog({
      success: true,
      pricing_version: 'a42d372ccf0b5dd13ecf71203521f9d2',
      data: [
        staleVideoPrice('mg-seedance2.0 -480p mini', 'per_second', 0.2004),
        staleVideoPrice('af-seedance-2.0', 'per_million_tokens', 90),
        staleVideoPrice('seedance-2.5-720p', 'per_million_tokens', 90),
        staleVideoPrice('grok-imagine-video', 'per_request', 0.1125, '视频模型渠道'),
        staleVideoPrice('MiniMax-H3-2k', 'per_second', 0.205, 'minimax/可灵视频'),
        staleVideoPrice('Kling VIDEO 3.0 Omni', 'per_request', 0.25, 'minimax/可灵视频'),
      ],
    });
    const price = (model) => result.video.find((item) => item.model === model).prices[0];
    assert.deepEqual(price('mg-seedance2.0 -480p mini'), {
      group: '特价视频分组(即梦)', billing_mode: 'fixed_price', billing_unit: 'per_second',
      effective_price: 0.1664, effective_input_usd: null, effective_output_usd: null,
      fixed_duration_seconds: null, currency: 'CNY', source: 'yinzi-catalog-2026-08-16',
    });
    assert.equal(price('af-seedance-2.0').billing_unit, 'per_request');
    assert.equal(price('af-seedance-2.0').effective_price, 0.3484);
    assert.equal(price('seedance-2.5-720p').billing_unit, 'per_second');
    assert.equal(price('seedance-2.5-720p').effective_price, 0.672);
    assert.equal(price('grok-imagine-video').effective_price, 0.1125);
    assert.equal(price('MiniMax-H3-2k').effective_price, 0.20475);
    assert.equal(price('Kling VIDEO 3.0 Omni').effective_price, 0.25);
  });
});

describe('normalizeYinziBaseUrl', () => {
  it('adds /v1 only when the URL has no API path', () => {
    assert.equal(normalizeYinziBaseUrl('https://api.yinziapi.top'), 'https://api.yinziapi.top/v1');
    assert.equal(normalizeYinziBaseUrl('https://relay.example/api/v1/'), 'https://relay.example/api/v1');
  });
});

describe('fetchYinziCatalogForConfig', () => {
  it('uses the key-scoped capability catalog and preserves Seedance 2.5 reference limits', async () => {
    let request = null;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            schema_version: 'yinzi.model-capability-catalog/v1',
            catalog_revision: 'cap-v1',
            models: [{
              group: 'video', model: 'seedance-2.5-720p', contract_status: 'active', automatic_eligible: true,
              local_pricing: { billing_mode: 'fixed_price', use_price: true, model_price: 0.7644, task_profile: { unit: 'per_second' } },
              capabilities: {
                schema_version: 'relayops.model-capability-contract/v1', contract_id: 'seedance-25', revision: 'r1',
                target: { site_id: 1, group: 'video', model: 'seedance-2.5-720p' },
                provider: { protocol: 'aizzz-video-v1', endpoint_types: ['openai-video'], create: { method: 'POST', path: '/videos' } },
                generation: { duration: { mode: 'free', min: 5, max: 15, step: 1 }, resolutions: ['720p'], quality: 'quality' },
                references: {
                  images: { roles: ['reference'], max: 30, max_bytes: 31457280 },
                  videos: { roles: ['reference'], max: 10, max_total_duration_seconds: 29 },
                  audios: { roles: ['reference'], max: 10 }, max_total: 50, prompt_max_chars: 4000,
                },
                routing: { automatic_eligible: true, expensive: false, manual_only: false, requires_explicit_confirmation: false },
                provenance: { source_kind: 'document', generated_at: '2026-08-16T00:00:00Z', validation_status: 'validated' },
              },
            }],
          };
        },
      };
    };
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-cap.example/v1', api_key: 'capability-key-1' }, fetchImpl);
    assert.equal(request.url, 'https://relay-cap.example/v1/model-capabilities');
    assert.equal(request.options.headers.Authorization, 'Bearer capability-key-1');
    assert.equal(catalog.catalog_verified, true);
    assert.equal(catalog.video[0].capabilities.max_images, 30);
    assert.equal(catalog.video[0].capabilities.max_videos, 10);
    assert.equal(catalog.video[0].capabilities.max_audios, 10);
    assert.equal(catalog.video[0].automatic_eligible, true);
  });

  it('keeps missing contracts visible but manual-only', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, async json() {
      return { catalog_revision: 'cap-missing', models: [{ group: 'video', model: 'new-video', contract_status: 'missing', capabilities: null, local_pricing: {} }] };
    } });
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-missing.example/v1', api_key: 'capability-key-2' }, fetchImpl);
    assert.equal(catalog.video[0].model, 'new-video');
    assert.equal(catalog.video[0].capabilities, null);
    assert.equal(catalog.video[0].contract_status, 'missing');
    assert.equal(catalog.video[0].automatic_eligible, false);
  });

  it('falls back only for unavailable capability endpoints and marks the result unverified', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 404 };
      return { ok: true, status: 200, async json() { return { success: true, pricing_version: 'legacy-v1', data: [] }; } };
    };
    const catalog = await fetchYinziCatalogForConfig({ base_url: 'https://relay-legacy.example/v1', api_key: 'capability-key-3' }, fetchImpl);
    assert.equal(call, 2);
    assert.equal(catalog.source, 'legacy_fallback');
    assert.equal(catalog.catalog_verified, false);
  });

  it('does not hide an authentication failure behind the legacy catalog', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    await assert.rejects(
      fetchYinziCatalogForConfig({ base_url: 'https://relay-auth.example/v1', api_key: 'capability-key-4' }, fetchImpl),
      /HTTP 401/
    );
  });
});

describe('upsertYinziConfigs', () => {
  it('atomically creates four configs, uses separate keys, and never returns secrets', () => {
    const db = createConfigDb();
    const result = upsertYinziConfigs(db, log, {
      base_url: 'https://api.yinziapi.top/v1',
      text_api_key: 'text-secret',
      image_api_key: 'image-secret',
      video_api_key: 'video-secret',
      text_model: 'gpt-5.4-mini',
      image_model: 'gpt-image-2',
      video_model: 'mg-seedance2.0 -480p mini',
    });
    assert.equal(result.configured.length, 4);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    const rows = db.prepare('SELECT service_type, api_key, api_protocol, model FROM ai_service_configs ORDER BY id').all();
    assert.deepEqual(rows.map((row) => row.api_key), ['text-secret', 'image-secret', 'image-secret', 'video-secret']);
    assert.equal(rows[3].api_protocol, 'yinzi');
    assert.equal(JSON.parse(rows[3].model)[0], 'mg-seedance2.0 -480p mini');
  });

  it('updates existing Yinzi configs instead of creating duplicates', () => {
    const db = createConfigDb();
    const base = {
      base_url: 'https://api.yinziapi.top/v1',
      text_api_key: 'a', image_api_key: 'b', video_api_key: 'c',
      text_model: 'gpt-5.4-mini', image_model: 'gpt-image-2', video_model: 'mg-seedance2.0 -480p mini',
    };
    upsertYinziConfigs(db, log, base);
    upsertYinziConfigs(db, log, { ...base, video_api_key: 'new-video-key' });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_service_configs WHERE deleted_at IS NULL").get().n, 4);
    assert.equal(db.prepare("SELECT api_key FROM ai_service_configs WHERE service_type='video' AND deleted_at IS NULL").get().api_key, 'new-video-key');
  });
});
