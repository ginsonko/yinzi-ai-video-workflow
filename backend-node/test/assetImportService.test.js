const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const service = require('../src/services/assetImportService');

let db; let sourceDir; let storageDir; let run;
const log = { info() {}, warn() {}, error() {} };
beforeEach(() => {
  db = new Database(':memory:'); const old = console.log; const oldWarn = console.warn; console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = old; console.warn = oldWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('测试剧', now, now);
  db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('第一集', now, now);
  run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: `import-${Date.now()}-${Math.random()}`, input: { story: '导入测试' } }).run;
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-import-source-')); storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-import-storage-'));
  fs.writeFileSync(path.join(sourceDir, 'story.txt'), '第一场：少女走进温室。');
  fs.writeFileSync(path.join(sourceDir, 'hero.png'), Buffer.from('image-bytes'));
  fs.writeFileSync(path.join(sourceDir, 'clip.mp4'), Buffer.from('video-bytes'));
});
afterEach(() => { db.close(); fs.rmSync(sourceDir, { recursive: true, force: true }); fs.rmSync(storageDir, { recursive: true, force: true }); });

describe('asset import sessions', () => {
  it('scans mixed files into a persisted preview plan without writing production artifacts', async () => {
    const session = service.createSession(db, { source_label: '测试文件夹', target_run_id: run.id });
    const result = await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' },
      { relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png'), detected_type: 'character', candidate_stage: 'asset_images', scope_id: 'hero' },
      { relative_path: 'clip.mp4', source_path: path.join(sourceDir, 'clip.mp4'), candidate_stage: 'shot_video', scope_id: '1' },
    ] }, {}, log);
    assert.equal(result.session.status, 'planned'); assert.equal(result.plan.summary.total, 3); assert.equal(result.plan.summary.ready, 3);
    assert.equal(result.plan.ai.used, false); assert.equal(service.listItems(db, session.id).length, 3);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 0);
    const recovered = service.getSession(db, session.id); assert.equal(recovered.status, 'planned'); assert.equal(recovered.plan.items[0].detected_type, 'text');
  });
  it('keeps unknown and oversized files as partial/unknown instead of blocking the plan', async () => {
    const unknown = path.join(sourceDir, 'notes.xyz'); fs.writeFileSync(unknown, '???');
    const session = service.createSession(db, { target_run_id: run.id });
    const result = await service.scanSession(db, session.id, { options: { max_file_bytes: 1 }, files: [
      { relative_path: 'notes.xyz', source_path: unknown },
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') },
    ] }, {}, log);
    assert.equal(result.plan.items[0].detected_type, 'unknown'); assert.equal(result.plan.items[0].candidate_stage, null);
    assert.equal(result.plan.items[0].status, 'partial'); assert.equal(result.plan.items[1].status, 'partial');
    assert.equal(result.plan.items[0].metadata.probe_available, undefined);
  });
  it('applies only after explicit confirmation and rollback soft-deletes created artifacts', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' },
      { relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png'), candidate_stage: 'asset_images', scope_id: 'hero' },
    ] }, {}, log);
    assert.throws(() => service.applySession(db, { storage: { local_path: storageDir } }, session.id, {}), /confirm=true/);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    assert.equal(applied.reused, false); assert.equal(applied.artifacts.length, 2); assert.equal(service.getSession(db, session.id).status, 'applied');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 1);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'asset_images', page_size: 100 }).items.length, 1);
    const repeated = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true }); assert.equal(repeated.reused, true);
    const rolled = service.rollbackSession(db, { storage: { local_path: storageDir } }, session.id); assert.equal(rolled.rolled_back_artifacts.length, 2);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 0);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'asset_images', page_size: 100 }).items.length, 0);
    assert.equal(service.getSession(db, session.id).status, 'rolled_back');
  });
  it('uses an injected classifier and does not log source text', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { classifier_model: 'gpt-5.6-sol' } });
    const seen = []; const result = await service.scanSession(db, session.id, { files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }] }, {
      classify: async ({ file }) => { seen.push(file.relativePath); return { detected_type: 'script', candidate_stage: 'script', confidence: 0.98, evidence: { reason: '内容结构' } }; },
    }, log);
    assert.deepEqual(seen, ['story.txt']); assert.equal(result.plan.ai.used, true); assert.equal(result.plan.items[0].candidate_stage, 'script'); assert.equal(result.plan.items[0].confidence, 0.98);
  });

  it('stages browser uploads behind opaque tokens and scans them without exposing host paths', async () => {
    const session = service.createSession(db, { source_label: '浏览器上传', target_run_id: run.id });
    const uploadTemp = path.join(sourceDir, 'browser-upload.tmp');
    fs.writeFileSync(uploadTemp, '来自浏览器的剧本');
    const staged = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: uploadTemp, originalname: 'nested/story.txt', mimetype: 'text/plain' },
    ], ['nested/story.txt']);
    assert.equal(staged.files.length, 1);
    assert.ok(staged.files[0].source_token);
    assert.equal(JSON.stringify(staged).includes(storageDir), false);
    const scanned = await service.scanSession(db, session.id, {
      files: [{ relative_path: staged.files[0].relative_path, source_token: staged.files[0].source_token, candidate_stage: 'script' }],
    }, {}, log);
    assert.equal(scanned.plan.items[0].status, 'ready');
    assert.equal(scanned.plan.items[0].candidate_stage, 'script');
    assert.equal(JSON.stringify(scanned).includes(storageDir), false);
    assert.equal(JSON.stringify(scanned).includes('source_path'), false);
  });

  it('allows explicit per-item type/stage/include edits and rejects stale revisions', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const scanned = await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') },
      { relative_path: 'clip.mp4', source_path: path.join(sourceDir, 'clip.mp4') },
    ] }, {}, log);
    const story = scanned.items.find((item) => item.relative_path === 'story.txt');
    const clip = scanned.items.find((item) => item.relative_path === 'clip.mp4');
    const edited = service.updatePlan(db, session.id, { expected_version: scanned.session.version, items: [
      { id: story.id, detected_type: 'script', candidate_stage: 'script', candidate_scope_type: 'run', include: true },
      { id: clip.id, detected_type: 'video', candidate_stage: 'shot_video', candidate_scope_type: 'shot', candidate_scope_id: '2', include: false },
    ] });
    assert.equal(edited.plan.summary.ready, 1);
    assert.equal(edited.plan.summary.excluded, 1);
    assert.equal(edited.items.find((item) => item.id === clip.id).status, 'excluded');
    assert.throws(() => service.updatePlan(db, session.id, { expected_version: scanned.session.version, items: [{ id: story.id, candidate_stage: 'asset_text' }] }), /版本/);
  });

  it('cleans only expired browser staging and records an actionable expiry state', () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { staging_ttl_hours: 1 } });
    const stagedRoot = path.join(storageDir, 'imports', '.staging', session.id);
    fs.mkdirSync(stagedRoot, { recursive: true });
    fs.writeFileSync(path.join(stagedRoot, 'opaque.txt'), 'temporary');
    db.prepare('UPDATE asset_import_sessions SET options_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ staged_root: stagedRoot, staged_files: { token: { source_path: path.join(stagedRoot, 'opaque.txt') } }, staging_ttl_hours: 1 }), new Date(Date.now() - 2 * 3600000).toISOString(), session.id);
    const result = service.cleanupExpiredStaging(db, { storage: { local_path: storageDir } }, log);
    assert.equal(result.cleaned, 1);
    assert.equal(fs.existsSync(stagedRoot), false);
    const expired = service.getSession(db, session.id);
    assert.equal(expired.error_code, 'ASSET_IMPORT_STAGING_EXPIRED');
    assert.match(expired.error_message, /重新上传/);
    assert.deepEqual(expired.options.staged_files, {});
  });

  it('keeps sampled frame bytes out of persisted media metadata', () => {
    const serialized = service.serializableMediaMetadata({
      probe_available: true,
      frames: [{ timestamp_seconds: 1.25, bytes: 10, sha256: 'abc', buffer: Buffer.from('secret') }],
    });
    assert.equal(serialized.frames, undefined);
    assert.deepEqual(serialized.sample_frames, [{ timestamp_seconds: 1.25, bytes: 10, sha256: 'abc' }]);
    assert.equal(JSON.stringify(serialized).includes('secret'), false);
  });
});
