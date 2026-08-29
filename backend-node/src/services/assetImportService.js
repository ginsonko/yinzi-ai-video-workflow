const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const repo = require('./productionRepository');
const graph = require('./productionGraph');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg, hasLocalFfprobe } = require('../utils/ffmpegPath');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SAMPLE_FRAMES = 3;
const MAX_SAMPLE_FRAME_BYTES = 2 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.docx', '.pdf']);
const EDITABLE_TYPES = new Set(['script', 'storyboard', 'character', 'scene', 'prop', 'asset_text', 'image', 'video', 'audio', 'director_preview', 'shot_video', 'final_edit', 'unknown']);
const EDITABLE_STAGES = new Set(['script', 'asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit']);
const EDITABLE_SCOPES = new Set(['run', 'resource', 'shot']);

function nowIso() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value == null ? {} : value); }
function parse(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; } }

function publicSession(session) {
  if (!session) return session;
  const options = { ...(session.options || {}) };
  // Staged upload paths are server-internal and must never be sent to a
  // browser. Keep only opaque tokens and display metadata so a resumed import
  // can continue without disclosing the host filesystem.
  if (options.staged_files && typeof options.staged_files === 'object') {
    options.staged_files = Object.fromEntries(Object.entries(options.staged_files).map(([token, value]) => [token, {
      relative_path: value.relative_path,
      file_name: value.file_name,
      bytes: value.bytes,
      mime_type: value.mime_type,
      uploaded_at: value.uploaded_at,
    }]));
  }
  delete options.staged_root;
  const safe = { ...session, options, plan: publicPlan(session.plan) };
  delete safe.options_json;
  delete safe.plan_json;
  delete safe.snapshot_json;
  return safe;
}

function publicPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  return { ...plan, items: Array.isArray(plan.items) ? plan.items.map(({ source_path: _sourcePath, ...item }) => item) : plan.items };
}

function publicItem(item) {
  if (!item) return item;
  const { source_path: _sourcePath, ...safe } = item;
  return safe;
}

function summarizePlanItems(items, targetRunId, previous = {}) {
  const rows = Array.isArray(items) ? items : [];
  const conflicts = [];
  const seenTargets = new Map();
  for (const item of rows) {
    if (item.status === 'excluded' || item.status === 'failed' || item.status === 'partial') continue;
    const stage = item.candidate_stage;
    if (!stage) continue;
    const key = `${stage}:${item.candidate_scope_type || ''}:${item.candidate_scope_id || ''}`;
    if (seenTargets.has(key)) {
      const existing = conflicts.find((entry) => entry.type === 'same_target_multiple_files' && entry.target === key);
      if (existing) existing.paths.push(item.relative_path);
      else conflicts.push({ type: 'same_target_multiple_files', target: key, paths: [seenTargets.get(key), item.relative_path] });
    } else seenTargets.set(key, item.relative_path);
  }
  return {
    ...previous,
    schema_version: Number(previous.schema_version || 1),
    generated_at: nowIso(),
    target_run_id: targetRunId,
    items: rows,
    conflicts,
    summary: {
      total: rows.length,
      ready: rows.filter((item) => item.status === 'ready' && item.candidate_stage).length,
      partial: rows.filter((item) => item.status === 'partial').length,
      failed: rows.filter((item) => item.status === 'failed').length,
      excluded: rows.filter((item) => item.status === 'excluded').length,
      unknown: rows.filter((item) => !item.candidate_stage && item.status !== 'excluded').length,
      total_bytes: rows.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    },
  };
}

function updatePlan(db, sessionId, input = {}) {
  const session = getSession(db, sessionId);
  if (!session) return null;
  if (['applied', 'rolled_back'].includes(session.status)) throw Object.assign(new Error('该导入会话已结束，不能修改计划'), { code: 'ASSET_IMPORT_SESSION_TERMINAL' });
  const expectedVersion = input.expected_version == null ? null : Number(input.expected_version);
  if (expectedVersion != null && (!Number.isInteger(expectedVersion) || expectedVersion !== Number(session.version))) {
    throw Object.assign(new Error(`导入计划已更新，请刷新后再编辑（当前版本 ${session.version}）`), { code: 'ASSET_IMPORT_PLAN_STALE' });
  }
  if (!Array.isArray(input.items) || !input.items.length) throw Object.assign(new Error('至少提供一个要修改的导入项'), { code: 'ASSET_IMPORT_ITEMS_REQUIRED' });
  const currentItems = listItems(db, sessionId);
  const byId = new Map(currentItems.map((item) => [String(item.id), item]));
  const byPath = new Map(currentItems.map((item) => [String(item.relative_path), item]));
  const nextItems = currentItems.map((item) => ({ ...item, evidence: item.evidence || {}, metadata: item.metadata || {} }));
  const changed = new Set();
  for (const patch of input.items) {
    const current = patch?.id != null ? byId.get(String(patch.id)) : byPath.get(String(patch?.relative_path || ''));
    if (!current) throw Object.assign(new Error('导入项不存在，可能已被重新扫描'), { code: 'ASSET_IMPORT_ITEM_NOT_FOUND' });
    const item = nextItems.find((candidate) => Number(candidate.id) === Number(current.id));
    if (patch.detected_type != null) {
      const detected = String(patch.detected_type).trim();
      if (!EDITABLE_TYPES.has(detected)) throw Object.assign(new Error(`不支持的识别类型：${detected}`), { code: 'ASSET_IMPORT_TYPE_INVALID' });
      item.detected_type = detected;
    }
    if (patch.candidate_stage !== undefined) {
      const stage = patch.candidate_stage == null || String(patch.candidate_stage).trim() === '' ? null : String(patch.candidate_stage).trim();
      if (stage && !EDITABLE_STAGES.has(stage)) throw Object.assign(new Error(`不支持的目标阶段：${stage}`), { code: 'ASSET_IMPORT_STAGE_INVALID' });
      item.candidate_stage = stage;
    }
    if (patch.candidate_scope_type !== undefined) {
      const scopeType = patch.candidate_scope_type == null || String(patch.candidate_scope_type).trim() === '' ? 'run' : String(patch.candidate_scope_type).trim();
      if (!EDITABLE_SCOPES.has(scopeType)) throw Object.assign(new Error(`不支持的作用域：${scopeType}`), { code: 'ASSET_IMPORT_SCOPE_INVALID' });
      item.candidate_scope_type = scopeType;
    }
    if (patch.candidate_scope_id !== undefined) item.candidate_scope_id = String(patch.candidate_scope_id ?? '').slice(0, 240);
    if (patch.include !== undefined) {
      if (typeof patch.include !== 'boolean') throw Object.assign(new Error('include 必须是布尔值'), { code: 'ASSET_IMPORT_INCLUDE_INVALID' });
      item.status = patch.include ? (item.error_code ? 'partial' : 'ready') : 'excluded';
      if (!patch.include) item.error_message = '用户在导入计划中排除';
      else if (item.error_message === '用户在导入计划中排除') item.error_message = null;
    }
    if (item.status !== 'excluded' && !item.candidate_stage && patch.include === true) item.status = 'ready';
    changed.add(Number(item.id));
  }
  if (!changed.size) throw Object.assign(new Error('没有有效的导入项修改'), { code: 'ASSET_IMPORT_NO_CHANGES' });
  const plan = summarizePlanItems(nextItems.map((item) => ({
    relative_path: item.relative_path, file_name: item.file_name, source_path: item.source_path,
    extension: item.extension, mime_type: item.mime_type, bytes: item.bytes, mtime: item.mtime,
    sha256: item.sha256, detected_type: item.detected_type, candidate_stage: item.candidate_stage,
    candidate_scope_type: item.candidate_scope_type, candidate_scope_id: item.candidate_scope_id,
    confidence: item.confidence, evidence: item.evidence, status: item.status,
    error_code: item.error_code, error_message: item.error_message, metadata: item.metadata,
  })), session.target_run_id, session.plan || {});
  plan.edit = { changed_item_ids: [...changed], reason: String(input.reason || '').trim().slice(0, 2000) || null, mode: 'user', created_at: nowIso() };
  const now = nowIso();
  const tx = db.transaction(() => {
    const update = db.prepare(`UPDATE asset_import_items SET detected_type = ?, candidate_stage = ?, candidate_scope_type = ?, candidate_scope_id = ?, status = ?, error_message = ?, updated_at = ? WHERE id = ? AND session_id = ?`);
    for (const item of nextItems.filter((candidate) => changed.has(Number(candidate.id)))) update.run(item.detected_type, item.candidate_stage, item.candidate_scope_type, item.candidate_scope_id, item.status, item.error_message, now, item.id, sessionId);
    db.prepare('UPDATE asset_import_sessions SET plan_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(json(plan), 'planned', now, sessionId);
  });
  tx.immediate();
  return { session: getPublicSession(db, sessionId), plan: publicPlan(plan), items: listItems(db, sessionId).map(publicItem), changed_item_ids: [...changed] };
}
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject); stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function mimeFor(ext) {
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.txt': 'text/plain',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[ext] || 'application/octet-stream';
}
function detectedType(ext, hint = '') {
  const value = String(hint || '').trim().toLowerCase();
  if (['script', 'story', 'screenplay'].includes(value)) return 'script';
  if (['storyboard', 'storyboard_plan', 'shot_script'].includes(value)) return 'storyboard';
  if (['character', 'scene', 'prop', 'asset_text'].includes(value)) return value === 'asset_text' ? 'asset_text' : value;
  if (['director_preview', 'shot_video', 'final_edit', 'audio'].includes(value)) return value;
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'unknown';
}
function candidateStage(type, hint = '') {
  const value = String(hint || '').trim();
  if (['script', 'storyboard_plan', 'asset_text', 'asset_images', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit'].includes(value)) return value;
  return ({ script: 'script', storyboard: 'storyboard_plan', character: 'asset_text', scene: 'asset_text', prop: 'asset_text', asset_text: 'asset_text', image: 'asset_images', video: 'shot_video', audio: 'final_edit' })[type] || null;
}
function candidateScope(stage, item) {
  if (stage === 'script' || stage === 'final_edit') return { type: 'run', id: '' };
  if (stage === 'asset_text' || stage === 'asset_images') return { type: 'resource', id: String(item.scope_id || item.file_name || item.relative_path) };
  if (stage === 'storyboard_plan' || stage === 'storyboard_images' || stage === 'director_preview' || stage === 'shot_video') return { type: 'shot', id: String(item.scope_id || item.file_name || item.relative_path) };
  return { type: 'run', id: '' };
}
function sanitizeRelative(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) throw Object.assign(new Error('relative_path 无效'), { code: 'ASSET_IMPORT_PATH_INVALID' });
  return normalized;
}
function extractDocxText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) return { unsupported_binary: true, text: null };
    const xml = entry.getData().toString('utf8');
    const text = xml
      .replace(/<w:tab\s*\/?>/gi, '\t')
      .replace(/<w:br\s*\/?>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return { truncated: text.length > MAX_TEXT_BYTES, text: text.slice(0, MAX_TEXT_BYTES) };
  } catch (_) { return { unsupported_binary: true, text: null }; }
}

function extractPdfText(filePath) {
  const candidates = process.platform === 'win32' ? ['pdftotext.exe', 'pdftotext'] : ['pdftotext'];
  for (const command of candidates) {
    try {
      const result = spawnSync(command, ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: MAX_TEXT_BYTES * 2 });
      if (result.status === 0 && result.stdout) return { truncated: result.stdout.length > MAX_TEXT_BYTES, text: result.stdout.slice(0, MAX_TEXT_BYTES) };
    } catch (_) {}
  }
  return { unsupported_binary: true, text: null };
}

function readText(filePath, ext, bytes) {
  if (!TEXT_EXT.has(ext) || bytes <= 0) return null;
  if (bytes > MAX_TEXT_BYTES) return { truncated: true, text: fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, MAX_TEXT_BYTES) };
  if (ext === '.docx') return extractDocxText(filePath);
  if (ext === '.pdf') return extractPdfText(filePath);
  return { truncated: false, text: fs.readFileSync(filePath, 'utf8') };
}

async function inspectImage(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    return { width: metadata.width || null, height: metadata.height || null, format: metadata.format || null, channels: metadata.channels || null, has_alpha: metadata.hasAlpha === true };
  } catch (_) { return { metadata_error: '无法读取图像尺寸或格式' }; }
}

function probeMedia(filePath, type) {
  if (!hasLocalFfprobe()) return Promise.resolve({ probe_available: false });
  return new Promise((resolve) => {
    const child = spawn(getFfprobePath(), ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', filePath], { windowsHide: true });
    let stdout = ''; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 100000) child.kill(); });
    child.on('error', () => finish({ probe_available: false }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ probe_available: true, probe_error: 'ffprobe exited non-zero' });
      try {
        const parsed = JSON.parse(stdout || '{}'); const stream = (parsed.streams || []).find((item) => type === 'video' ? item.width && item.height : item.codec_name);
        finish({ probe_available: true, duration_seconds: Number(parsed.format?.duration) || null, width: stream?.width || null, height: stream?.height || null, codec: stream?.codec_name || null });
      } catch (_) { finish({ probe_available: true, probe_error: 'ffprobe returned invalid JSON' }); }
    });
    setTimeout(() => { try { child.kill(); } catch (_) {} finish({ probe_available: true, probe_error: 'ffprobe timeout' }); }, 15000).unref();
  });
}

// Binary sample bytes are temporary classifier evidence. Persist only hashes,
// timestamps and sizes so plans remain portable and SQLite does not bloat.
function serializableMediaMetadata(metadata = {}) {
  const { frames, ...safe } = metadata || {};
  if (Array.isArray(frames)) {
    safe.sample_frames = frames.map((frame) => ({
      timestamp_seconds: frame.timestamp_seconds,
      bytes: frame.bytes,
      sha256: frame.sha256,
    }));
  }
  return safe;
}

function sampleVideoFrames(filePath, durationSeconds, options = {}) {
  if (!hasLocalFfmpeg() || !Number.isFinite(Number(durationSeconds)) || Number(durationSeconds) <= 0) {
    return Promise.resolve({ sample_available: false, sample_reason: hasLocalFfmpeg() ? 'duration_unavailable' : 'ffmpeg_unavailable' });
  }
  const duration = Number(durationSeconds);
  const requested = Math.max(1, Math.min(MAX_SAMPLE_FRAMES, Number(options.max_sample_frames) || 3));
  const timestamps = requested === 1 ? [Math.min(0.1, Math.max(0, duration - 0.05))]
    : Array.from({ length: requested }, (_, index) => Math.max(0, Math.min(duration - 0.05, duration * ((index + 1) / (requested + 1)))));
  const sampleOne = (timestamp) => new Promise((resolve) => {
    const child = spawn(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-ss', String(timestamp), '-i', filePath,
      '-frames:v', '1', '-vf', 'scale=640:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { windowsHide: true });
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_SAMPLE_FRAME_BYTES) chunks.push(chunk);
      else { try { child.kill(); } catch (_) {} finish(null); }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0 || !chunks.length) return finish(null);
      const buffer = Buffer.concat(chunks);
      finish({ timestamp_seconds: Number(timestamp.toFixed(3)), bytes: buffer.length, sha256: sha256Buffer(buffer), buffer });
    });
    setTimeout(() => { try { child.kill(); } catch (_) {} finish(null); }, 12000).unref();
  });
  return Promise.all(timestamps.map(sampleOne)).then((frames) => {
    const valid = frames.filter(Boolean);
    return {
      sample_available: valid.length > 0,
      sample_reason: valid.length ? null : 'ffmpeg_sample_failed',
      sample_frame_count: valid.length,
      sample_timestamps: valid.map((frame) => frame.timestamp_seconds),
      frames: valid,
    };
  });
}

async function inspectMediaWithEvidence(filePath, type, options = {}) {
  const probed = await probeMedia(filePath, type);
  if (type !== 'video' || !probed?.probe_available || !Number.isFinite(Number(probed.duration_seconds))) {
    return probed || {};
  }
  const sampled = await sampleVideoFrames(filePath, Number(probed.duration_seconds), options);
  return { ...probed, ...serializableMediaMetadata(sampled), frames: sampled?.frames || [] };
}

function parseClassifierJson(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch (_) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch (_) { return null; }
  }
}

function classifierPrompt(item) {
  return `你是影视制作资产整理助手。请只根据提供的文件信息判断它在“银子AI视频工作流”中的用途，不要臆造文件中没有的内容。\n文件名：${item.file_name || path.basename(item.relativePath || '')}\n扩展名：${item.extension || item.ext || ''}\n文本预览：${item.content?.text?.slice(0, 6000) || item.metadata?.text_preview || '无'}\n媒体元数据：${JSON.stringify(serializableMediaMetadata(item.mediaMetadata || {}))}\n\n请严格输出 JSON：{"detected_type":"script|storyboard|character|scene|prop|asset_text|image|video|audio|unknown","candidate_stage":"script|asset_text|asset_images|storyboard_plan|storyboard_images|director_preview|shot_video|final_edit|null","candidate_scope_type":"run|resource|shot","candidate_scope_id":"","confidence":0到1,"evidence":"一句可核对的判断依据"}。无法判断时使用 unknown 和 null，不要把扩展名本身当作充分证据。`;
}

function createConfiguredClassifier(db, log, options = {}) {
  const aiClient = (() => { try { return require('./aiClient'); } catch (_) { return null; } })();
  const configService = (() => { try { return require('./aiConfigService'); } catch (_) { return null; } })();
  if (!aiClient || !configService || !db) return null;
  const config = configService.getDefaultConfig(db, 'text');
  if (!config?.api_key || options.enabled === false) return null;
  const model = String(options.model || parse(config.settings)?.asset_import_classifier_model || config.default_model || 'gpt-5.6-sol').trim();
  return async ({ file }) => {
    const prompt = classifierPrompt(file);
    let result;
    if (IMAGE_EXT.has(file.ext || '') && file.sourcePath) {
      const bytes = fs.readFileSync(file.sourcePath);
      if (bytes.length <= MAX_SAMPLE_FRAME_BYTES) {
        const mime = mimeFor(file.ext || '.jpg');
        result = await aiClient.generateTextWithVision(db, log, 'text', prompt, '你负责对外部素材做可审计分类。只输出要求的 JSON。', { imageUrl: `data:${mime};base64,${bytes.toString('base64')}` }, { model, max_tokens: 800 });
      }
    } else if (file.mediaMetadata?.frames?.[0]?.buffer) {
      const frame = file.mediaMetadata.frames[0];
      result = await aiClient.generateTextWithVision(db, log, 'text', prompt, '你负责对外部素材做可审计分类。只输出要求的 JSON。', { imageUrl: `data:image/jpeg;base64,${frame.buffer.toString('base64')}` }, { model, max_tokens: 800 });
    } else {
      result = await aiClient.generateText(db, log, 'text', prompt, '你负责对外部素材做可审计分类。只输出要求的 JSON。', { model, json_mode: true, min_max_tokens: 800 });
    }
    const parsed = parseClassifierJson(result);
    if (!parsed) throw Object.assign(new Error('分类模型未返回有效 JSON'), { code: 'ASSET_IMPORT_CLASSIFY_INVALID' });
    const detected = EDITABLE_TYPES.has(String(parsed.detected_type || '').trim()) ? String(parsed.detected_type).trim() : 'unknown';
    const stage = parsed.candidate_stage == null || parsed.candidate_stage === '' ? null : (EDITABLE_STAGES.has(String(parsed.candidate_stage).trim()) ? String(parsed.candidate_stage).trim() : null);
    return {
      detected_type: detected,
      candidate_stage: stage,
      candidate_scope_type: EDITABLE_SCOPES.has(String(parsed.candidate_scope_type || '').trim()) ? String(parsed.candidate_scope_type).trim() : undefined,
      candidate_scope_id: parsed.candidate_scope_id == null ? undefined : String(parsed.candidate_scope_id).slice(0, 240),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      evidence: { source: 'multimodal_ai', model, reason: String(parsed.evidence || '').slice(0, 500) },
    };
  };
}

function getSession(db, id) {
  const row = db.prepare('SELECT * FROM asset_import_sessions WHERE id = ?').get(String(id));
  if (!row) return null;
  return { ...row, options: parse(row.options_json), plan: parse(row.plan_json), snapshot: parse(row.snapshot_json) };
}

/** Return a session with internal staged-file paths redacted for API clients. */
function getPublicSession(db, id) { return publicSession(getSession(db, id)); }
function listSessions(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1); const size = Math.min(100, Math.max(1, Number(query.page_size) || 20));
  const where = query.status ? 'WHERE status = ?' : ''; const args = query.status ? [String(query.status)] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM asset_import_sessions ${where}`).get(...args).n;
  const rows = db.prepare(`SELECT * FROM asset_import_sessions ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  return { items: rows.map((row) => publicSession({ ...row, options: parse(row.options_json), plan: parse(row.plan_json), snapshot: undefined })), pagination: { page, page_size: size, total, total_pages: Math.ceil(total / size) } };
}
function listItems(db, sessionId) {
  return db.prepare('SELECT * FROM asset_import_items WHERE session_id = ? ORDER BY id').all(String(sessionId)).map((row) => ({
    ...row, evidence: parse(row.evidence_json), metadata: parse(row.metadata_json),
  }));
}
function createSession(db, input = {}) {
  const id = String(input.id || crypto.randomUUID()); const now = nowIso();
  db.prepare(`INSERT INTO asset_import_sessions (id,status,source_label,target_run_id,options_json,plan_json,snapshot_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'draft', String(input.source_label || '').slice(0, 240), input.target_run_id || null, json(input.options || {}), '{}', '{}', 1, now, now);
  return getSession(db, id);
}

/**
 * Persist browser-uploaded files into a session-scoped staging directory.
 * Browser File objects do not expose readable absolute paths, so the scan API
 * accepts opaque source_token values returned here. Existing desktop callers
 * may continue sending an absolute source_path directly.
 */
function stageUploadedFiles(db, cfg, sessionId, files = [], relativePaths = []) {
  const session = getSession(db, sessionId); if (!session) return null;
  if (['applied', 'rolled_back'].includes(session.status)) throw Object.assign(new Error('该导入会话已结束，不能继续上传'), { code: 'ASSET_IMPORT_SESSION_TERMINAL' });
  if (!Array.isArray(files) || !files.length) throw Object.assign(new Error('请至少上传一个文件'), { code: 'ASSET_IMPORT_EMPTY' });
  const root = path.resolve(cfg?.storage?.local_path || './data/storage');
  const stagingRoot = path.resolve(root, 'imports', '.staging', String(sessionId));
  const rel = path.relative(root, stagingRoot);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('导入暂存目录无效'), { code: 'ASSET_IMPORT_PATH_INVALID' });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staged = { ...(session.options?.staged_files || {}) };
  const descriptors = [];
  files.forEach((file, index) => {
    if (!file || !file.path) throw Object.assign(new Error('上传文件暂存失败'), { code: 'ASSET_IMPORT_UPLOAD_INVALID' });
    const candidate = relativePaths[index] || file.originalname || file.filename || `file-${index + 1}`;
    const relativePath = sanitizeRelative(candidate);
    const token = crypto.randomUUID();
    const ext = path.extname(relativePath).toLowerCase();
    const target = path.resolve(stagingRoot, `${token}${ext}`);
    const targetRel = path.relative(stagingRoot, target);
    if (targetRel.startsWith('..') || path.isAbsolute(targetRel)) throw Object.assign(new Error('导入暂存路径无效'), { code: 'ASSET_IMPORT_PATH_INVALID' });
    // Multer diskStorage already wrote the file. Rename atomically when the
    // temporary path differs; copy fallback handles cross-volume temp dirs.
    if (path.resolve(file.path) !== target) {
      try { fs.renameSync(file.path, target); } catch (_) { fs.copyFileSync(file.path, target); try { fs.unlinkSync(file.path); } catch (_) {} }
    }
    const stat = fs.statSync(target);
    const sourceToken = token;
    staged[sourceToken] = { relative_path: relativePath, file_name: path.basename(relativePath), source_path: target, bytes: stat.size, mime_type: file.mimetype || mimeFor(ext), uploaded_at: nowIso() };
    descriptors.push({ relative_path: relativePath, file_name: path.basename(relativePath), source_token: sourceToken, bytes: stat.size, mime_type: staged[sourceToken].mime_type });
  });
  const options = { ...(session.options || {}), staged_files: staged, staged_root: stagingRoot };
  const now = nowIso();
  db.prepare('UPDATE asset_import_sessions SET options_json = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(json(options), now, sessionId);
  return { session: getPublicSession(db, sessionId), files: descriptors };
}

function resolveSource(item, session = {}) {
  const token = String(item.source_token || '').trim();
  if (token) {
    const staged = session.options?.staged_files?.[token];
    if (!staged?.source_path) throw Object.assign(new Error('导入项的上传暂存已失效，请重新选择文件'), { code: 'ASSET_IMPORT_SOURCE_MISSING' });
    const resolved = path.resolve(staged.source_path);
    const stagingRoot = session.options?.staged_root ? path.resolve(session.options.staged_root) : null;
    if (stagingRoot) {
      const relative = path.relative(stagingRoot, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('导入项暂存路径无效'), { code: 'ASSET_IMPORT_SOURCE_MISSING' });
    }
    if (!fs.existsSync(resolved)) throw Object.assign(new Error('导入项的上传暂存已清理，请重新上传'), { code: 'ASSET_IMPORT_SOURCE_MISSING' });
    return resolved;
  }
  const source = String(item.source_path || item.path || '').trim();
  if (!source || !path.isAbsolute(source)) throw Object.assign(new Error('导入项缺少可读的 source_path'), { code: 'ASSET_IMPORT_SOURCE_MISSING' });
  return path.resolve(source);
}
async function scanSession(db, sessionId, input = {}, adapters = {}, log = console) {
  const session = getSession(db, sessionId); if (!session) return null;
  if (['applied', 'rolled_back'].includes(session.status)) throw Object.assign(new Error('该导入会话已结束，不能重新扫描'), { code: 'ASSET_IMPORT_SESSION_TERMINAL' });
  const rawItems = Array.isArray(input.files) ? input.files : [];
  if (!rawItems.length) throw Object.assign(new Error('请至少选择一个文件'), { code: 'ASSET_IMPORT_EMPTY' });
  if (rawItems.length > MAX_FILES) throw Object.assign(new Error(`文件数量超过上限 ${MAX_FILES}`), { code: 'ASSET_IMPORT_LIMIT' });
  const options = { ...session.options, ...(input.options || {}) };
  const rows = []; let totalBytes = 0;
  for (const raw of rawItems) {
    const relativePath = sanitizeRelative(raw.relative_path || raw.relativePath || raw.name || path.basename(String(raw.source_path || raw.path || '')));
    let sourcePath; let stat; let hash = null; let content = null; let status = 'ready'; let errorCode = null; let errorMessage = null; let mediaMetadata = {};
    try { sourcePath = resolveSource(raw, session); stat = fs.statSync(sourcePath); if (!stat.isFile()) throw new Error('不是普通文件'); }
    catch (error) { rows.push({ relativePath, raw, status: 'failed', errorCode: error.code || 'ASSET_IMPORT_SOURCE_UNREADABLE', errorMessage: error.message }); continue; }
    totalBytes += stat.size; const ext = path.extname(relativePath).toLowerCase(); const type = detectedType(ext, raw.detected_type || raw.type);
    if (totalBytes > MAX_TOTAL_BYTES || stat.size > Number(options.max_file_bytes || MAX_TOTAL_BYTES)) { status = 'partial'; errorCode = 'ASSET_IMPORT_LIMIT'; errorMessage = '超过导入大小上限'; }
    try {
      hash = await sha256File(sourcePath);
      content = status === 'ready' ? readText(sourcePath, ext, stat.size) : null;
      if (status === 'ready' && IMAGE_EXT.has(ext)) mediaMetadata = await inspectImage(sourcePath);
      if (status === 'ready' && (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext))) {
        mediaMetadata = await inspectMediaWithEvidence(sourcePath, VIDEO_EXT.has(ext) ? 'video' : 'audio', options);
      }
    }
    catch (error) { status = 'failed'; errorCode = 'ASSET_IMPORT_READ_FAILED'; errorMessage = error.message; }
    rows.push({ relativePath, raw, sourcePath, stat, ext, type, status, errorCode, errorMessage, hash, content, mediaMetadata });
  }
  if (totalBytes > MAX_TOTAL_BYTES) log.warn?.('asset import total size exceeded', { session_id: sessionId, total_bytes: totalBytes });
  // A stored default key must not trigger an unexpected billable request.
  // Configured classification is enabled only by an explicit scan/session
  // option; injected classifiers remain available for tests and integrations.
  const classifierEnabled = input.classifier_enabled === true
    || options.classifier_enabled === true
    || options.classifier_mode === 'ai';
  const classify = adapters.classify || (classifierEnabled ? createConfiguredClassifier(db, log, {
    enabled: true,
    model: options.classifier_model,
  }) : null);
  const classified = [];
  for (const item of rows) {
    let ai = null;
    if (item.status === 'ready' && typeof classify === 'function') {
      try { ai = await classify({ file: item, session }); } catch (error) { item.status = 'partial'; item.errorCode = 'ASSET_IMPORT_CLASSIFY_FAILED'; item.errorMessage = error.message; }
    }
    const type = ai?.detected_type || item.raw.detected_type || item.type;
    const stage = ai?.candidate_stage || candidateStage(type, item.raw.candidate_stage);
    const inferredScope = candidateScope(stage, { ...item.raw, file_name: path.basename(item.relativePath) });
    const scope = {
      type: EDITABLE_SCOPES.has(String(ai?.candidate_scope_type || '')) ? String(ai.candidate_scope_type) : inferredScope.type,
      id: ai?.candidate_scope_id == null ? inferredScope.id : String(ai.candidate_scope_id).slice(0, 240),
    };
    classified.push({ ...item, type, stage, scope, confidence: ai?.confidence == null ? (stage ? 0.72 : 0.2) : Number(ai.confidence), evidence: ai?.evidence || { source: 'local_rules', rule: 'extension_and_metadata', detected_type: type }, ai });
  }
  const duplicates = new Map(); classified.forEach((item) => { if (item.hash) duplicates.set(item.hash, [...(duplicates.get(item.hash) || []), item.relativePath]); });
  const planItems = classified.map((item) => ({ relative_path: item.relativePath, file_name: path.basename(item.relativePath), source_path: item.sourcePath || null, extension: item.ext || path.extname(item.relativePath).toLowerCase(), mime_type: mimeFor(item.ext || path.extname(item.relativePath).toLowerCase()), bytes: item.stat?.size || 0, mtime: item.stat?.mtime?.toISOString() || null, sha256: item.hash, detected_type: item.type, candidate_stage: item.stage, candidate_scope_type: item.scope.type, candidate_scope_id: item.scope.id, confidence: item.confidence, evidence: item.evidence, status: item.status, error_code: item.errorCode, error_message: item.errorMessage, metadata: { text_preview: item.content?.text?.slice(0, 4000) || null, text_content: item.stage === 'script' ? item.content?.text?.slice(0, MAX_TEXT_BYTES) || null : null, truncated: item.content?.truncated || false, duplicate_paths: item.hash ? duplicates.get(item.hash) : [], ...serializableMediaMetadata(item.mediaMetadata || {}) } }));
  const conflicts = []; const seenTargets = new Map();
  for (const item of planItems) { const key = `${item.candidate_stage || 'unknown'}:${item.candidate_scope_type || ''}:${item.candidate_scope_id || ''}`; if (item.candidate_stage && seenTargets.has(key)) conflicts.push({ type: 'same_target_multiple_files', target: key, paths: [seenTargets.get(key), item.relative_path] }); else if (item.candidate_stage) seenTargets.set(key, item.relative_path); }
  const plan = { schema_version: 1, generated_at: nowIso(), target_run_id: session.target_run_id, items: planItems, conflicts, summary: { total: planItems.length, ready: planItems.filter((x) => x.status === 'ready').length, partial: planItems.filter((x) => x.status === 'partial').length, failed: planItems.filter((x) => x.status === 'failed').length, unknown: planItems.filter((x) => !x.candidate_stage).length, total_bytes: totalBytes }, ai: { requested: classifierEnabled, used: typeof classify === 'function', model: options.classifier_model || 'gpt-5.6-sol', source: typeof classify === 'function' ? 'configured_or_injected' : 'local_rules' } };
  const now = nowIso(); const tx = db.transaction(() => {
    db.prepare('DELETE FROM asset_import_items WHERE session_id = ?').run(String(sessionId));
    const insert = db.prepare(`INSERT INTO asset_import_items (session_id,relative_path,source_path,file_name,extension,mime_type,bytes,mtime,sha256,detected_type,candidate_stage,candidate_scope_type,candidate_scope_id,confidence,evidence_json,status,error_code,error_message,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of plan.items) insert.run(sessionId, item.relative_path, item.source_path, item.file_name, item.extension, item.mime_type, item.bytes, item.mtime, item.sha256, item.detected_type, item.candidate_stage, item.candidate_scope_type, item.candidate_scope_id, item.confidence, json(item.evidence), item.status, item.error_code, item.error_message, json(item.metadata), now, now);
    db.prepare('UPDATE asset_import_sessions SET status = ?, options_json = ?, plan_json = ?, error_code = NULL, error_message = NULL, version = version + 1, updated_at = ? WHERE id = ?').run('planned', json(options), json(plan), now, sessionId);
  }); tx.immediate();
  return { session: getPublicSession(db, sessionId), items: listItems(db, sessionId).map(publicItem), plan: publicPlan(plan) };
}

async function reorganizeSession(db, sessionId, input = {}, adapters = {}, log = console) {
  const session = getSession(db, sessionId); if (!session) return null;
  if (['applied', 'rolled_back'].includes(session.status)) throw Object.assign(new Error('该导入会话已结束，不能重新整理'), { code: 'ASSET_IMPORT_SESSION_TERMINAL' });
  const current = session.plan || {};
  const instruction = String(input.instruction || input.reason || '').trim();
  if (!instruction) throw Object.assign(new Error('请说明希望如何整理导入计划'), { code: 'ASSET_IMPORT_REORGANIZE_REASON_REQUIRED' });
  const classify = adapters.reorganize || adapters.classify;
  if (typeof classify !== 'function') {
    // Keep a durable, auditable revision even when no text model is configured.
    const next = { ...current, reorganize: { instruction: instruction.slice(0, 2000), mode: 'deferred', created_at: nowIso() } };
    const now = nowIso(); db.prepare('UPDATE asset_import_sessions SET plan_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(json(next), 'planned', now, sessionId);
    return { session: getPublicSession(db, sessionId), plan: publicPlan(next), deferred: true };
  }
  const revised = await classify({ session, plan: current, instruction });
  if (!revised || typeof revised !== 'object') throw Object.assign(new Error('AI 未返回有效的导入整理计划'), { code: 'ASSET_IMPORT_REORGANIZE_INVALID' });
  const next = { ...current, ...revised, reorganize: { instruction: instruction.slice(0, 2000), mode: 'ai', created_at: nowIso() } };
  const now = nowIso(); db.prepare('UPDATE asset_import_sessions SET plan_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?').run(json(next), 'planned', now, sessionId);
  return { session: getPublicSession(db, sessionId), plan: publicPlan(next), deferred: false };
}
function copyIntoStorage(cfg, sessionId, item) {
  const root = path.resolve(cfg?.storage?.local_path || './data/storage'); const source = path.resolve(item.source_path); const ext = path.extname(item.relative_path).toLowerCase() || '.bin';
  const rel = `imports/${sessionId}/${item.sha256 || sha256Buffer(Buffer.from(item.relative_path))}${ext}`; const target = path.resolve(root, rel);
  const relative = path.relative(root, target); if (relative.startsWith('..') || path.isAbsolute(relative)) throw Object.assign(new Error('导入目标路径无效'), { code: 'ASSET_IMPORT_PATH_INVALID' });
  fs.mkdirSync(path.dirname(target), { recursive: true }); if (!fs.existsSync(target)) fs.copyFileSync(source, target); return rel.replace(/\\/g, '/');
}

function cleanupStaging(cfg, session) {
  const stagingRoot = session?.options?.staged_root;
  if (!stagingRoot) return false;
  const root = path.resolve(cfg?.storage?.local_path || './data/storage');
  const target = path.resolve(stagingRoot);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  // Staging is always beneath imports/.staging/{session}; never follow a
  // caller-provided path outside the configured storage root.
  if (!relative.replace(/\\/g, '/').startsWith('imports/.staging/')) return false;
  try { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); return true; } catch (_) { return false; }
}

/**
 * Remove only expired browser-upload staging directories. Confirmed imports
 * under imports/{sessionId} are outside this function's scope.
 */
function cleanupExpiredStaging(db, cfg = {}, log = console, nowMs = Date.now()) {
  const configuredTtl = Number(cfg?.asset_import?.staging_ttl_hours || 24);
  const rows = db.prepare(`SELECT id,status,updated_at,options_json FROM asset_import_sessions
    WHERE status NOT IN ('applied','rolled_back')`).all();
  let cleaned = 0; let skipped = 0;
  for (const row of rows) {
    const options = parse(row.options_json);
    if (!options?.staged_root) continue;
    const updatedMs = Date.parse(row.updated_at || '') || 0;
    const ttlHours = Math.max(1, Number(options.staging_ttl_hours || configuredTtl) || 24);
    if (!updatedMs || nowMs - updatedMs < ttlHours * 3600000) { skipped++; continue; }
    if (!cleanupStaging(cfg, { id: row.id, status: row.status, options })) {
      log.warn?.('asset import staging cleanup skipped', { session_id: row.id, reason: 'outside_controlled_staging_root_or_remove_failed' });
      continue;
    }
    const nextOptions = { ...options, staged_files: {}, staging_expired_at: nowIso(), classifier_enabled: false };
    delete nextOptions.staged_root;
    db.prepare(`UPDATE asset_import_sessions
      SET options_json = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`)
      .run(json(nextOptions), 'ASSET_IMPORT_STAGING_EXPIRED', '上传暂存已过期，请重新上传文件后再扫描', nowIso(), row.id);
    cleaned++;
  }
  return { cleaned, skipped };
}
function applySession(db, cfg, sessionId, input = {}) {
  const session = getSession(db, sessionId); if (!session) return null;
  if (session.status === 'applied') return { session, reused: true, artifacts: session.snapshot?.artifact_ids || [] };
  if (session.status !== 'planned') throw Object.assign(new Error('请先生成并审核导入计划'), { code: 'ASSET_IMPORT_PLAN_REQUIRED' });
  if (input.confirm !== true) throw Object.assign(new Error('导入前需要明确确认计划；请传入 confirm=true'), { code: 'ASSET_IMPORT_CONFIRM_REQUIRED' });
  if (!session.target_run_id) throw Object.assign(new Error('导入计划缺少 target_run_id'), { code: 'ASSET_IMPORT_TARGET_REQUIRED' });
  const run = repo.getRun(db, session.target_run_id); if (!run) throw Object.assign(new Error('目标制作任务不存在'), { code: 'ASSET_IMPORT_TARGET_NOT_FOUND' });
  const items = listItems(db, sessionId); const artifactIds = []; const copied = []; const now = nowIso();
  const tx = db.transaction(() => {
    for (const item of items) {
      if (item.status !== 'ready' || !item.candidate_stage) continue;
      const stage = item.candidate_stage; let mediaPath = null;
      if (['asset_images', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit'].includes(stage)) { mediaPath = copyIntoStorage(cfg, sessionId, item); copied.push(mediaPath); }
      const content = { imported: true, import_session_id: sessionId, source_relative_path: item.relative_path, sha256: item.sha256, detected_type: item.detected_type, included: true, ...(item.metadata?.text_content || item.metadata?.text_preview ? { text: item.metadata.text_content || item.metadata.text_preview } : {}) };
      const artifact = repo.createArtifact(db, { run_id: run.id, stage, scope_type: item.candidate_scope_type || 'run', scope_id: item.candidate_scope_id || '', title: item.file_name, content, media_path: mediaPath, mime_type: item.mime_type, content_hash: item.sha256 || undefined, status: 'approved' });
      repo.addReview(db, {
        run_id: run.id,
        artifact_id: artifact.id,
        reviewer_type: 'human',
        decision: 'approved',
        reason: '用户确认导入计划并纳入制作任务',
      });
      artifactIds.push(artifact.id); db.prepare('UPDATE asset_import_items SET status = ?, updated_at = ? WHERE id = ?').run('applied', now, item.id);
    }
    const snapshot = { artifact_ids: artifactIds, copied_paths: copied, applied_at: now, target_run_id: run.id };
    db.prepare('UPDATE asset_import_sessions SET status = ?, snapshot_json = ?, applied_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run('applied', json(snapshot), now, now, sessionId);
    repo.appendEvent(db, run.id, 'asset_import.applied', { payload: { session_id: sessionId, artifact_ids: artifactIds } });
    const importedStages = items.filter((item) => item.status === 'ready' && item.candidate_stage)
      .map((item) => item.candidate_stage).filter((stage) => graph.stageIndex(stage) >= 0);
    const currentIndex = graph.stageIndex(run.current_stage);
    const firstImported = importedStages.sort((a, b) => graph.stageIndex(a) - graph.stageIndex(b))[0];
    // A newly created run can continue directly from an imported script. Do
    // not rewind an in-progress run or silently change a later user decision.
    const canPosition = firstImported === 'script'
      || (firstImported === 'asset_text' && repo.listArtifacts(db, run.id, { stage: 'script', current: true, status: 'approved', page_size: 10 }).items.length > 0);
    if (firstImported && canPosition && currentIndex === graph.stageIndex('story_input') && graph.stageIndex(firstImported) > currentIndex) {
      repo.updateRun(db, run.id, {
        current_stage: firstImported,
        current_scope_type: firstImported === 'asset_text' || firstImported === 'asset_images' ? 'resource' : null,
        current_scope_id: null,
        status: 'running',
        waiting_reason: null,
      });
      repo.appendEvent(db, run.id, 'asset_import.workflow_positioned', {
        stage: firstImported,
        payload: { session_id: sessionId, imported_stages: importedStages },
      });
    }
  }); tx.immediate();
  cleanupStaging(cfg, session);
  return { session: getSession(db, sessionId), reused: false, artifacts: artifactIds, copied_paths: copied };
}
function rollbackSession(db, cfg, sessionId) {
  const session = getSession(db, sessionId); if (!session) return null;
  if (session.status === 'rolled_back') return { session, reused: true };
  if (session.status !== 'applied') throw Object.assign(new Error('只有已应用的导入会话可以回滚'), { code: 'ASSET_IMPORT_NOT_APPLIED' });
  const snapshot = session.snapshot || {}; const now = nowIso();
  const tx = db.transaction(() => {
    for (const id of snapshot.artifact_ids || []) db.prepare('UPDATE production_artifacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND run_id = ?').run(now, now, id, session.target_run_id);
    for (const rel of snapshot.copied_paths || []) { const root = path.resolve(cfg?.storage?.local_path || './data/storage'); const file = path.resolve(root, rel); const relative = path.relative(root, file); if (!relative.startsWith('..') && !path.isAbsolute(relative)) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} } }
    db.prepare('UPDATE asset_import_sessions SET status = ?, rolled_back_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run('rolled_back', now, now, sessionId);
  }); tx.immediate();
  cleanupStaging(cfg, session);
  return { session: getSession(db, sessionId), rolled_back_artifacts: snapshot.artifact_ids || [] };
}
module.exports = {
  createSession, getSession, getPublicSession, publicPlan, publicItem, listSessions, listItems,
  stageUploadedFiles, scanSession, reorganizeSession, updatePlan, applySession, rollbackSession,
  cleanupExpiredStaging, serializableMediaMetadata, sampleVideoFrames, createConfiguredClassifier,
  MAX_FILES, MAX_TOTAL_BYTES,
};
