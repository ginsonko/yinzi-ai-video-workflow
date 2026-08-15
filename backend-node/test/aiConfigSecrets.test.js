const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const aiConfigService = require('../src/services/aiConfigService');
const createAiConfigRoutes = require('../src/routes/aiConfig');

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

function captureResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

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

  it('resolves a saved config by ID without requiring the browser to return its key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved image',
      base_url: 'https://saved.example/v1/', api_key: 'saved-private-value',
      model: ['first-model', 'second-model'], default_model: 'second-model',
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, { config_id: created.id });
    assert.equal(result.config.base_url, 'https://saved.example/v1');
    assert.equal(result.config.api_key, 'saved-private-value');
    assert.equal(result.config.model, 'second-model');
    assert.equal(result.credential_source, 'saved');
  });

  it('tests current draft URL and model while reusing a saved key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved image',
      base_url: 'https://old.example/v1', api_key: 'saved-private-value', model: ['old-model'],
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, {
      config_id: created.id,
      draft: {
        base_url: 'https://draft.example/v1', model: ['draft-model'], default_model: 'draft-model', api_key: '',
      },
    });
    assert.equal(result.config.base_url, 'https://draft.example/v1');
    assert.equal(result.config.model, 'draft-model');
    assert.equal(result.config.api_key, 'saved-private-value');
    assert.equal(result.credential_source, 'saved');
  });

  it('uses a temporary draft key without mutating the saved key', () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'text', provider: 'yinzi', name: 'Saved text',
      base_url: 'https://saved.example/v1', api_key: 'saved-private-value', model: ['text-model'],
    });
    const result = aiConfigService.resolveConnectionTestConfig(db, {
      config_id: created.id,
      draft: { api_key: 'temporary-private-value' },
    });
    assert.equal(result.config.api_key, 'temporary-private-value');
    assert.equal(result.credential_source, 'draft');
    assert.equal(aiConfigService.getConfig(db, created.id).api_key, 'saved-private-value');
  });

  it('rejects invalid IDs and accurately explains genuinely missing fields', () => {
    const db = createDb();
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { config_id: 999 }),
      /配置不存在或已删除/,
    );
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { draft: { base_url: '', api_key: 'x' } }),
      /缺少 Base URL/,
    );
    assert.throws(
      () => aiConfigService.resolveConnectionTestConfig(db, { draft: { base_url: 'https:\/\/example.test' } }),
      /缺少 API Key/,
    );
  });

  it('redacts exact and patterned credentials from connection errors', () => {
    const safe = aiConfigService.redactConnectionTestError(
      new Error('upstream echoed temporary-private-value and Bearer abcdefghijklmnop and sk-abcdefgh12345678'),
      ['temporary-private-value'],
    );
    assert.equal(safe.includes('temporary-private-value'), false);
    assert.equal(safe.includes('abcdefghijklmnop'), false);
    assert.equal(safe.includes('sk-abcdefgh12345678'), false);
  });

  it('uses only GET read-only probes for Yinzi image and video configs', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      return { status: 200, ok: true };
    };
    try {
      const image = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'image', model: 'gpt-image-2',
      });
      const video = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'video', model: 'video-model',
      });
      assert.deepEqual(calls.map((item) => item.method), ['GET', 'GET']);
      assert.match(calls[0].url, /\/models$/);
      assert.match(calls[1].url, /\/videos\/codex-connectivity-check-does-not-exist$/);
      assert.equal(image.generated_media, false);
      assert.equal(video.generated_media, false);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uses a minimal text response probe for Yinzi text configs', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
    };
    try {
      const result = await aiConfigService.testConnection({
        base_url: 'https://api.example/v1', api_key: 'runtime-only', provider: 'yinzi',
        service_type: 'text', model: 'gpt-5.6-sol',
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, 'POST');
      assert.match(calls[0].url, /\/chat\/completions$/);
      assert.equal(calls[0].body.max_tokens, 5);
      assert.equal(result.probe, 'minimal_text_response');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('routes a saved config ID through SQLite without returning its key', async () => {
    const db = createDb();
    const created = aiConfigService.createConfig(db, log, {
      service_type: 'image', provider: 'yinzi', name: 'Saved route image',
      base_url: 'https://api.example/v1', api_key: 'route-private-value', model: ['gpt-image-2'],
    });
    const originalFetch = global.fetch;
    let authorization = '';
    global.fetch = async (_url, options = {}) => {
      authorization = options.headers?.Authorization || '';
      return { status: 200, ok: true };
    };
    try {
      const res = captureResponse();
      await createAiConfigRoutes(db, log, {}).testConnection({ body: { config_id: created.id } }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.credential_source, 'saved');
      assert.equal(res.body.data.generated_media, false);
      assert.equal(authorization, 'Bearer route-private-value');
      assert.equal(JSON.stringify(res.body).includes('route-private-value'), false);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
