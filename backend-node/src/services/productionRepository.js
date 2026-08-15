const crypto = require('node:crypto');
const graph = require('./productionGraph');
const {
  createFinalEditContract,
  finalVideoMatchesContract,
} = require('./productionFinalEditContract');
const { normalizeProductionAspectRatio } = require('./productionAspectRatio');
const costLedger = require('./productionCostLedger');
const settingsService = require('./settingsService');

function nowIso() {
  return new Date().toISOString();
}

function defaultImageConfigId(db, serviceType) {
  const row = db.prepare(
    `SELECT id FROM ai_service_configs
     WHERE deleted_at IS NULL AND is_active = 1 AND service_type = ?
     ORDER BY is_default DESC, priority DESC, created_at DESC, id ASC LIMIT 1`
  ).get(serviceType);
  return row?.id == null ? null : Number(row.id);
}

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function json(value, fallback = {}) {
  return JSON.stringify(value == null ? fallback : value);
}

function hashJson(value) {
  return crypto.createHash('sha256').update(json(value)).digest('hex');
}

function toRun(row) {
  if (!row) return null;
  const policy = parseJson(row.policy_json);
  policy.aspect_ratio = normalizeProductionAspectRatio(policy.aspect_ratio);
  return {
    ...row,
    manual_next_default: !!row.manual_next_default,
    input: parseJson(row.input_json),
    policy,
    budget: parseJson(row.budget_json),
    usage: parseJson(row.usage_json),
    review_profile: parseJson(row.review_profile_json),
    runtime: parseJson(row.runtime_json),
    input_json: undefined,
    policy_json: undefined,
    budget_json: undefined,
    usage_json: undefined,
    review_profile_json: undefined,
    runtime_json: undefined,
  };
}

function toArtifact(row) {
  if (!row) return null;
  return {
    ...row,
    content: parseJson(row.content_json),
    content_json: undefined,
  };
}

function toAction(row) {
  if (!row) return null;
  return {
    ...row,
    request: parseJson(row.request_json),
    result: parseJson(row.result_json, null),
    request_json: undefined,
    result_json: undefined,
  };
}

function toReview(row) {
  if (!row) return null;
  return {
    ...row,
    scores: parseJson(row.scores_json),
    evidence: parseJson(row.evidence_json),
    scores_json: undefined,
    evidence_json: undefined,
  };
}

function appendEvent(db, runId, eventType, details = {}) {
  const timestamp = nowIso();
  const info = db.prepare(
    `INSERT INTO production_events
      (run_id, event_type, stage, scope_type, scope_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    eventType,
    details.stage || null,
    details.scope_type || null,
    details.scope_id == null ? null : String(details.scope_id),
    json(details.payload || {}),
    timestamp
  );
  return Number(info.lastInsertRowid);
}

function findRunByIdempotency(db, dramaId, episodeId, key) {
  if (!key) return null;
  return toRun(db.prepare(
    `SELECT * FROM production_runs
     WHERE drama_id = ? AND IFNULL(episode_id, 0) = IFNULL(?, 0)
       AND idempotency_key = ? AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).get(Number(dramaId), episodeId == null ? null : Number(episodeId), key));
}

function createRun(db, input) {
  const dramaId = Number(input.drama_id);
  if (!Number.isInteger(dramaId) || dramaId <= 0) throw new Error('drama_id 必须是正整数');
  const episodeId = input.episode_id == null ? null : Number(input.episode_id);
  const reviewOwner = graph.normalizeReviewOwner(input.review_owner);
  const nextStrategy = graph.normalizeNextStrategy(input.next_stage_strategy);
  const idempotencyKey = input.idempotency_key ? String(input.idempotency_key).trim() : null;
  const existing = findRunByIdempotency(db, dramaId, episodeId, idempotencyKey);
  if (existing) return { run: existing, reused: true };

  const source = input.input || {};
  const storyText = String(source.story || source.text || source.premise || '').trim();
  const sourceType = source.source_type === 'novel' ? 'novel' : 'idea';
  if (!storyText) throw new Error(sourceType === 'novel' ? '请导入小说内容' : '请先输入故事');

  const id = input.id || crypto.randomUUID();
  const timestamp = nowIso();
  const defaultBudget = settingsService.getGlobalSetting(db, 'production_default_budget', {});
  const allowUnknownPrice = settingsService.getGlobalSetting(db, 'production_allow_unknown_price', false);
  const budget = {
    max_video_attempts: 10,
    max_video_seconds: 60,
    max_shots: 12,
    max_text_revisions: 3,
    max_image_revisions: 3,
    max_director_revisions: 2,
    max_video_attempts_per_shot: 2,
    ...(defaultBudget && typeof defaultBudget === 'object' ? defaultBudget : {}),
    allow_unknown_price: Boolean(allowUnknownPrice),
    ...(input.budget || {}),
  };
  const usage = { video_attempts_reserved: 0, video_seconds_reserved: 0, ...(input.usage || {}) };
  const policy = {
    aspect_ratio: '16:9',
    target_shots: 3,
    image_concurrency: 4,
    asset_image_model: '',
    storyboard_image_model: '',
    asset_image_config_id: defaultImageConfigId(db, 'image'),
    storyboard_image_config_id: defaultImageConfigId(db, 'storyboard_image'),
    video_model: '',
    video_duration_min: 5,
    director_mode: 'auto',
    allow_auto_model_switch: true,
    keep_provider_audio: true,
    subtitles: false,
    ...(input.policy || {}),
  };
  policy.aspect_ratio = normalizeProductionAspectRatio(policy.aspect_ratio);
  const runtime = {
    ...(input.runtime || {}),
    shot_pipeline: {
      mode: 'sequential',
      ...(input.runtime?.shot_pipeline || {}),
    },
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO production_runs (
        id, drama_id, episode_id, idempotency_key, graph_version, handler_version,
        review_owner, next_stage_strategy, manual_next_default, status, current_stage,
        input_json, policy_json, budget_json, usage_json, review_profile_json, runtime_json,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'story_input', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      id, dramaId, episodeId, idempotencyKey, graph.GRAPH_VERSION, graph.HANDLER_VERSION,
      reviewOwner, nextStrategy, input.manual_next_default ? 1 : 0,
      json({ ...source, story: storyText, source_type: sourceType }), json(policy), json(budget),
      json(usage), json(input.review_profile || {}), json(runtime), timestamp, timestamp
    );
    const artifact = createArtifact(db, {
      run_id: id,
      stage: 'story_input',
      scope_type: 'run',
      scope_id: '',
      status: 'approved',
      title: sourceType === 'novel' ? '导入小说' : '故事构想',
      content: { ...source, story: storyText, source_type: sourceType, included: true },
      approved_at: timestamp,
    });
    addReview(db, {
      run_id: id,
      artifact_id: artifact.id,
      reviewer_type: 'human',
      decision: 'approved',
      reason: '用户提交的创作源内容',
    });
    appendEvent(db, id, 'run.created', { stage: 'story_input', payload: { review_owner: reviewOwner } });
  });
  try {
    tx.immediate();
  } catch (error) {
    const raced = findRunByIdempotency(db, dramaId, episodeId, idempotencyKey);
    if (raced) return { run: raced, reused: true };
    throw error;
  }
  return { run: getRun(db, id), reused: false };
}

function getRun(db, id) {
  return toRun(db.prepare('SELECT * FROM production_runs WHERE id = ? AND deleted_at IS NULL').get(id));
}

function listRuns(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size) || 20));
  const clauses = ['deleted_at IS NULL'];
  const params = [];
  if (query.drama_id) { clauses.push('drama_id = ?'); params.push(Number(query.drama_id)); }
  if (query.episode_id) { clauses.push('episode_id = ?'); params.push(Number(query.episode_id)); }
  if (query.status) { clauses.push('status = ?'); params.push(String(query.status)); }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM production_runs WHERE ${where}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM production_runs WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize).map(toRun);
  return { items: rows, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } };
}

function updateRun(db, runId, patch, expectedVersion = null) {
  const run = getRun(db, runId);
  if (!run) return null;
  if (expectedVersion != null && Number(expectedVersion) !== Number(run.version)) {
    const error = new Error('制作任务已在其他页面更新，请刷新后重试');
    error.code = 'VERSION_CONFLICT';
    throw error;
  }
  const allowed = new Map([
    ['status', (value) => graph.assertEnum(value, graph.RUN_STATUSES, 'status')],
    ['current_stage', (value) => { if (!graph.getStage(value)) throw new Error(`未知阶段 ${value}`); return value; }],
    ['current_scope_type', (value) => value == null ? null : String(value)],
    ['current_scope_id', (value) => value == null ? null : String(value)],
    ['review_owner', graph.normalizeReviewOwner],
    ['next_stage_strategy', graph.normalizeNextStrategy],
    ['manual_next_default', (value) => value ? 1 : 0],
    ['waiting_reason', (value) => value == null ? null : String(value)],
    ['error_code', (value) => value == null ? null : String(value)],
    ['error_message', (value) => value == null ? null : String(value)],
    ['completed_at', (value) => value == null ? null : String(value)],
  ]);
  const jsonFields = new Map([
    ['input', 'input_json'], ['policy', 'policy_json'], ['budget', 'budget_json'],
    ['usage', 'usage_json'], ['review_profile', 'review_profile_json'], ['runtime', 'runtime_json'],
  ]);
  const sets = [];
  const values = [];
  for (const [key, normalizer] of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    sets.push(`${key} = ?`); values.push(normalizer(patch[key]));
  }
  for (const [key, column] of jsonFields) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    let value = patch[key];
    if (key === 'policy') {
      const currentAspectRatio = normalizeProductionAspectRatio(run.policy?.aspect_ratio);
      const requestedAspectRatio = Object.prototype.hasOwnProperty.call(value || {}, 'aspect_ratio')
        ? normalizeProductionAspectRatio(value.aspect_ratio)
        : currentAspectRatio;
      if (requestedAspectRatio !== currentAspectRatio) {
        const error = new Error(`任务画幅已在创建时固定为 ${currentAspectRatio}；如需 ${requestedAspectRatio}，请新建制作任务`);
        error.code = 'PRODUCTION_ASPECT_RATIO_LOCKED';
        error.details = {
          run_id: run.id,
          frozen_aspect_ratio: currentAspectRatio,
          requested_aspect_ratio: requestedAspectRatio,
        };
        throw error;
      }
      value = { ...(value || {}), aspect_ratio: currentAspectRatio };
    }
    if (key === 'budget') {
      value = { ...(value || {}) };
      const hasMicroLimit = Object.prototype.hasOwnProperty.call(value, 'max_cost_microusd');
      const hasUsdLimit = Object.prototype.hasOwnProperty.call(value, 'max_cost_usd');
      if (hasMicroLimit || hasUsdLimit) {
        const requestedLimit = hasMicroLimit
          ? (value.max_cost_microusd == null || value.max_cost_microusd === '' ? null : Math.max(0, Math.floor(Number(value.max_cost_microusd))))
          : costLedger.toMicrousd(value.max_cost_usd);
        if (requestedLimit != null && !Number.isFinite(requestedLimit)) throw new Error('任务金额上限必须是非负有限数字');
        const summary = costLedger.sumRun(db, runId);
        const committed = summary.settled_microusd + summary.reserved_microusd + summary.uncertain_microusd;
        if (requestedLimit != null && requestedLimit < committed) {
          const error = new Error(`任务金额上限不能低于当前已结算、已预留和待对账金额 ${costLedger.fromMicrousd(committed).toFixed(6)} USD`);
          error.code = 'COST_BUDGET_BELOW_COMMITTED';
          error.details = { requested_microusd: requestedLimit, committed_microusd: committed };
          throw error;
        }
        delete value.max_cost_microusd;
        value.max_cost_usd = requestedLimit == null ? null : costLedger.fromMicrousd(requestedLimit);
      }
      value.allow_unknown_price = value.allow_unknown_price === true;
    }
    sets.push(`${column} = ?`); values.push(json(value));
  }
  if (!sets.length) return run;
  const timestamp = nowIso();
  sets.push('updated_at = ?', 'version = version + 1');
  values.push(timestamp, runId);
  db.prepare(`UPDATE production_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getRun(db, runId);
}

function updateRunControl(db, runId, patch, expectedVersion = null) {
  const tx = db.transaction(() => {
    const run = getRun(db, runId);
    if (!run) return null;
    if (expectedVersion != null && Number(expectedVersion) !== Number(run.version)) {
      const error = new Error('制作任务已在其他页面更新，请刷新后重试');
      error.code = 'VERSION_CONFLICT';
      throw error;
    }
    const nextOwner = Object.prototype.hasOwnProperty.call(patch, 'review_owner')
      ? graph.normalizeReviewOwner(patch.review_owner)
      : run.review_owner;
    const resolveIntervention = patch.resolve_intervention === true;
    const intervention = run.runtime?.autonomy?.intervention || null;
    const resumesAutonomy = Boolean(intervention)
      && nextOwner !== 'human'
      && (run.review_owner === 'human' || resolveIntervention);
    const { resolve_intervention: _controlOnly, ...persistedPatch } = patch;
    let nextPatch = { ...persistedPatch };
    if (resumesAutonomy) {
      const runtime = JSON.parse(JSON.stringify(run.runtime || {}));
      const autonomy = runtime.autonomy && typeof runtime.autonomy === 'object' ? runtime.autonomy : {};
      const objects = autonomy.objects && typeof autonomy.objects === 'object' ? { ...autonomy.objects } : {};
      if (intervention.object_key) delete objects[intervention.object_key];
      delete autonomy.intervention;
      runtime.autonomy = { ...autonomy, objects, updated_at: nowIso() };
      nextPatch = {
        ...nextPatch,
        runtime,
        status: 'running',
        waiting_reason: null,
        error_code: null,
        error_message: null,
      };
    }
    const updated = updateRun(db, runId, nextPatch, expectedVersion);
    if (run.review_owner !== updated.review_owner) {
      appendEvent(db, runId, 'run.review_owner_changed', {
        stage: updated.current_stage,
        scope_type: updated.current_scope_type,
        scope_id: updated.current_scope_id,
        payload: { from: run.review_owner, to: updated.review_owner },
      });
    }
    if (resumesAutonomy) {
      appendEvent(db, runId, 'automation.intervention_resolved', {
        stage: intervention.stage || updated.current_stage,
        scope_type: intervention.scope_type || updated.current_scope_type,
        scope_id: intervention.scope_id ?? updated.current_scope_id,
        payload: {
          object_key: intervention.object_key || null,
          reason: intervention.reason || null,
          resolved_by: resolveIntervention ? 'human_confirmed_resolution' : 'human_reenabled_autonomy',
          review_owner: updated.review_owner,
        },
      });
    }
    return updated;
  });
  return tx.immediate();
}

function createArtifact(db, input) {
  if (!graph.getStage(input.stage)) throw new Error(`未知阶段 ${input.stage}`);
  const run = getRun(db, input.run_id);
  if (!run) throw new Error('制作任务不存在');
  const scopeType = String(input.scope_type || graph.getStage(input.stage).scope || 'run');
  const scopeId = input.scope_id == null ? '' : String(input.scope_id);
  const status = input.status || 'draft';
  graph.assertEnum(status, graph.ARTIFACT_STATUSES, 'artifact.status');
  const parentId = input.parent_artifact_id == null ? null : Number(input.parent_artifact_id);
  const latest = db.prepare(
    `SELECT * FROM production_artifacts
     WHERE run_id = ? AND stage = ? AND scope_type = ? AND scope_id = ? AND deleted_at IS NULL
     ORDER BY revision DESC LIMIT 1`
  ).get(input.run_id, input.stage, scopeType, scopeId);
  const revision = input.revision == null ? Number(latest?.revision || 0) + 1 : Number(input.revision);
  const timestamp = nowIso();
  const content = input.content || {};
  const info = db.prepare(
    `INSERT INTO production_artifacts (
      run_id, stage, scope_type, scope_id, revision, status, title, content_json, media_path,
      mime_type, content_hash, parent_artifact_id, source_action_id, source_task_id,
      source_generation_id, source_merge_id, created_at, updated_at, approved_at, rejected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.run_id, input.stage, scopeType, scopeId, revision, status, input.title || null,
    json(content), input.media_path || null, input.mime_type || null, input.content_hash || hashJson(content),
    parentId || latest?.id || null, input.source_action_id || null, input.source_task_id || null,
    input.source_generation_id || null, input.source_merge_id || null, timestamp, timestamp,
    input.approved_at || (status === 'approved' ? timestamp : null),
    input.rejected_at || (status === 'rejected' ? timestamp : null)
  );
  const artifact = getArtifact(db, Number(info.lastInsertRowid));
  for (const dependencyId of input.depends_on || []) addDependency(db, artifact.id, dependencyId);
  appendEvent(db, input.run_id, 'artifact.created', {
    stage: input.stage, scope_type: scopeType, scope_id: scopeId,
    payload: { artifact_id: artifact.id, revision, status },
  });
  return artifact;
}

function getArtifact(db, artifactId) {
  return toArtifact(db.prepare(
    'SELECT * FROM production_artifacts WHERE id = ? AND deleted_at IS NULL'
  ).get(Number(artifactId)));
}

function listArtifacts(db, runId, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size) || 100));
  const clauses = ['run_id = ?', 'deleted_at IS NULL'];
  const params = [runId];
  if (query.stage) { clauses.push('stage = ?'); params.push(String(query.stage)); }
  if (query.scope_type) { clauses.push('scope_type = ?'); params.push(String(query.scope_type)); }
  if (query.scope_id != null) { clauses.push('scope_id = ?'); params.push(String(query.scope_id)); }
  if (query.status) { clauses.push('status = ?'); params.push(String(query.status)); }
  if (query.current === true || query.current === 'true' || query.current === 1 || query.current === '1') {
    clauses.push(`revision = (
      SELECT MAX(p2.revision) FROM production_artifacts p2
      WHERE p2.run_id = production_artifacts.run_id AND p2.stage = production_artifacts.stage
        AND p2.scope_type = production_artifacts.scope_type AND p2.scope_id = production_artifacts.scope_id
        AND p2.deleted_at IS NULL
    )`);
  }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM production_artifacts WHERE ${where}`).get(...params).n;
  const items = db.prepare(
    `SELECT * FROM production_artifacts WHERE ${where}
     ORDER BY stage, scope_type, scope_id, revision DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize).map(toArtifact);
  return { items, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } };
}

const PRODUCTION_MEDIA_STAGES = Object.freeze([
  'asset_images',
  'storyboard_images',
  'director_preview',
  'shot_video',
  'final_edit',
]);

function queryBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return String(value).trim().toLowerCase() === 'true';
}

function inferProductionMediaType(row) {
  const mime = String(row.mime_type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const cleanPath = String(row.media_path || '').split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|avif)$/.test(cleanPath)) return 'image';
  if (/\.(mp3|wav|m4a|aac|flac|ogg)$/.test(cleanPath)) return 'audio';
  return 'video';
}

function listProductionMedia(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.limit || query.page_size) || 30));
  const clauses = [
    'r.deleted_at IS NULL',
    'd.deleted_at IS NULL',
    'a.deleted_at IS NULL',
    "a.status = 'approved'",
    "a.media_path IS NOT NULL",
    "TRIM(a.media_path) <> ''",
  ];
  const params = [];
  const requestedStages = String(query.stage || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => PRODUCTION_MEDIA_STAGES.includes(value));
  const stages = requestedStages.length ? requestedStages : PRODUCTION_MEDIA_STAGES;
  clauses.push(`a.stage IN (${stages.map(() => '?').join(', ')})`);
  params.push(...stages);
  if (query.drama_id != null && query.drama_id !== '') {
    clauses.push('r.drama_id = ?');
    params.push(Number(query.drama_id));
  }
  if (query.run_id) {
    clauses.push('r.id = ?');
    params.push(String(query.run_id));
  }
  if (queryBoolean(query.current, true)) {
    clauses.push(`a.revision = (
      SELECT MAX(p2.revision) FROM production_artifacts p2
      WHERE p2.run_id = a.run_id AND p2.stage = a.stage
        AND p2.scope_type = a.scope_type AND p2.scope_id = a.scope_id
        AND p2.deleted_at IS NULL
    )`);
  }

  const rows = db.prepare(
    `SELECT a.*, r.drama_id AS source_drama_id, r.episode_id AS source_episode_id,
            r.input_json AS source_input_json, r.status AS source_run_status,
            r.current_stage AS source_current_stage, r.updated_at AS source_run_updated_at,
            r.completed_at AS source_run_completed_at,
            d.title AS source_drama_title,
            e.title AS source_episode_title, e.episode_number AS source_episode_number
       FROM production_artifacts a
       JOIN production_runs r ON r.id = a.run_id
       JOIN dramas d ON d.id = r.drama_id
       LEFT JOIN episodes e ON e.id = r.episode_id AND e.deleted_at IS NULL
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(a.approved_at, a.updated_at) DESC, a.updated_at DESC, a.id DESC`
  ).all(...params);

  const mediaType = query.media_type ? String(query.media_type).trim().toLowerCase() : null;
  const requestedKind = query.kind ? String(query.kind).trim().toLowerCase() : null;
  const search = String(query.q || query.keyword || '').trim().toLowerCase();
  const seenPaths = new Set();
  const mapped = [];
  for (const row of rows) {
    const content = parseJson(row.content_json, {});
    const kind = String(content.kind || '').trim().toLowerCase() || null;
    const rawDuration = Number(content?.validation?.duration ?? content?.duration);
    const inferredType = inferProductionMediaType(row);
    if (mediaType && mediaType !== 'all' && inferredType !== mediaType) continue;
    if (requestedKind && kind !== requestedKind) continue;
    const sourceInput = parseJson(row.source_input_json, {});
    const title = String(row.title || '');
    const haystack = [
      title, row.media_path, row.stage, row.scope_type, row.scope_id,
      row.source_drama_title, row.source_episode_title, sourceInput.story,
    ].filter(Boolean).join(' ').toLowerCase();
    if (search && !haystack.includes(search)) continue;
    const pathKey = String(row.media_path).replace(/\\/g, '/').toLowerCase();
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    mapped.push({
      artifact_id: Number(row.id),
      run_id: row.run_id,
      drama_id: Number(row.source_drama_id),
      drama_title: row.source_drama_title || '',
      episode_id: row.source_episode_id == null ? null : Number(row.source_episode_id),
      episode_title: row.source_episode_title || '',
      episode_number: row.source_episode_number == null ? null : Number(row.source_episode_number),
      stage: row.stage,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      revision: Number(row.revision),
      title,
      kind,
      media_path: row.media_path,
      content_hash: row.content_hash || null,
      mime_type: row.mime_type || null,
      media_type: inferredType,
      duration_seconds: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
      content,
      source_story: String(sourceInput.story || '').slice(0, 160),
      source_run_status: row.source_run_status,
      source_current_stage: row.source_current_stage,
      source_run_updated_at: row.source_run_updated_at,
      source_run_completed_at: row.source_run_completed_at,
      approved_at: row.approved_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  const latestPerDrama = queryBoolean(query.latest_per_drama, false);
  const itemsBeforePaging = latestPerDrama
    ? mapped.filter((item, index, all) => all.findIndex((entry) => entry.drama_id === item.drama_id) === index)
    : mapped;
  const total = itemsBeforePaging.length;
  const items = itemsBeforePaging.slice((page - 1) * pageSize, page * pageSize);
  return {
    items,
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
  };
}

function listReusableMedia(db, runId, query = {}) {
  const run = getRun(db, runId);
  if (!run) return null;
  return listProductionMedia(db, {
    ...query,
    drama_id: run.drama_id,
    page: query.page || 1,
    page_size: query.limit || query.page_size || 60,
    current: query.current == null ? true : query.current,
  });
}

function addDependency(db, artifactId, dependsOnId) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO production_artifact_dependencies
      (artifact_id, depends_on_artifact_id, created_at) VALUES (?, ?, ?)`
  ).run(Number(artifactId), Number(dependsOnId), timestamp);
}

function listUpstreamArtifactIds(db, artifactId) {
  return db.prepare(
    `SELECT depends_on_artifact_id
     FROM production_artifact_dependencies
     WHERE artifact_id = ?
     ORDER BY depends_on_artifact_id`
  ).all(Number(artifactId)).map((row) => Number(row.depends_on_artifact_id));
}

function listDownstreamArtifactIds(db, rootArtifactId) {
  return db.prepare(
    `WITH RECURSIVE downstream(id) AS (
       SELECT artifact_id FROM production_artifact_dependencies WHERE depends_on_artifact_id = ?
       UNION
       SELECT d.artifact_id FROM production_artifact_dependencies d JOIN downstream x ON d.depends_on_artifact_id = x.id
     ) SELECT DISTINCT id FROM downstream`
  ).all(Number(rootArtifactId)).map((row) => Number(row.id));
}

function invalidateDownstream(db, artifactId, reason = 'upstream_changed', options = {}) {
  const preservedIds = new Set(
    (options.preserve_artifact_ids || []).map(Number).filter(Number.isInteger)
  );
  const ids = listDownstreamArtifactIds(db, artifactId)
    .filter((id) => !preservedIds.has(id));
  if (!ids.length) return [];
  const timestamp = nowIso();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE production_artifacts SET status = 'invalidated', updated_at = ?
     WHERE id IN (${placeholders}) AND status NOT IN ('superseded', 'invalidated')`
  ).run(timestamp, ...ids);
  const root = getArtifact(db, artifactId);
  appendEvent(db, root.run_id, 'artifact.downstream_invalidated', {
    stage: root.stage, scope_type: root.scope_type, scope_id: root.scope_id,
    payload: {
      artifact_id: artifactId,
      affected_artifact_ids: ids,
      preserved_artifact_ids: [...preservedIds],
      reason,
    },
  });
  return ids;
}

function addReview(db, input) {
  graph.assertEnum(input.reviewer_type, graph.REVIEW_TYPES, 'reviewer_type');
  graph.assertEnum(input.decision, graph.REVIEW_DECISIONS, 'decision');
  const info = db.prepare(
    `INSERT INTO production_reviews (
      run_id, artifact_id, reviewer_type, decision, reason, criteria_version,
      confidence, scores_json, evidence_json, prompt_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.run_id, Number(input.artifact_id), input.reviewer_type, input.decision,
    input.reason || null, input.criteria_version || null,
    input.confidence == null ? null : Number(input.confidence), json(input.scores || {}),
    json(input.evidence || {}), input.prompt_snapshot || null, nowIso()
  );
  return toReview(db.prepare('SELECT * FROM production_reviews WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function reviewArtifact(db, artifactId, input) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new Error('产物不存在');
  const decision = input.decision;
  graph.assertEnum(decision, graph.REVIEW_DECISIONS, 'decision');
  if (decision !== 'approved' && !String(input.reason || '').trim()) {
    throw new Error('打回或转人工时必须填写原因');
  }
  const timestamp = nowIso();
  const tx = db.transaction(() => {
    const review = addReview(db, {
      run_id: artifact.run_id,
      artifact_id: artifact.id,
      reviewer_type: input.reviewer_type || 'human',
      decision,
      reason: input.reason,
      criteria_version: input.criteria_version,
      confidence: input.confidence,
      scores: input.scores,
      evidence: input.evidence,
      prompt_snapshot: input.prompt_snapshot,
    });
    if (decision === 'approved') {
      db.prepare(
        `UPDATE production_artifacts SET status = 'superseded', updated_at = ?
         WHERE run_id = ? AND stage = ? AND scope_type = ? AND scope_id = ?
           AND id <> ? AND status = 'approved' AND deleted_at IS NULL`
      ).run(timestamp, artifact.run_id, artifact.stage, artifact.scope_type, artifact.scope_id, artifact.id);
      db.prepare(
        `UPDATE production_artifacts SET status = 'approved', approved_at = ?, rejected_at = NULL, updated_at = ? WHERE id = ?`
      ).run(timestamp, timestamp, artifact.id);
      if (artifact.parent_artifact_id) {
        invalidateDownstream(db, artifact.parent_artifact_id, 'replacement_approved', {
          preserve_artifact_ids: [artifact.id],
        });
      }
    } else if (decision === 'rejected') {
      db.prepare(
        `UPDATE production_artifacts SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ?`
      ).run(timestamp, timestamp, artifact.id);
      invalidateDownstream(db, artifact.id, 'upstream_rejected');
    } else {
      db.prepare(`UPDATE production_artifacts SET status = 'reviewing', updated_at = ? WHERE id = ?`).run(timestamp, artifact.id);
    }
    updateRun(db, artifact.run_id, {
      status: decision === 'approved' ? 'waiting_review' : 'waiting_review',
      waiting_reason: decision === 'approved' ? 'stage_review' : (decision === 'rejected' ? 'revision_required' : 'human_review_required'),
    });
    appendEvent(db, artifact.run_id, 'artifact.reviewed', {
      stage: artifact.stage, scope_type: artifact.scope_type, scope_id: artifact.scope_id,
      payload: { artifact_id: artifact.id, review_id: review.id, decision },
    });
    return review;
  });
  const review = tx.immediate();
  return { artifact: getArtifact(db, artifactId), review };
}

function editArtifact(db, artifactId, input) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new Error('产物不存在');
  const content = input.content && typeof input.content === 'object'
    ? input.content
    : { ...artifact.content, value: input.value };
  const dependencies = Object.prototype.hasOwnProperty.call(input, 'depends_on')
    ? input.depends_on
    : listUpstreamArtifactIds(db, artifact.id);
  return createArtifact(db, {
    run_id: artifact.run_id,
    stage: artifact.stage,
    scope_type: artifact.scope_type,
    scope_id: artifact.scope_id,
    title: input.title === undefined ? artifact.title : input.title,
    content,
    media_path: input.media_path === undefined ? artifact.media_path : input.media_path,
    mime_type: input.mime_type === undefined ? artifact.mime_type : input.mime_type,
    parent_artifact_id: artifact.id,
    depends_on: dependencies || [],
  });
}

function queueArtifactRevision(db, artifactId, input = {}) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new Error('产物不存在');
  const reason = String(input.reason || '自动审核要求重新生成').trim();
  const timestamp = nowIso();
  db.prepare(
    `UPDATE production_artifacts
        SET status = 'rejected', rejected_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('draft', 'reviewing')`
  ).run(timestamp, timestamp, artifact.id);
  invalidateDownstream(db, artifact.id, input.invalidation_reason || 'automatic_revision_required');
  appendEvent(db, artifact.run_id, 'artifact.automatic_revision_queued', {
    stage: artifact.stage,
    scope_type: artifact.scope_type,
    scope_id: artifact.scope_id,
    payload: {
      artifact_id: artifact.id,
      source_decision: input.source_decision || null,
      reason,
    },
  });
  return getArtifact(db, artifact.id);
}

function excludeArtifact(db, artifactId, input = {}) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new Error('产物不存在');
  if (!['asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'].includes(artifact.stage)) {
    throw new Error('此产物不能在当前流程中排除');
  }
  const replacement = editArtifact(db, artifactId, {
    content: { ...artifact.content, included: false, exclusion_reason: String(input.reason || '用户选择不使用') },
  });
  return reviewArtifact(db, replacement.id, {
    reviewer_type: input.reviewer_type || 'human',
    decision: 'approved',
    reason: String(input.reason || '用户选择不使用此项'),
  });
}

function restoreArtifact(db, artifactId, input = {}) {
  const artifact = getArtifact(db, artifactId);
  if (!artifact) throw new Error('产物不存在');
  const replacement = editArtifact(db, artifactId, {
    content: { ...artifact.content, included: true, exclusion_reason: null },
  });
  appendEvent(db, artifact.run_id, 'artifact.restored', {
    stage: artifact.stage, scope_type: artifact.scope_type, scope_id: artifact.scope_id,
    payload: { artifact_id: replacement.id, reason: input.reason || null },
  });
  return replacement;
}

function listReviews(db, runId, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.page_size) || 50));
  const clauses = ['run_id = ?'];
  const params = [runId];
  if (query.artifact_id) { clauses.push('artifact_id = ?'); params.push(Number(query.artifact_id)); }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM production_reviews WHERE ${where}`).get(...params).n;
  const items = db.prepare(
    `SELECT * FROM production_reviews WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize).map(toReview);
  return { items, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } };
}

function listRejectedReviewEvidence(db, runId, stage, scopeType, scopeId) {
  return db.prepare(
    `SELECT r.*, a.stage AS artifact_stage, a.scope_type, a.scope_id,
            a.revision AS artifact_revision, a.title AS artifact_title
       FROM production_reviews r
       JOIN production_artifacts a ON a.id = r.artifact_id
      WHERE r.run_id = ? AND r.decision = 'rejected'
        AND a.stage = ? AND a.scope_type = ? AND a.scope_id = ?
        AND a.deleted_at IS NULL
      ORDER BY r.id ASC`
  ).all(runId, String(stage), String(scopeType), String(scopeId)).map((row) => ({
    ...toReview(row),
    artifact_stage: row.artifact_stage,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    artifact_revision: Number(row.artifact_revision),
    artifact_title: row.artifact_title,
  }));
}

function listEvents(db, runId, query = {}) {
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const before = query.before_id ? Number(query.before_id) : Number.MAX_SAFE_INTEGER;
  const rows = db.prepare(
    `SELECT * FROM production_events WHERE run_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
  ).all(runId, before, limit).map((row) => ({ ...row, payload: parseJson(row.payload_json), payload_json: undefined }));
  return { items: rows, next_before_id: rows.length === limit ? rows[rows.length - 1].id : null };
}

function stageCompletion(db, runId, stage) {
  const stageDefinition = graph.getStage(stage);
  if (!stageDefinition) throw new Error(`未知阶段 ${stage}`);
  const latest = listArtifacts(db, runId, { stage, current: true, page_size: 200 }).items;
  if (!latest.length) return { complete: false, unresolved: [{ reason: 'empty_stage', label: '此阶段还没有内容' }] };
  const unresolved = [];
  const sourceStageByDerivedStage = {
    asset_images: 'asset_text',
    storyboard_images: 'storyboard_plan',
    director_plan: 'storyboard_plan',
    director_preview: 'director_plan',
    reference_bundle: 'storyboard_plan',
    shot_video: 'storyboard_plan',
  };
  const sourceStage = sourceStageByDerivedStage[stage];
  if (sourceStage) {
    const expected = listArtifacts(db, runId, {
      stage: sourceStage, current: true, status: 'approved', page_size: 200,
    }).items.filter((artifact) => artifact.content?.included !== false);
    for (const source of expected) {
      const target = latest.find((artifact) => (
        artifact.scope_type === source.scope_type && artifact.scope_id === source.scope_id
      ));
      if (!target) {
        unresolved.push({
          source_artifact_id: source.id,
          scope_type: source.scope_type,
          scope_id: source.scope_id,
          reason: 'missing_derived_artifact',
          label: source.title,
        });
      }
    }
  }
  let staleFinalArtifactId = null;
  if (stage === 'final_edit') {
    const narrationArtifact = latest.find((artifact) => artifact.content?.kind === 'narration_plan') || null;
    const finalArtifact = latest.find((artifact) => (
      artifact.content?.included !== false && artifact.content?.kind !== 'narration_plan'
    )) || null;
    if (narrationArtifact) {
      const shotVideos = listArtifacts(db, runId, {
        stage: 'shot_video', current: true, status: 'approved', page_size: 200,
      }).items
        .filter((artifact) => artifact.content?.included !== false)
        .sort((left, right) => Number(left.scope_id) - Number(right.scope_id));
      const contract = createFinalEditContract(narrationArtifact, shotVideos);
      const finalMatches = finalVideoMatchesContract(finalArtifact, contract);
      if (finalArtifact && contract?.valid && !finalMatches) staleFinalArtifactId = finalArtifact.id;
      if (contract?.valid && narrationArtifact.status === 'approved' && !finalMatches) {
        unresolved.push({
          reason: finalArtifact ? 'final_video_outdated' : 'missing_final_video',
          label: finalArtifact ? '最终成片需要按最新旁白重新合成' : '最终剪辑成片',
          artifact_id: finalArtifact?.id || null,
          narration_plan_artifact_id: narrationArtifact.id,
        });
      }
      if (!contract?.valid && !finalArtifact) {
        unresolved.push({ reason: 'missing_final_video', label: '最终剪辑成片' });
      }
    } else if (!finalArtifact) {
      unresolved.push({ reason: 'missing_final_video', label: '最终剪辑成片' });
    }
  }
  for (const artifact of latest) {
    if (stage === 'final_edit' && artifact.id === staleFinalArtifactId) continue;
    const included = artifact.content?.included !== false;
    if (!included && artifact.status === 'approved') continue;
    if (artifact.status !== 'approved') {
      unresolved.push({ artifact_id: artifact.id, scope_type: artifact.scope_type, scope_id: artifact.scope_id, reason: artifact.status, label: artifact.title });
      continue;
    }
    if (artifact.content?.required_fields && Array.isArray(artifact.content.required_fields)) {
      for (const field of artifact.content.required_fields) {
        const value = artifact.content[field];
        if (value == null || String(value).trim() === '') {
          unresolved.push({ artifact_id: artifact.id, field, reason: 'required_field_empty', label: artifact.title });
        }
      }
    }
    const isFinalEditSettings = stage === 'final_edit' && artifact.content?.kind === 'narration_plan';
    if (stageDefinition.media && included && !isFinalEditSettings && !artifact.media_path) {
      unresolved.push({ artifact_id: artifact.id, reason: 'media_missing', label: artifact.title });
    }
  }
  return { complete: unresolved.length === 0, unresolved };
}

function runStageCompletion(db, run) {
  if (run.runtime?.shot_pipeline?.mode !== 'sequential' || run.current_scope_id == null) {
    return stageCompletion(db, run.id, run.current_stage);
  }
  const items = listArtifacts(db, run.id, {
    stage: run.current_stage,
    scope_type: 'shot',
    scope_id: String(run.current_scope_id),
    current: true,
    page_size: 20,
  }).items;
  if (!items.length) {
    return {
      complete: false,
      unresolved: [{
        scope_type: 'shot',
        scope_id: String(run.current_scope_id),
        reason: 'missing_scoped_artifact',
        label: `Shot ${run.current_scope_id}`,
      }],
    };
  }
  const unresolved = items
    .filter((artifact) => artifact.status !== 'approved')
    .map((artifact) => ({
      artifact_id: artifact.id,
      scope_type: artifact.scope_type,
      scope_id: artifact.scope_id,
      reason: artifact.status,
      label: artifact.title,
    }));
  if (!unresolved.length && run.current_stage === 'storyboard_plan') {
    const plans = listArtifacts(db, run.id, {
      stage: 'storyboard_plan', current: true, status: 'approved', page_size: 200,
    }).items.filter((artifact) => artifact.content?.included !== false).sort((left, right) => {
      const leftNumber = Number(left.content?.number);
      const rightNumber = Number(right.content?.number);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      return String(left.scope_id).localeCompare(String(right.scope_id), undefined, { numeric: true });
    });
    const currentIndex = plans.findIndex((artifact) => artifact.scope_id === String(run.current_scope_id));
    if (currentIndex > 0) {
      const previousVideos = listArtifacts(db, run.id, {
        stage: 'shot_video', current: true, status: 'approved', page_size: 200,
      }).items.filter((artifact) => artifact.content?.included !== false);
      const previousVideo = previousVideos.find((artifact) => artifact.scope_id === plans[currentIndex - 1].scope_id);
      if (!previousVideo || Number(items[0].content?.refined_from_video_artifact_id) !== Number(previousVideo.id)) {
        unresolved.push({
          artifact_id: items[0].id,
          scope_type: items[0].scope_type,
          scope_id: items[0].scope_id,
          reason: 'shot_plan_not_refined',
          label: items[0].title,
        });
      }
    }
  }
  return { complete: unresolved.length === 0, unresolved };
}

function transitionRun(db, runId, input) {
  const run = getRun(db, runId);
  if (!run) throw new Error('制作任务不存在');
  const completion = stageCompletion(db, runId, run.current_stage);
  if (!completion.complete) {
    const error = new Error('当前阶段仍有未处理内容');
    error.code = 'STAGE_INCOMPLETE';
    error.details = completion;
    throw error;
  }
  const next = graph.nextStage(run.current_stage);
  if (!next) {
    const completed = updateRun(db, runId, { status: 'completed', completed_at: nowIso(), waiting_reason: null });
    appendEvent(db, runId, 'run.completed', { stage: run.current_stage });
    return { run: completed, next_stage: null, completion };
  }
  const strategy = graph.normalizeNextStrategy(input.next_stage_strategy || (run.manual_next_default ? 'manual_add' : 'auto_generate'));
  const status = strategy === 'manual_add' ? 'waiting_review' : 'running';
  const updated = updateRun(db, runId, {
    current_stage: next.key,
    current_scope_type: null,
    current_scope_id: null,
    next_stage_strategy: strategy,
    status,
    waiting_reason: strategy === 'manual_add' ? 'manual_content_required' : null,
    error_code: null,
    error_message: null,
  }, input.expected_version);
  appendEvent(db, runId, 'run.transitioned', {
    stage: next.key,
    payload: { from: run.current_stage, to: next.key, strategy },
  });
  return { run: updated, next_stage: next, completion };
}

function claimLease(db, runId, owner, ttlMs = 30000) {
  if (!owner) throw new Error('lease owner 不能为空');
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + Math.max(5000, Math.min(120000, Number(ttlMs) || 30000))).toISOString();
  const tx = db.transaction(() => {
    const run = getRun(db, runId);
    if (!run) return { claimed: false, reason: 'not_found', run: null };
    if (run.lease_owner && run.lease_owner !== owner && run.lease_expires_at && run.lease_expires_at > timestamp) {
      return { claimed: false, reason: 'busy', run };
    }
    db.prepare(
      `UPDATE production_runs SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, version = version + 1 WHERE id = ?`
    ).run(owner, expiresAt, timestamp, runId);
    return { claimed: true, reason: null, run: getRun(db, runId) };
  });
  return tx.immediate();
}

function releaseLease(db, runId, owner) {
  const info = db.prepare(
    `UPDATE production_runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, version = version + 1
     WHERE id = ? AND lease_owner = ?`
  ).run(nowIso(), runId, owner);
  return info.changes > 0;
}

function reserveAction(db, input) {
  const run = getRun(db, input.run_id);
  if (!run) throw new Error('制作任务不存在');
  const existing = db.prepare(
    'SELECT * FROM production_actions WHERE run_id = ? AND action_key = ?'
  ).get(input.run_id, input.action_key);
  if (existing) return { action: toAction(existing), reused: true };
  const seconds = Math.max(0, Number(input.reserved_video_seconds) || 0);
  const isPaidVideo = seconds > 0 || input.kind === 'video_generate';
  const tx = db.transaction(() => {
    const current = getRun(db, input.run_id);
    const usage = { video_attempts_reserved: 0, video_seconds_reserved: 0, ...current.usage };
    const budget = current.budget || {};
    if (isPaidVideo) {
      const attemptsAfter = Number(usage.video_attempts_reserved || 0) + 1;
      const secondsAfter = Number(usage.video_seconds_reserved || 0) + seconds;
      if (attemptsAfter > Number(budget.max_video_attempts || 0)) {
        const error = new Error('视频提交次数将超过预算'); error.code = 'VIDEO_ATTEMPT_BUDGET'; throw error;
      }
      if (secondsAfter > Number(budget.max_video_seconds || 0)) {
        const error = new Error('视频生成总时长将超过预算'); error.code = 'VIDEO_SECONDS_BUDGET'; throw error;
      }
      usage.video_attempts_reserved = attemptsAfter;
      usage.video_seconds_reserved = secondsAfter;
      updateRun(db, input.run_id, { usage });
    }
    const timestamp = nowIso();
    const request = input.request || {};
    const info = db.prepare(
      `INSERT INTO production_actions (
        run_id, action_key, stage, scope_type, scope_id, kind, status, attempt,
        handler_version, request_json, request_hash, reserved_video_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.run_id, input.action_key, input.stage, input.scope_type || null,
      input.scope_id == null ? null : String(input.scope_id), input.kind,
      Number(input.attempt) || 1, Number(input.handler_version) || graph.HANDLER_VERSION,
      json(request), hashJson(request), seconds, timestamp, timestamp
    );
    const actionId = Number(info.lastInsertRowid);
    if (input.cost) {
      costLedger.reserve(db, {
        ...input.cost,
        run_id: input.run_id,
        action_id: actionId,
        idempotency_key: `production:${input.run_id}:${input.action_key}`,
      });
    }
    appendEvent(db, input.run_id, 'action.reserved', {
      stage: input.stage, scope_type: input.scope_type, scope_id: input.scope_id,
      payload: { action_id: actionId, action_key: input.action_key, kind: input.kind, reserved_video_seconds: seconds },
    });
    return toAction(db.prepare('SELECT * FROM production_actions WHERE id = ?').get(actionId));
  });
  try { return { action: tx.immediate(), reused: false }; }
  catch (error) {
    const raced = db.prepare('SELECT * FROM production_actions WHERE run_id = ? AND action_key = ?').get(input.run_id, input.action_key);
    if (raced) return { action: toAction(raced), reused: true };
    throw error;
  }
}

function updateAction(db, actionId, patch) {
  const row = db.prepare('SELECT * FROM production_actions WHERE id = ?').get(Number(actionId));
  if (!row) return null;
  const allowed = ['status', 'task_id', 'generation_id', 'merge_id', 'provider_id', 'error_code', 'error_message'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (key === 'status') graph.assertEnum(patch[key], graph.ACTION_STATUSES, 'action.status');
    sets.push(`${key} = ?`); values.push(patch[key]);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'result')) { sets.push('result_json = ?'); values.push(json(patch.result)); }
  if (!sets.length) return toAction(row);
  const timestamp = nowIso();
  sets.push('updated_at = ?'); values.push(timestamp);
  if (patch.status === 'completed') { sets.push('completed_at = ?'); values.push(timestamp); }
  values.push(Number(actionId));
  db.prepare(`UPDATE production_actions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  const nextStatus = patch.status || row.status;
  const costKey = `production:${row.run_id}:${row.action_key}`;
  if (patch.cost_status) {
    costLedger.transition(db, costKey, patch.cost_status, patch.cost || {});
  } else if (nextStatus === 'completed') {
    costLedger.transition(db, costKey, 'settled', patch.cost || {});
  } else if (nextStatus === 'ambiguous') {
    costLedger.transition(db, costKey, 'uncertain', patch.cost || {});
  } else if (nextStatus === 'failed') {
    const accepted = row.status === 'waiting' || row.task_id || row.generation_id || row.provider_id;
    costLedger.transition(db, costKey, accepted ? 'settled' : row.status === 'reserved' ? 'released' : 'uncertain', patch.cost || {});
  } else if (nextStatus === 'cancelled' && row.status === 'reserved') {
    costLedger.transition(db, costKey, 'released', patch.cost || {});
  }
  appendEvent(db, row.run_id, 'action.updated', {
    stage: row.stage, scope_type: row.scope_type, scope_id: row.scope_id,
    payload: { action_id: Number(actionId), status: nextStatus },
  });
  return toAction(db.prepare('SELECT * FROM production_actions WHERE id = ?').get(Number(actionId)));
}

function getActionByKey(db, runId, actionKey) {
  return toAction(db.prepare(
    'SELECT * FROM production_actions WHERE run_id = ? AND action_key = ?'
  ).get(runId, actionKey));
}

function getAction(db, actionId) {
  return toAction(db.prepare('SELECT * FROM production_actions WHERE id = ?').get(Number(actionId)));
}

function getLatestAction(db, runId, query = {}) {
  const clauses = ['run_id = ?'];
  const params = [runId];
  if (query.stage != null) { clauses.push('stage = ?'); params.push(String(query.stage)); }
  if (query.scope_type != null) { clauses.push('IFNULL(scope_type, \'\') = ?'); params.push(String(query.scope_type)); }
  if (query.scope_id != null) { clauses.push('IFNULL(scope_id, \'\') = ?'); params.push(String(query.scope_id)); }
  if (query.kind != null) { clauses.push('kind = ?'); params.push(String(query.kind)); }
  return toAction(db.prepare(
    `SELECT * FROM production_actions WHERE ${clauses.join(' AND ')} ORDER BY attempt DESC, id DESC LIMIT 1`
  ).get(...params));
}

function listActions(db, runId, query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size || query.limit) || 50));
  const total = db.prepare('SELECT COUNT(*) AS n FROM production_actions WHERE run_id = ?').get(runId).n;
  const rows = db.prepare(
    `SELECT * FROM production_actions WHERE run_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(runId, pageSize, (page - 1) * pageSize).map(toAction);
  return {
    items: rows,
    pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
  };
}

function nextActionAttempt(db, runId, stage, scopeType = null, scopeId = null, kind = null) {
  const clauses = ['run_id = ?', 'stage = ?'];
  const params = [runId, stage];
  if (scopeType != null) { clauses.push('IFNULL(scope_type, \'\') = ?'); params.push(String(scopeType)); }
  if (scopeId != null) { clauses.push('IFNULL(scope_id, \'\') = ?'); params.push(String(scopeId)); }
  if (kind != null) { clauses.push('kind = ?'); params.push(String(kind)); }
  const row = db.prepare(
    `SELECT COALESCE(MAX(attempt), 0) AS attempt FROM production_actions WHERE ${clauses.join(' AND ')}`
  ).get(...params);
  return Number(row?.attempt || 0) + 1;
}

function getRunSummary(db, runId) {
  const run = getRun(db, runId);
  if (!run) return null;
  const artifacts = listArtifacts(db, runId, { current: true, page_size: 200 }).items;
  const stageSummary = graph.STAGES.map((stage) => {
    const scoped = artifacts.filter((artifact) => artifact.stage === stage.key);
    const counts = scoped.reduce((acc, artifact) => {
      acc[artifact.status] = (acc[artifact.status] || 0) + 1;
      return acc;
    }, {});
    const completion = scoped.length ? stageCompletion(db, runId, stage.key) : { complete: false, unresolved: [] };
    return { ...stage, counts, total: scoped.length, complete: completion.complete, unresolved_count: completion.unresolved.length };
  });
  const providerKind = {
    asset_images: 'image_generate',
    storyboard_images: 'image_generate',
    shot_video: 'video_generate',
  }[run.current_stage];
  const latestProviderAction = providerKind && run.current_scope_id != null
    ? getLatestAction(db, run.id, {
      stage: run.current_stage,
      scope_type: run.current_scope_type,
      scope_id: run.current_scope_id,
      kind: providerKind,
    })
    : null;
  const currentAction = latestProviderAction
    && ['reserved', 'submitted', 'waiting', 'completed', 'failed', 'ambiguous'].includes(latestProviderAction.status)
    ? latestProviderAction
    : null;
  return {
    run,
    stages: stageSummary,
    artifacts,
    unresolved: runStageCompletion(db, run),
    current_action: currentAction,
    actions: listActions(db, runId, { page_size: 10 }).items,
  };
}

module.exports = {
  nowIso,
  parseJson,
  hashJson,
  toRun,
  toArtifact,
  createRun,
  getRun,
  listRuns,
  updateRun,
  updateRunControl,
  createArtifact,
  getArtifact,
  listArtifacts,
  listProductionMedia,
  listReusableMedia,
  addDependency,
  listUpstreamArtifactIds,
  listDownstreamArtifactIds,
  invalidateDownstream,
  addReview,
  reviewArtifact,
  editArtifact,
  queueArtifactRevision,
  excludeArtifact,
  restoreArtifact,
  listReviews,
  listRejectedReviewEvidence,
  appendEvent,
  listEvents,
  stageCompletion,
  runStageCompletion,
  transitionRun,
  claimLease,
  releaseLease,
  reserveAction,
  updateAction,
  getActionByKey,
  getAction,
  getLatestAction,
  listActions,
  nextActionAttempt,
  getRunSummary,
};
