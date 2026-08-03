const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizeYinziBaseUrl,
  normalizeYinziCatalog,
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
    assert.equal(result.text[0].model, 'gpt-5.4-mini');
  });
});

describe('normalizeYinziBaseUrl', () => {
  it('adds /v1 only when the URL has no API path', () => {
    assert.equal(normalizeYinziBaseUrl('https://api.yinziapi.top'), 'https://api.yinziapi.top/v1');
    assert.equal(normalizeYinziBaseUrl('https://relay.example/api/v1/'), 'https://relay.example/api/v1');
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
