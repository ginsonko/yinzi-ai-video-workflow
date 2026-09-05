const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync: defaultSpawnSync } = require('node:child_process');
const { normalizeDirectorDocument } = require('./productionDirector');

const SCHEMA = 'yinzi.blender-director/v1';
const CAPABILITY_SCHEMA = 'yinzi.blender-capability/v1';
const SMOKE_PLAN_SCHEMA = 'yinzi.blender-smoke-plan/v1';
const SMOKE_SCRIPT_RELATIVE = path.join('runtime', 'blender', 'smoke_scene.py').replace(/\\/g, '/');
const PROBE_TIMEOUT_MS = 2500;
const MAX_OUTPUT_BYTES = 64 * 1024;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const PROFILES = Object.freeze({
  smoke: Object.freeze({
    id: 'smoke',
    label: 'S1 最小烟测',
    engine: 'BLENDER_EEVEE_NEXT',
    frames: [1, 2, 3],
    resolution: { width: 320, height: 180, percentage: 100 },
    fps: 24,
    samples: 8,
  }),
});

function nowIso() { return new Date().toISOString(); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function safeText(value, fallback = '', limit = 200) {
  const text = String(value == null ? fallback : value).trim();
  return text.slice(0, limit);
}

function storageRoot(cfg) {
  const configured = cfg?.storage?.local_path || './data/storage';
  return path.resolve(path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured));
}

function candidateExecutables(cfg, options = {}) {
  const values = [];
  if (Array.isArray(options.candidates)) {
    return [...new Set(options.candidates.map((value) => safeText(value, '', 1024)).filter(Boolean))];
  } else {
    if (options.executable) values.push(options.executable);
    if (process.env.BLENDER_PATH) values.push(process.env.BLENDER_PATH);
    if (cfg?.director?.blender?.executable) values.push(cfg.director.blender.executable);
    values.push('blender');
  }
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const version of ['4.5', '4.4', '4.3', '4.2']) {
      values.push(path.join(programFiles, 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
      values.push(path.join(localAppData, 'Programs', 'Blender Foundation', `Blender ${version}`, 'blender.exe'));
    }
  } else {
    values.push('/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender');
  }
  return [...new Set(values.map((value) => safeText(value, '', 1024)).filter(Boolean))];
}

function parseVersion(output) {
  const firstLine = String(output || '').split(/\r?\n/).find((line) => line.trim()) || '';
  const match = firstLine.match(/\bBlender\s+(\d+\.\d+(?:\.\d+)?)/i);
  if (!match) return { version: null, raw: safeText(firstLine, '', 240) };
  return { version: match[1], raw: safeText(firstLine, '', 240) };
}

function publicExecutable(value) {
  const raw = String(value || '');
  return {
    name: path.basename(raw) || raw,
    kind: path.isAbsolute(raw) ? 'path' : 'command',
  };
}

function probeOne(executable, options = {}) {
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const timeoutMs = Math.max(100, Math.min(10000, Number(options.timeoutMs) || PROBE_TIMEOUT_MS));
  const started = Date.now();
  let result;
  try {
    result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    }) || {};
  } catch (error) {
    return { ok: false, error_code: 'BLENDER_PROBE_EXCEPTION', error_message: error.message, elapsed_ms: Date.now() - started };
  }
  const elapsed = Date.now() - started;
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM' || result.signal === 'SIGKILL';
  if (timedOut) return { ok: false, error_code: 'BLENDER_PROBE_TIMEOUT', error_message: 'Blender 版本探测超时', elapsed_ms: elapsed };
  if (result.error) return { ok: false, error_code: 'BLENDER_NOT_FOUND', error_message: result.error.message, elapsed_ms: elapsed };
  if (result.status !== 0) {
    return {
      ok: false,
      error_code: 'BLENDER_PROBE_FAILED',
      error_message: safeText(result.stderr || result.stdout, 'Blender 版本探测失败', 500),
      exit_code: result.status,
      elapsed_ms: elapsed,
    };
  }
  const parsed = parseVersion(result.stdout || result.stderr);
  return {
    ok: true,
    version: parsed.version,
    version_known: Boolean(parsed.version),
    raw: parsed.raw,
    exit_code: result.status,
    elapsed_ms: elapsed,
  };
}

function detectBlender(cfg, options = {}) {
  const checkedAt = (options.now || nowIso)();
  const candidates = candidateExecutables(cfg, options);
  const attempts = [];
  for (const executable of candidates) {
    const probe = probeOne(executable, options);
    attempts.push({ executable: publicExecutable(executable), ...probe });
    if (probe.ok) {
      return {
        schema: CAPABILITY_SCHEMA,
        checked_at: checkedAt,
        status: probe.version_known ? 'ready' : 'degraded',
        available: true,
        version_known: probe.version_known,
        version: probe.version,
        executable: publicExecutable(executable),
        renderers: {
          candidates: ['BLENDER_EEVEE_NEXT', 'CYCLES'],
          verified: false,
          note: '版本探测不会替代实际渲染烟测',
        },
        operations: {
          background_python: true,
          frame_render: true,
          gltf_export: 'unverified',
          video_encode: 'external_ffmpeg_or_blender_unverified',
        },
        probe: { elapsed_ms: probe.elapsed_ms, attempts: attempts.length },
        reasons: probe.version_known ? [] : ['BLENDER_VERSION_UNPARSEABLE'],
      };
    }
  }
  const last = attempts[attempts.length - 1] || null;
  return {
    schema: CAPABILITY_SCHEMA,
    checked_at: checkedAt,
    status: 'unavailable',
    available: false,
    version_known: false,
    version: null,
    executable: null,
    renderers: { candidates: ['BLENDER_EEVEE_NEXT', 'CYCLES'], verified: false },
    operations: { background_python: false, frame_render: false, gltf_export: 'unavailable', video_encode: 'unavailable' },
    probe: { elapsed_ms: attempts.reduce((sum, item) => sum + Number(item.elapsed_ms || 0), 0), attempts: attempts.length },
    reasons: [last?.error_code || 'BLENDER_NOT_FOUND'],
  };
}

function normalizeRequestKey(value) {
  const key = safeText(value, '', 128);
  if (!REQUEST_KEY.test(key) || /^sk-/i.test(key)) {
    const error = new Error('request_key 必须是 3-128 位稳定标识，且不能包含凭据');
    error.code = 'BLENDER_REQUEST_KEY_INVALID';
    throw error;
  }
  return key;
}

function prepareBlenderSmoke(cfg, input = {}, options = {}) {
  const requestKey = normalizeRequestKey(input.request_key || input.idempotency_key);
  if (!input.scene || typeof input.scene !== 'object' || Array.isArray(input.scene)) {
    const error = new Error('Blender smoke 准备需要 scene 场景文档');
    error.code = 'BLENDER_SCENE_REQUIRED';
    throw error;
  }
  let scene;
  try {
    scene = normalizeDirectorDocument(input.scene, input.duration, input.aspect_ratio);
  } catch (error) {
    error.code = error.code || 'BLENDER_SCENE_INVALID';
    throw error;
  }
  const profile = PROFILES.smoke;
  const sceneHash = hashJson(scene);
  const planId = hashJson({ schema: SMOKE_PLAN_SCHEMA, request_key: requestKey, scene_hash: sceneHash }).slice(0, 24);
  const relativeDir = `blender/smoke/${planId}`;
  const root = storageRoot(cfg);
  const relativeArtifacts = {
    scene: `${relativeDir}/scene.json`,
    blend: `${relativeDir}/scene.blend`,
    glb: `${relativeDir}/scene.glb`,
    frame_pattern: `${relativeDir}/frames/frame-####.png`,
    mp4: `${relativeDir}/preview.mp4`,
    manifest: `${relativeDir}/manifest.json`,
  };
  // Resolve for an internal containment check, but do not create directories
  // or write files during preparation.
  const absoluteDir = path.resolve(root, relativeDir);
  const relativeCheck = path.relative(root, absoluteDir);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    const error = new Error('Blender smoke 输出目录超出项目存储根');
    error.code = 'BLENDER_OUTPUT_PATH_INVALID';
    throw error;
  }
  const capability = detectBlender(cfg, options);
  return {
    schema: SCHEMA,
    plan_schema: SMOKE_PLAN_SCHEMA,
    plan_id: planId,
    request_key: requestKey,
    prepared_at: (options.now || nowIso)(),
    executed: false,
    status: capability.available ? 'ready_to_execute' : 'blocked',
    blocked_reason: capability.available ? null : capability.reasons[0],
    capability,
    profile,
    scene: {
      hash: sceneHash,
      version: scene.version,
      aspect_ratio: scene.aspect_ratio,
      duration_seconds: scene.timeline.duration,
      object_count: scene.objects.length,
      camera_count: scene.objects.filter((item) => item.kind === 'camera').length,
      keyframe_count: scene.timeline.keyframes.length,
    },
    command: capability.available
      ? {
        executable: capability.executable,
        flags: ['--background', '--disable-autoexec', '--python-exit-code', '2'],
        script: SMOKE_SCRIPT_RELATIVE,
        input: relativeArtifacts.scene,
        output_dir: relativeDir,
      }
      : null,
    artifacts: [
      { key: 'scene_json', relative_path: relativeArtifacts.scene, status: 'pending', authoritative: 'input_snapshot' },
      { key: 'blend', relative_path: relativeArtifacts.blend, status: 'pending', authoritative: 'editable_scene' },
      { key: 'glb', relative_path: relativeArtifacts.glb, status: 'pending', authoritative: 'browser_proxy' },
      { key: 'frames', relative_path: relativeArtifacts.frame_pattern, status: 'pending', authoritative: 'rendered_frames' },
      { key: 'mp4', relative_path: relativeArtifacts.mp4, status: 'pending', authoritative: 'encoded_preview' },
      { key: 'manifest', relative_path: relativeArtifacts.manifest, status: 'pending', authoritative: 'receipt' },
    ],
    side_effects: {
      filesystem_write: false,
      process_started: false,
      network: false,
      paid: false,
    },
    recovery: {
      idempotency_key: requestKey,
      resume_rule: '读取同一 plan_id 的 manifest；已存在的帧/工程文件只验收或续跑缺失阶段',
      retry_rule: '准备接口重复调用不会启动 Blender；执行器必须单独实现幂等锁',
    },
  };
}

module.exports = {
  SCHEMA,
  CAPABILITY_SCHEMA,
  SMOKE_PLAN_SCHEMA,
  SMOKE_SCRIPT_RELATIVE,
  PROFILES,
  canonicalize,
  hashJson,
  candidateExecutables,
  parseVersion,
  probeOne,
  detectBlender,
  normalizeRequestKey,
  prepareBlenderSmoke,
};
