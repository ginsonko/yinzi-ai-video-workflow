const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { setupRouter } = require('../src/routes');
const repo = require('../src/services/productionRepository');

let db; let server; let baseUrl; let storageDir;
const log = { info() {}, warn() {}, error() {} };

async function request(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-import-route-storage-'));
  db = new Database(':memory:');
  const oldLog = console.log; const oldWarn = console.warn; console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('导入路由测试', now, now);
  db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('第一集', now, now);
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use('/api', setupRouter({ storage: { local_path: storageDir, base_url: 'http://localhost/static' } }, db, log));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close(); fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('asset import HTTP upload', () => {
  it('accepts browser multipart files and scans by opaque token', async () => {
    const run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: 'route-import', input: { story: '测试' } }).run;
    const created = await request('/asset-import-sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_label: '浏览器', target_run_id: run.id }),
    });
    assert.equal(created.status, 201);
    const form = new FormData();
    form.append('files', new Blob(['这是导入剧本']), 'story.txt');
    form.append('relative_paths', JSON.stringify(['novel/story.txt']));
    const uploaded = await request(`/asset-import-sessions/${created.body.data.id}/upload`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.data.files.length, 1);
    assert.ok(uploaded.body.data.files[0].source_token);
    assert.equal(JSON.stringify(uploaded.body).includes(storageDir), false);
    const scanned = await request(`/asset-import-sessions/${created.body.data.id}/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ ...uploaded.body.data.files[0], candidate_stage: 'script' }] }),
    });
    assert.equal(scanned.status, 200);
    assert.equal(scanned.body.data.plan.items[0].status, 'ready');
    assert.equal(JSON.stringify(scanned.body).includes(storageDir), false);
    assert.equal(JSON.stringify(scanned.body).includes('source_path'), false);
  });

  it('positions a newly created run at an imported approved script after confirmation', async () => {
    const run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: 'route-import-position', input: { story: '占位故事' } }).run;
    const created = await request('/asset-import-sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_label: '脚本', target_run_id: run.id }),
    });
    const form = new FormData(); form.append('files', new Blob(['完整剧本内容足够长。']), 'script.txt');
    form.append('relative_paths', JSON.stringify(['script.txt']));
    const uploaded = await request(`/asset-import-sessions/${created.body.data.id}/upload`, { method: 'POST', body: form });
    const scanned = await request(`/asset-import-sessions/${created.body.data.id}/scan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [{ ...uploaded.body.data.files[0], candidate_stage: 'script' }] }),
    });
    assert.equal(scanned.status, 200);
    const applied = await request(`/asset-import-sessions/${created.body.data.id}/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.data.session.status, 'applied');
    assert.equal(repo.getRun(db, run.id).current_stage, 'script');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', current: true, status: 'approved', page_size: 10 }).items.length, 1);
    assert.equal(fs.existsSync(path.join(storageDir, 'imports', '.staging', created.body.data.id)), false);
  });
});
