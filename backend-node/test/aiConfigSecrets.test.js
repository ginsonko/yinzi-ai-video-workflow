const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');

function createDb() {
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

describe('AI config secret boundaries', () => {
  it('redacts API keys from public config responses', () => {
    const publicConfig = aiConfigService.toPublicConfig({ id: 7, api_key: 'private-value' });
    assert.equal(publicConfig.api_key, '');
    assert.equal(publicConfig.has_api_key, true);
    assert.equal(JSON.stringify(publicConfig).includes('private-value'), false);
  });

  it('preserves the stored API key when an update omits api_key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image',
      provider: 'yinzi',
      name: 'Yinzi image',
      base_url: 'https://api.yinziapi.top/v1',
      api_key: 'private-value',
      model: ['gpt-image-2'],
    });
    aiConfigService.updateConfig(db, log, created.id, { name: 'Renamed' });
    const row = db.prepare('SELECT api_key, name FROM ai_service_configs WHERE id = ?').get(created.id);
    assert.equal(row.api_key, 'private-value');
    assert.equal(row.name, 'Renamed');
  });
});
