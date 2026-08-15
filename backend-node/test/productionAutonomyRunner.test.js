const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const {
  createProductionAutonomyRunner,
  delayForOutcome,
  shouldScheduleRun,
} = require('../src/services/productionAutonomyRunner');

let db;
const log = { info() {}, warn() {}, error() {} };

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function createRun(owner, suffix) {
  return repo.createRun(db, {
    drama_id: 1,
    review_owner: owner,
    idempotency_key: `runner-${suffix}`,
    input: { story: '一个用于后台推进器测试的完整故事输入。' },
  }).run;
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('后台任务', now, now);
});

afterEach(() => db.close());

describe('production autonomy runner', () => {
  it('schedules only non-human runnable work and respects intervention/client stops', () => {
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'running', runtime: {} }), true);
    assert.equal(shouldScheduleRun({ review_owner: 'auto_accept', status: 'waiting_provider', runtime: {} }), true);
    assert.equal(shouldScheduleRun({ review_owner: 'human', status: 'running', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_client', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', waiting_reason: 'manual_content_required', runtime: {} }), false);
    assert.equal(shouldScheduleRun({ review_owner: 'ai', status: 'waiting_review', runtime: { autonomy: { intervention: {} } } }), false);
  });

  it('uses short progress delay and slower provider polling', () => {
    assert.equal(delayForOutcome({ state: 'progressed' }, { progress_delay_ms: 25 }), 25);
    assert.equal(delayForOutcome({ state: 'waiting_provider' }, { provider_delay_ms: 2500 }), 2500);
  });

  it('advances a runnable AI task once and leaves human tasks untouched', async () => {
    const aiRun = createRun('ai', 'ai');
    const humanRun = createRun('human', 'human');
    repo.updateRun(db, aiRun.id, { status: 'running' });
    repo.updateRun(db, humanRun.id, { status: 'running' });
    const calls = [];
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: {
        async advance(runId, input) {
          calls.push({ runId, input });
          repo.updateRun(db, runId, { status: 'waiting_provider', waiting_reason: 'test_provider' });
          return { state: 'waiting_provider' };
        },
      },
      now: () => 1000,
      max_runs_per_tick: 4,
    });
    const result = await runner.runOnce();
    assert.equal(result.processed, 1);
    assert.equal(calls[0].runId, aiRun.id);
    assert.match(calls[0].input.lease_owner, /^autonomy-/);
    assert.equal(repo.getRun(db, humanRun.id).status, 'running');
    runner.stop();
  });

  it('recovers persisted autonomous work after a fresh runner starts without touching hard stops', async () => {
    const resumable = createRun('ai', 'restart-resumable');
    const human = createRun('human', 'restart-human');
    const ambiguous = createRun('auto_accept', 'restart-ambiguous');
    repo.updateRun(db, resumable.id, {
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    repo.updateRun(db, human.id, {
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: 'manual task failure',
    });
    repo.updateRun(db, ambiguous.id, {
      status: 'waiting_review', waiting_reason: 'ambiguous_external_task',
      error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: 'provider result unknown',
    });

    const calls = [];
    const runner = createProductionAutonomyRunner(db, {}, log, {
      service: {
        async advance(runId) {
          calls.push(runId);
          repo.updateRun(db, runId, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
          return { state: 'progressed' };
        },
      },
      now: () => 5000,
      max_runs_per_tick: 10,
    });

    const result = await runner.runOnce();
    assert.equal(result.processed, 1);
    assert.deepEqual(calls, [resumable.id]);
    assert.equal(repo.getRun(db, human.id).status, 'failed');
    assert.equal(repo.getRun(db, ambiguous.id).waiting_reason, 'ambiguous_external_task');
    runner.stop();
  });
});
