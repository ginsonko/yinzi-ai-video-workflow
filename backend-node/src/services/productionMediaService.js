const crypto = require('node:crypto');
const path = require('node:path');
const repo = require('./productionRepository');
const imageService = require('./imageService');
const videoService = require('./videoService');
const taskService = require('./taskService');
const validation = require('./productionMediaValidation');
const boundaryFrames = require('./productionBoundaryFrames');
const textStages = require('./productionTextStages');
const promptRegistry = require('./productionPromptRegistry');
const promptRuntime = require('./productionPromptRuntime');
const accounting = require('./productionRuntimeAccounting');
const costLedger = require('./productionCostLedger');
const {
  getYinziVideoCapability,
  capabilitySupportsRole,
} = require('./yinziVideoCapabilities');
const { fetchYinziCatalog } = require('./yinziService');
const {
  listShotVideoRouteOptions,
  selectShotVideoRoute,
  routingMaterialSignature,
} = require('./productionVideoRouter');
const { prepareYinziReferenceVideo } = require('./yinziReferenceMedia');
const {
  planReferenceVideoBudget,
  MIN_CONTINUITY_TAIL_SECONDS,
} = require('./productionReferenceVideoBudget');
const {
  normalizeProductionAspectRatio,
  productionAspectPrompt,
} = require('./productionAspectRatio');

function approvedIncluded(db, runId, stage) {
  return repo.listArtifacts(db, runId, { stage, current: true, status: 'approved', page_size: 200 }).items
    .filter((item) => item.content?.included !== false);
}

function currentArtifacts(db, runId, stage) {
  return repo.listArtifacts(db, runId, { stage, current: true, page_size: 200 }).items;
}

function artifactMatchesSource(artifact, source) {
  return artifact
    && Number(artifact.content?.source_artifact_id) === Number(source.id)
    && ['draft', 'reviewing', 'approved'].includes(artifact.status);
}

function compareShots(left, right) {
  const leftNumber = Number(left.content?.number);
  const rightNumber = Number(right.content?.number);
  const leftHasNumber = Number.isFinite(leftNumber);
  const rightHasNumber = Number.isFinite(rightNumber);
  if (leftHasNumber && rightHasNumber && leftNumber !== rightNumber) return leftNumber - rightNumber;
  if (leftHasNumber !== rightHasNumber) return leftHasNumber ? -1 : 1;
  return String(left.scope_id).localeCompare(String(right.scope_id), undefined, { numeric: true });
}

function sameIdList(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => Number(value) === Number(right[index]));
}

function isSequentialShotRun(run) {
  return run.runtime?.shot_pipeline?.mode === 'sequential';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function catalogWithStoredVideoPrices(db, catalog, run) {
  if (!Array.isArray(catalog?.video)) return catalog;
  const groupName = String(run?.policy?.video_group || '').trim();
  return {
    ...catalog,
    video: catalog.video.map((item) => {
      const stored = costLedger.findPrice(db, {
        provider: 'yinzi', service_type: 'video', model: item.model, group_name: groupName,
      });
      if (!stored || stored.source !== 'manual' || stored.unit_price_usd == null) return item;
      const manualPrice = {
        group: stored.group_name || groupName,
        billing_mode: 'fixed_price',
        billing_unit: stored.billing_unit,
        effective_price: stored.unit_price_usd,
        effective_input_usd: null,
        effective_output_usd: null,
        fixed_duration_seconds: null,
        source: 'manual',
      };
      const prices = (Array.isArray(item.prices) ? item.prices : [])
        .filter((price) => String(price.group || '') !== String(manualPrice.group || ''));
      return { ...item, prices: [manualPrice, ...prices], cheapest_effective_price: manualPrice.effective_price };
    }),
  };
}

function configuredVideoModelForShot(run, shot) {
  const policy = run?.policy || {};
  const overrides = policy.video_model_overrides && typeof policy.video_model_overrides === 'object'
    ? policy.video_model_overrides
    : {};
  const shotModel = String(overrides[String(shot?.scope_id ?? '')] || '').trim();
  if (shotModel) return shotModel;
  const projectMode = policy.video_routing_mode
    ? String(policy.video_routing_mode)
    : String(policy.video_model || '').trim() ? 'fixed' : 'auto';
  return projectMode === 'fixed' ? String(policy.video_model || '').trim() : '';
}

function assertVideoDispatchContract({ run, shot, route, bundle, request, persistedModel = null }) {
  const routeModel = String(route?.model || '').trim();
  const configuredModel = configuredVideoModelForShot(run, shot);
  const bundleModel = String(bundle?.content?.routing_receipt?.model || '').trim();
  const requestModel = String(request?.model || '').trim();
  const requestRouteModel = String(request?.routing_receipt?.model || '').trim();
  const persistedGenerationModel = String(persistedModel || '').trim();
  const routeSignature = routingMaterialSignature(route || {});
  const bundleSignature = String(bundle?.content?.routing_material_signature || '').trim();
  const bundleReceiptSignature = String(bundle?.content?.routing_receipt?.material_signature || '').trim();
  const requestSignature = String(request?.routing_material_signature || '').trim();
  const requestReceiptSignature = String(request?.routing_receipt?.material_signature || '').trim();
  const errors = [];

  if (!routeModel) errors.push('resolved route model is empty');
  if (!bundle || bundle.status !== 'approved') errors.push('reference bundle is not approved');
  if (Number(request?.bundle_artifact_id || 0) !== Number(bundle?.id || 0)) errors.push('reference bundle id changed');
  for (const [label, value] of [
    ['configured model', configuredModel],
    ['bundle model', bundleModel],
    ['request model', requestModel],
    ['request route model', requestRouteModel],
    ['persisted generation model', persistedGenerationModel],
  ]) {
    if (value && routeModel && value !== routeModel) errors.push(`${label} does not match resolved route`);
  }
  if (!bundleModel) errors.push('reference bundle model is empty');
  if (!requestModel) errors.push('request model is empty');
  if (!requestRouteModel) errors.push('request routing receipt model is empty');
  for (const [label, value] of [
    ['bundle signature', bundleSignature],
    ['bundle receipt signature', bundleReceiptSignature],
    ['request signature', requestSignature],
    ['request receipt signature', requestReceiptSignature],
  ]) {
    if (!value) errors.push(`${label} is empty`);
    else if (value !== routeSignature) errors.push(`${label} does not match resolved route`);
  }
  if (errors.length) {
    throw codedError(
      'VIDEO_DISPATCH_CONTRACT_MISMATCH',
      `视频模型派发一致性检查失败：${errors.join('；')}`
    );
  }
  return {
    version: 1,
    consistent: true,
    configured_model: configuredModel || null,
    effective_model: routeModel,
    bundle_model: bundleModel,
    request_model: requestModel,
    dispatched_model: persistedGenerationModel || requestModel,
    persisted_generation_model: persistedGenerationModel || null,
    bundle_artifact_id: Number(bundle.id),
    routing_material_signature: routeSignature,
  };
}

function transitionModeForShot(shot) {
  const value = String(shot?.content?.transition_mode || '').trim();
  if (['opening', 'hard_cut', 'reference_continuation', 'strict_continuation'].includes(value)) return value;
  return Number(shot?.content?.number) === 1 ? 'opening' : 'hard_cut';
}

const PROVIDER_PROMPT_PROFILE = 'structured-provider-prompt-v2';
const PROVIDER_PROMPT_MAX_CHARS = 12000;
const PROVIDER_PROMPT_RENDER_OVERHEAD_CHARS = 180;
const PROVIDER_PROMPT_SECTION_WEIGHTS = Object.freeze({
  boundary: 0.083,
  task: 0.035,
  references: 0.138,
  entry: 0.060,
  visual: 0.116,
  chronology: 0.283,
  exit: 0.094,
  prohibitions: 0.030,
  assets: 0.161,
});

function normalizePromptValue(value) {
  let raw = value;
  if (Array.isArray(raw)) raw = raw.filter(Boolean).join('；');
  else if (raw && typeof raw === 'object') raw = JSON.stringify(raw);
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

function semanticUnitKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s.,，。；;:：!?！？、"'“”‘’()（）\[\]【】]/g, '');
}

function splitSemanticUnits(value) {
  const normalized = normalizePromptValue(value);
  if (!normalized) return [];
  const coarse = normalized
    .replace(/([。！？!?；;])/g, '$1\n')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const expanded = [];
  for (const item of coarse) {
    const pieces = item
      .replace(/([，,、])/g, '$1\n')
      .split(/\r?\n/)
      .map((piece) => piece.replace(/[，,、。！？!?；;]+$/u, '').trim())
      .filter(Boolean);
    expanded.push(...pieces);
  }
  const seen = new Set();
  return expanded.filter((item) => {
    const key = semanticUnitKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactSemanticText(value, maxChars, label = 'prompt field') {
  const normalized = normalizePromptValue(value);
  if (!normalized) return { text: '', compacted: false, source_chars: 0 };
  if (normalized.length <= maxChars) {
    return { text: normalized, compacted: false, source_chars: normalized.length };
  }
  const selected = [];
  let used = 0;
  for (const unit of splitSemanticUnits(normalized)) {
    const separatorLength = selected.length ? 1 : 0;
    if (used + separatorLength + unit.length > maxChars) continue;
    selected.push(unit);
    used += separatorLength + unit.length;
  }
  if (!selected.length) {
    throw codedError(
      'PROVIDER_PROMPT_UNCOMPACTABLE',
      `${label} contains no complete semantic unit that fits its ${maxChars}-character budget`
    );
  }
  return {
    text: selected.join('；'),
    compacted: true,
    source_chars: normalized.length,
  };
}

function compactPromptValue(value, maxChars = 1200, label = 'prompt field') {
  return compactSemanticText(value, maxChars, label).text;
}

function compactPromptEntries(entries, maxChars, sectionKey) {
  const values = entries.map(normalizePromptValue).filter(Boolean);
  if (!values.length) return '';
  const available = Math.max(values.length * 48, maxChars - (values.length - 1));
  const perEntry = Math.max(48, Math.floor(available / values.length));
  return values.map((entry, index) => (
    compactSemanticText(entry, perEntry, `${sectionKey} entry ${index + 1}`).text
  )).join('\n');
}

function providerPromptSectionBudgets(maxChars) {
  const usable = Math.max(900, maxChars - PROVIDER_PROMPT_RENDER_OVERHEAD_CHARS);
  return Object.fromEntries(Object.entries(PROVIDER_PROMPT_SECTION_WEIGHTS)
    .map(([key, weight]) => [key, Math.max(48, Math.floor(usable * weight))]));
}

function renderProviderPromptSections(sections, budgets = null) {
  return sections
    .filter((section) => section.entries.some(Boolean))
    .map((section) => {
      const body = budgets
        ? compactPromptEntries(section.entries, budgets[section.key], section.key)
        : section.entries.filter(Boolean).join('\n');
      return `【${section.title}】\n${body}`;
    })
    .join('\n\n')
    .trim();
}

function providerPromptSectionReceipt(prompt, sections) {
  const receipt = {};
  for (let index = 0; index < sections.length; index += 1) {
    const marker = `【${sections[index].title}】`;
    const start = prompt.indexOf(marker);
    if (start < 0) continue;
    const nextMarker = sections[index + 1] ? `【${sections[index + 1].title}】` : null;
    const end = nextMarker ? prompt.indexOf(nextMarker, start + marker.length) : prompt.length;
    receipt[sections[index].key] = end < 0 ? prompt.length - start : end - start;
  }
  return receipt;
}

function describeProviderReference(db, item, index, mediaType, transitionMode) {
  const artifact = item?.artifact_id ? repo.getArtifact(db, item.artifact_id) : null;
  const title = compactPromptValue(artifact?.title || item?.label || `${mediaType} ${index + 1}`, 120);
  const ordinal = mediaType === 'image' ? `参考图${index + 1}` : mediaType === 'video' ? `参考视频${index + 1}` : `参考音频${index + 1}`;
  if (item?.source === 'strict_first_frame') {
    return `- ${ordinal}「${title}」：严格首帧，生成画面的第一个解码帧必须与它一致。`;
  }
  if (item?.source === 'continuity_first_frame') {
    return `- ${ordinal}「${title}」：上一镜最终解码帧，作为本镜头第一顺位普通参考图；尽量匹配角色、场景、道具、构图和状态，但不得声称像素级严格首帧。`;
  }
  if (item?.source === 'storyboard') {
    return `- ${ordinal}「${title}」：本镜头最终分镜图，锁定构图、入镜状态、角色与道具数量；不得复刻成拼图或多格画面。`;
  }
  if (item?.source === 'asset') {
    const authority = item.scope_type === 'scene'
      ? '锁定场景几何、固定陈设、材质与灯光基线'
      : item.scope_type === 'character'
        ? '锁定该角色的身份、脸、发型、体型、服装和固定装备'
        : '锁定该道具的唯一外形、材质、尺寸和数量';
    return `- ${ordinal}「${title}」：${authority}；只提取设定，不得生成四视图、白底设定板或分栏。`;
  }
  if (item?.source === 'director') {
    return `- ${ordinal}「${title}」：仅约束粗略机位、构图、运动方向、动作阻挡和时间节奏；人物、服装、道具和场景细节以参考图及固定资产约束为准。`;
  }
  if (item?.source === 'continuity_in') {
    const hardCutRule = transitionMode === 'hard_cut'
      ? '只继承角色身份、场景和道具状态，不得延续上一段的机位、运镜或未完成动作'
      : '用于继承已批准的连续状态';
    return `- ${ordinal}「${title}」：上一镜头成片，${hardCutRule}。`;
  }
  return `- ${ordinal}「${title}」：作为本镜头的${mediaType === 'audio' ? '声音' : '视觉'}参考，不得覆盖本提示词的镜头边界和动作时序。`;
}

const CHINESE_SHOT_NUMBERS = Object.freeze([
  '', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
]);

function shotRuleApplies(rule, shot) {
  const text = normalizePromptValue(rule);
  if (!text) return false;
  const number = Number(shot?.content?.number);
  const mentionsShot = /第(?:[一二三四五六七八九十]+|\d+)镜头|镜头\s*\d+/u.test(text);
  if (!mentionsShot || !Number.isFinite(number)) return true;
  const markers = [
    `第${number}镜头`,
    `镜头${number}`,
    CHINESE_SHOT_NUMBERS[number] ? `第${CHINESE_SHOT_NUMBERS[number]}镜头` : '',
  ].filter(Boolean);
  return markers.some((marker) => text.includes(marker));
}

function constraintPriority(unit, shot, sceneStateUnit = false) {
  const text = normalizePromptValue(unit);
  const number = Number(shot?.content?.number);
  const currentMarkers = [
    `第${number}镜头`,
    `镜头${number}`,
    CHINESE_SHOT_NUMBERS[number] ? `第${CHINESE_SHOT_NUMBERS[number]}镜头` : '',
  ].filter(Boolean);
  if (currentMarkers.some((marker) => text.includes(marker))) return 0;
  if (sceneStateUnit && /^(?:场景|背景|画面|街道|全程)?无/u.test(text)) return 0;
  if (sceneStateUnit && /不得|禁止|不能|不可|不出现|不含/u.test(text)) return 1;
  if (/始终|唯一|只|全程|不得|不能|不可|禁止/u.test(text)) return 1;
  return 2;
}

function evenlySampleSemanticUnits(items, limit) {
  const values = Array.isArray(items) ? items : [];
  if (values.length <= limit) return values;
  const indexes = new Set();
  for (let index = 0; index < limit; index += 1) {
    indexes.add(Math.round(index * (values.length - 1) / Math.max(1, limit - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => values[index]);
}

function optionalSemanticGroup(label, values, maxChars) {
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length || maxChars <= label.length + 8) return '';
  try {
    const compacted = compactSemanticText(items.join('；'), maxChars - label.length, label).text;
    return compacted ? `${label}${compacted}` : '';
  } catch (error) {
    if (error.code === 'PROVIDER_PROMPT_UNCOMPACTABLE') return '';
    throw error;
  }
}

function assetProviderContract(asset, shot, maxChars = 1500) {
  const content = asset?.content || {};
  const typeLabel = asset.scope_type === 'character' ? '角色' : asset.scope_type === 'scene' ? '场景' : '道具';
  const anchors = asset.scope_type === 'scene' ? content.spatial_anchors : content.identity_anchors;
  const core = asset.scope_type === 'character'
    ? content.appearance
    : content.description;
  const header = `- ${typeLabel}「${content.name || asset.title}」`;
  const anchorUnits = splitSemanticUnits(anchors);
  const coreUnits = splitSemanticUnits(core);
  const stateCoreUnits = asset.scope_type === 'scene'
    ? coreUnits.filter((unit) => /无|不得|禁止|不能|不可|不出现|不含/u.test(unit))
    : [];
  const continuityUnits = splitSemanticUnits(content.continuity_rules)
    .filter((unit) => shotRuleApplies(unit, shot));
  const ruleUnits = [...stateCoreUnits, ...continuityUnits]
    .filter((unit, index, values) => values.findIndex((item) => semanticUnitKey(item) === semanticUnitKey(unit)) === index)
    .map((unit, index) => ({
      unit,
      index,
      priority: constraintPriority(unit, shot, stateCoreUnits.includes(unit)),
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.unit);
  const negativeUnits = evenlySampleSemanticUnits(splitSemanticUnits(content.negative_prompt), 12);
  const descriptiveUnits = anchorUnits.length ? [] : coreUnits.filter((unit) => !stateCoreUnits.includes(unit));
  const bodyBudget = Math.max(24, maxChars - header.length - 3);
  const anchorBudget = Math.floor(bodyBudget * 0.42);
  const ruleBudget = Math.floor(bodyBudget * 0.38);
  const negativeBudget = bodyBudget - anchorBudget - ruleBudget;
  const anchorGroup = optionalSemanticGroup(
    anchorUnits.length ? '锚点：' : '外观：',
    anchorUnits.length ? anchorUnits : descriptiveUnits,
    anchorBudget
  );
  const ruleGroup = optionalSemanticGroup('状态：', ruleUnits, ruleBudget);
  const negativeGroup = optionalSemanticGroup('禁止：', negativeUnits, negativeBudget);
  const combined = [header, anchorGroup, ruleGroup, negativeGroup].filter(Boolean).join('；');
  if (combined.length <= maxChars) return combined;
  return compactSemanticText(combined, maxChars, `${typeLabel} ${content.name || asset.title}`).text;
}

function buildProviderPromptPackage(db, run, shot, bundle, providerPrompt, explicitCapability = null) {
  const content = shot?.content || {};
  const transitionMode = transitionModeForShot(shot);
  const routeReceipt = bundle?.content?.routing_receipt || {};
  const plannedDuration = Math.max(1, Number(routeReceipt.planned_duration || content.duration) || 5);
  const providerDuration = Math.max(5, Number(routeReceipt.duration || plannedDuration) || 5);
  const durationAdjusted = providerDuration > plannedDuration;
  const capability = explicitCapability || getYinziVideoCapability(String(run.policy?.video_model || '').trim());
  const maxChars = Number(capability?.max_prompt_chars) || PROVIDER_PROMPT_MAX_CHARS;
  const providerHardMaxChars = Number(capability?.provider_prompt_hard_max_chars) || maxChars;
  const sectionBudgets = providerPromptSectionBudgets(maxChars);
  const references = [
    ...(bundle?.content?.images || []).map((item, index) => describeProviderReference(db, item, index, 'image', transitionMode)),
    ...(bundle?.content?.videos || []).map((item, index) => describeProviderReference(db, item, index, 'video', transitionMode)),
    ...(bundle?.content?.audios || []).map((item, index) => describeProviderReference(db, item, index, 'audio', transitionMode)),
  ];
  for (const item of bundle?.content?.videos || []) {
    if (item.source === 'continuity_in' && item.transport?.mode === 'tail_excerpt') {
      references.push('The predecessor input is a tail excerpt ending at the approved real cut boundary. Use it only for identity, scene, prop, and cut-state continuity; its first frame is not this shot\'s first frame.');
    }
  }
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const promptAssetPriority = { character: 0, scene: 1, prop: 2 };
  const scopedAssets = resourceDigestForShot(assetText, shot)
    .sort((left, right) => (promptAssetPriority[left.scope_type] ?? 3) - (promptAssetPriority[right.scope_type] ?? 3));
  const perAssetBudget = maxChars < PROVIDER_PROMPT_MAX_CHARS
    ? Math.max(96, Math.floor((sectionBudgets.assets - Math.max(0, scopedAssets.length - 1)) / Math.max(1, scopedAssets.length)))
    : 1500;
  const assets = scopedAssets.map((asset) => assetProviderContract(asset, shot, perAssetBudget));
  const transitionInstruction = transitionMode === 'opening'
    ? '这是成片开场的独立完整摄影镜头，不依赖前序画面，也不得把本镜头的动作或运镜留到下一次请求。'
    : transitionMode === 'hard_cut'
      ? '这是明确硬切后的新摄影镜头，必须从新机位和已定义入镜状态开始；不得继续上一段尚未完成的动作或运镜。'
      : transitionMode === 'reference_continuation'
        ? '这是尾帧参考续接镜头：上一镜最终帧只作为第一顺位普通参考图，尽量保持连续状态，但不是像素级严格首帧。'
        : '这是严格续拍镜头，必须从派生的精确首帧继续同一条摄影镜头。';
  const chronology = compactPromptValue(providerPrompt || content.video_prompt, 5000);
  const framing = compactPromptValue([content.shot_type, content.camera_angle], 700);
  const cameraMovement = compactPromptValue(content.camera_movement, 700);
  const lighting = compactPromptValue(content.lighting, 900);
  const defaultCreativeGuidance = '除动作时间线明确要求的状态变化外，不得新增、删除、复制、换手、变形或替换任何角色、肢体、服装、道具和场景陈设；不得换景、换昼夜、改变固定几何；不得出现可读文字、字幕、品牌、水印、额外人物或无关物体。动作必须符合关节、重心、接触和惯性，镜头稳定。';
  const creativeGuidance = promptRegistry.resolveRuntime(db, 'production.video_provider.guidance', {
    default_content: defaultCreativeGuidance,
  });
  const sections = [
    {
      key: 'boundary',
      title: '镜头边界，最高优先级',
      entries: [compactPromptValue(content.boundary_prompt || transitionInstruction, 1200), transitionInstruction],
    },
    {
      key: 'task',
      title: '生成任务',
      entries: [
        `时长 ${providerDuration} 秒，画幅 ${compactPromptValue(run.policy?.aspect_ratio || '16:9', 30)}。${compactPromptValue(run.policy?.style || run.policy?.visual_style, 1200)}`,
        durationAdjusted
          ? `原分镜按 ${plannedDuration} 秒设计，但即梦上游最低接受 ${providerDuration} 秒。必须在前 ${plannedDuration} 秒内完成原动作和剪辑点，剩余 ${Number((providerDuration - plannedDuration).toFixed(2))} 秒保持 cut_out 规定的最终状态，不新增动作、人物、道具、运镜或场景变化。`
          : '',
        '单个视频请求必须完成一个完整摄影镜头，镜头内部连续，不使用分屏或快速蒙太奇。',
      ],
    },
    { key: 'references', title: '参考媒体使用规则，严格按传入顺序', entries: references },
    {
      key: 'entry',
      title: '精确入镜状态',
      entries: [compactPromptValue(content.cut_in, 900), compactPromptValue(content.continuity_in, 1600)],
    },
    {
      key: 'visual',
      title: '画面与摄影',
      entries: [
        compactPromptValue(content.visual, 1800),
        framing ? `景别与角度：${framing}` : '',
        cameraMovement ? `运镜：${cameraMovement}` : '',
        lighting ? `灯光：${lighting}` : '',
      ],
    },
    {
      key: 'chronology',
      title: '本镜头完整动作时间线',
      entries: [chronology || compactPromptValue(content.action, 3000)],
    },
    {
      key: 'exit',
      title: '精确出镜状态与剪辑点',
      entries: [compactPromptValue(content.continuity_out, 1600), compactPromptValue(content.cut_out, 900)],
    },
    {
      key: 'prohibitions',
      title: '统一生成禁令',
      entries: [creativeGuidance.content],
    },
    { key: 'assets', title: '相关固定资产约束', entries: assets },
  ];
  const fullPrompt = renderProviderPromptSections(sections);
  const semanticAssetCompaction = maxChars < PROVIDER_PROMPT_MAX_CHARS && scopedAssets.length > 0;
  const prompt = fullPrompt.length <= maxChars
    ? fullPrompt
    : renderProviderPromptSections(sections, sectionBudgets);
  if (prompt.length > maxChars) {
    throw codedError(
      'PROVIDER_PROMPT_TOO_LONG',
      `视频提示词压缩后仍有 ${prompt.length} 字符，超过当前模型 ${maxChars} 字符上限，已在付费提交前停止`
    );
  }
  return {
    prompt,
    receipt: {
      profile: PROVIDER_PROMPT_PROFILE,
      max_chars: maxChars,
      provider_hard_max_chars: providerHardMaxChars,
      planned_duration: plannedDuration,
      provider_duration: providerDuration,
      duration_adjusted: durationAdjusted,
      full_chars: fullPrompt.length,
      final_chars: prompt.length,
      compacted: semanticAssetCompaction || prompt !== fullPrompt,
      section_chars: providerPromptSectionReceipt(prompt, sections),
      prompt_snapshot: {
        prompt_id: creativeGuidance.id,
        prompt_version: creativeGuidance.version,
        customized: creativeGuidance.customized,
        content_hash: creativeGuidance.content_hash,
        content: creativeGuidance.content,
      },
    },
  };
}

function buildProviderPrompt(db, run, shot, bundle, providerPrompt, explicitCapability = null) {
  return buildProviderPromptPackage(db, run, shot, bundle, providerPrompt, explicitCapability).prompt;
}

function scopeShotItems(items, run) {
  if (!isSequentialShotRun(run) || run.current_scope_id == null) return items;
  return items.filter((item) => item.scope_id === String(run.current_scope_id));
}

function actionKey(stage, source, attempt) {
  return `${stage}:${source.scope_type}:${source.scope_id}:source-r${source.revision}:a${attempt}`;
}

function sourceGenerationAttemptCount(db, runId, stage, source, kind) {
  return repo.listActions(db, runId, { page_size: 200 }).items.filter((action) => (
    action.stage === stage
    && action.kind === kind
    && String(action.scope_type || '') === String(source.scope_type || '')
    && String(action.scope_id || '') === String(source.scope_id || '')
    && Number(action.request?.source_artifact_id ?? action.result?.source_artifact_id) === Number(source.id)
  )).length;
}

function rejectedVideoEvidence(db, run, shot) {
  const reviews = repo.listRejectedReviewEvidence(db, run.id, 'shot_video', 'shot', shot.scope_id)
    .map((review) => ({
      review_id: review.id,
      artifact_id: review.artifact_id,
      artifact_revision: review.artifact_revision,
      reason: String(review.reason || '').trim().slice(0, 4000),
      created_at: review.created_at,
    }))
    .filter((review) => review.reason);
  const failures = repo.listActions(db, run.id, { page_size: 200 }).items
    .filter((action) => action.stage === 'shot_video'
      && action.scope_type === 'shot'
      && action.scope_id === String(shot.scope_id)
      && action.result?.automatic_diagnosis?.correction)
    .reverse()
    .map((action) => ({
      review_id: null,
      action_id: action.id,
      artifact_id: null,
      artifact_revision: null,
      reason: String(action.result.automatic_diagnosis.correction).slice(0, 4000),
      observed_failure: String(action.error_message || action.result.automatic_diagnosis.root_cause || '').slice(0, 2000),
      created_at: action.updated_at,
    }));
  return [...reviews, ...failures].slice(-20);
}

function rejectedImageEvidence(db, run, stage, source) {
  const reviews = repo.listRejectedReviewEvidence(db, run.id, stage, source.scope_type, source.scope_id)
    .slice(-5)
    .map((review) => ({
      review_id: review.id,
      artifact_id: review.artifact_id,
      artifact_revision: review.artifact_revision,
      reason: String(review.reason || '').trim().slice(0, 4000),
      created_at: review.created_at,
    }))
    .filter((review) => review.reason);
  const failures = repo.listActions(db, run.id, { page_size: 200 }).items
    .filter((action) => action.stage === stage
      && action.scope_type === source.scope_type
      && action.scope_id === String(source.scope_id)
      && action.result?.automatic_diagnosis?.correction)
    .reverse()
    .map((action) => ({
      review_id: null,
      action_id: action.id,
      artifact_id: null,
      artifact_revision: null,
      reason: String(action.result.automatic_diagnosis.correction).slice(0, 4000),
      observed_failure: String(action.error_message || action.result.automatic_diagnosis.root_cause || '').slice(0, 2000),
      created_at: action.updated_at,
    }));
  return [...reviews, ...failures].slice(-5);
}

function appendImageRevisionFeedback(prompt, evidence, hasRevisionReference) {
  if (!evidence.length) return prompt;
  const requirements = evidence.map((review, index) => (
    `${index + 1}. ${review.reason}`
  )).join('\n');
  const referenceInstruction = hasRevisionReference
    ? 'The first reference image is the previous rejected revision. Preserve its useful identity, face, hairstyle, proportions, layout, and other uncriticized traits; change the criticized details only.'
    : 'Preserve every source-defined trait that is not criticized below.';
  return `${prompt}\n\nHIGH-PRIORITY REVISION REQUIREMENTS (override conflicting visual details):\n${referenceInstruction}\n${requirements}\nDo not merely describe these corrections: render every corrected state visibly and consistently in the new image.`;
}

function rejectedImageReferenceOptedIn(run, source) {
  const policy = run?.policy || {};
  const sourcePolicy = source?.content || {};
  return policy.image_retry_reference_policy === 'include_rejected'
    || sourcePolicy.image_retry_reference_policy === 'include_rejected'
    || sourcePolicy.preserve_rejected_reference === true;
}

function mergeImageReferenceArtifacts(primary, fallback, limit = 4) {
  const selected = [];
  const paths = new Set();
  for (const item of [...primary, ...fallback]) {
    if (!item?.path || paths.has(item.path) || selected.length >= limit) continue;
    paths.add(item.path);
    selected.push(item);
  }
  return selected;
}

const IN_FLIGHT_ACTION_STATUSES = new Set(['reserved', 'submitted', 'waiting']);

const AMBIGUOUS_IMAGE_FAILURE_PATTERNS = [
  /\btimeout\b/i,
  /timed out/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /premature close/i,
  /connection (?:was )?closed/i,
  /response (?:was )?(?:aborted|truncated)/i,
];

function isAmbiguousImageGenerationFailure(generation) {
  if (!generation || generation.status === 'completed') return false;
  const message = String(generation.error_msg || generation.error_message || '');
  return AMBIGUOUS_IMAGE_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

function selectGenerationAction(action, source, replacementTarget, options = {}) {
  if (!action) return { action: null, blocked: null };
  if (action.status === 'ambiguous') return { action, blocked: null };
  const sourceArtifactId = action.result?.source_artifact_id ?? action.request?.source_artifact_id;
  const sourceChanged = sourceArtifactId != null && Number(sourceArtifactId) !== Number(source.id);
  const alreadySuperseded = action.result?.superseded_by_source_change === true
    || action.result?.superseded_by_route_change === true;
  if (sourceChanged) {
    if (action.status === 'reserved' && !action.generation_id) {
      const cancelled = options.cancelReserved?.(action, source) || action;
      return { action: null, blocked: null, cancelled, sourceChanged: true };
    }
    if (action.status === 'submitted' && !action.generation_id) {
      return { action, blocked: 'ambiguous_external_create', sourceChanged: true };
    }
    if (IN_FLIGHT_ACTION_STATUSES.has(action.status)) {
      return { action, blocked: null, sourceChanged: true };
    }
    return { action: null, blocked: null };
  }
  if (alreadySuperseded && !IN_FLIGHT_ACTION_STATUSES.has(action.status)) {
    return { action: null, blocked: null };
  }
  if (replacementTarget && action.status === 'completed') return { action: null, blocked: null };
  return { action, blocked: null };
}

function createDefaultAdapters(db, cfg, log) {
  return {
    createImage(request) {
      return imageService.create(db, log, request);
    },
    getImage(id) {
      return imageService.getById(db, id);
    },
    createVideo(request) {
      const task = taskService.createTask(db, log, 'video_generation', String(request.drama_id || ''));
      const timestamp = new Date().toISOString();
      const info = db.prepare(
        `INSERT INTO video_generations (
          drama_id, storyboard_id, provider, prompt, prompt_contract_json, model, duration, aspect_ratio, resolution,
          seed, camera_fixed, watermark, first_frame_url, last_frame_url, reference_image_urls,
          reference_video_urls, reference_audio_urls, status, task_id, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?)`
      ).run(
        Number(request.drama_id) || 0,
        request.provider || 'yinzi',
        request.prompt || '',
        request.prompt_contract ? JSON.stringify(request.prompt_contract) : null,
        request.model,
        request.duration,
        request.aspect_ratio || '16:9',
        request.resolution || '480p',
        request.seed == null ? null : Number(request.seed),
        request.camera_fixed == null ? null : (request.camera_fixed ? 1 : 0),
        request.watermark ? 1 : 0,
        request.first_frame_url || null,
        request.last_frame_url || null,
        JSON.stringify(request.reference_image_urls || []),
        JSON.stringify(request.reference_video_urls || []),
        JSON.stringify(request.reference_audio_urls || []),
        task.id,
        timestamp,
        timestamp
      );
      const generationId = Number(info.lastInsertRowid);
      setImmediate(() => videoService.processVideoGeneration(db, log, generationId));
      return { id: generationId, task_id: task.id, status: 'processing', model: request.model };
    },
    getVideo(id) {
      return videoService.getById(db, id);
    },
    validateImage: (mediaPath, options) => validation.validateImage(cfg, mediaPath, options),
    validateVideo: (mediaPath, options) => validation.validateVideo(cfg, mediaPath, options),
    validateContinuityFrame: (mediaPath, options = {}) => validation.validateImage(cfg, mediaPath, {
      min_bytes: 64, allow_uniform: true, ...options,
    }),
    extractContinuityFrame: (mediaPath, input) => boundaryFrames.extractTailFrame(cfg, mediaPath, input),
    compareStrictFirstFrame: (expectedPath, generatedPath, options) => (
      boundaryFrames.compareStrictFirstFrame(cfg, expectedPath, generatedPath, options)
    ),
    probeHardCutBoundary: (previousPath, generatedPath) => (
      boundaryFrames.probeHardCutBoundary(cfg, previousPath, generatedPath)
    ),
    prepareReferenceVideoTransport(mediaPath, options) {
      const resolved = validation.resolveLocalMediaPath(cfg, mediaPath);
      const prepared = prepareYinziReferenceVideo(resolved.absolute_path, {
        storage_root: resolved.storage_root,
        aspect_ratio: options.aspect_ratio,
        clip_start_seconds: options.start_seconds,
        clip_duration_seconds: options.duration_seconds,
        log,
      });
      const relativePath = path.relative(resolved.storage_root, prepared.file_path);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw codedError('REFERENCE_VIDEO_EXCERPT_OUTSIDE_STORAGE', 'Prepared reference-video excerpt escaped the storage root');
      }
      return {
        relative_path: relativePath.replace(/\\/g, '/'),
        source_relative_path: resolved.relative_path,
        duration: prepared.probe.duration,
        width: prepared.probe.width,
        height: prepared.probe.height,
        video_codec: prepared.probe.video_codec,
        pixel_format: prepared.probe.pixel_format,
        r_frame_rate: prepared.probe.r_frame_rate_raw,
        avg_frame_rate: prepared.probe.avg_frame_rate_raw,
        cache_reused: prepared.cache_reused === true,
      };
    },
    fetchVideoCatalog: () => fetchYinziCatalog(),
  };
}

const AUTOLINK_RECEIPT_VERSION = 1;
const AUTOLINK_STRATEGY = 'shot_named_assets_only_v1';
const ASSET_TYPE_LABELS = Object.freeze({ scene: '场景', character: '角色', prop: '道具' });
const SHOT_FIELD_LABELS = Object.freeze({
  scene_name: '场景名称',
  character_names: '角色名单',
  prop_names: '道具名单',
});

function normalizeAutoLinkName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
}

function shotAssetReferenceRequests(shot) {
  const requested = [
    ...(shot.content?.scene_name
      ? [{ asset_type: 'scene', source_field: 'scene_name', requested_name: shot.content.scene_name }]
      : []),
    ...(Array.isArray(shot.content?.character_names) ? shot.content.character_names : [])
      .map((name) => ({ asset_type: 'character', source_field: 'character_names', requested_name: name })),
    ...(Array.isArray(shot.content?.prop_names) ? shot.content.prop_names : [])
      .map((name) => ({ asset_type: 'prop', source_field: 'prop_names', requested_name: name })),
  ];
  const seen = new Set();
  return requested.map((item) => ({
    ...item,
    requested_name: String(item.requested_name || '').trim(),
    normalized_name: normalizeAutoLinkName(item.requested_name),
  })).filter((item) => {
    const key = `${item.asset_type}:${item.normalized_name}`;
    if (!item.normalized_name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assetDefinitionIndex(assetText) {
  const index = new Map();
  for (const asset of [...assetText].sort((left, right) => Number(left.id) - Number(right.id))) {
    const normalizedName = normalizeAutoLinkName(asset.content?.name);
    if (!normalizedName) continue;
    const key = `${asset.scope_type}:${normalizedName}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(asset);
  }
  return index;
}

function resourceDigestForShot(assetText, shot) {
  const definitions = assetDefinitionIndex(assetText);
  return shotAssetReferenceRequests(shot).flatMap((request) => {
    const candidates = definitions.get(`${request.asset_type}:${request.normalized_name}`) || [];
    return candidates.length === 1 ? candidates : [];
  });
}

function compareReferencePriority(left, right) {
  const priority = { scene: 0, character: 1, prop: 2 };
  const leftPriority = priority[left?.scope_type] ?? 3;
  const rightPriority = priority[right?.scope_type] ?? 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return String(left?.scope_id || '').localeCompare(String(right?.scope_id || ''), undefined, { numeric: true });
}

function buildImageReferenceAutoLink(db, run, shot, limit = 4, options = {}) {
  const assetSlotLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const providerImageLimit = Math.max(
    assetSlotLimit,
    Math.floor(Number(options.providerImageLimit) || assetSlotLimit)
  );
  const mandatoryImageCount = Math.max(0, Math.floor(Number(options.mandatoryImageCount) || 0));
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const definitions = assetDefinitionIndex(assetText);
  const assetImages = currentArtifacts(db, run.id, 'asset_images')
    .filter((image) => image.status === 'approved' && image.media_path)
    .sort((left, right) => Number(right.id) - Number(left.id));
  const imageByScope = new Map();
  for (const image of assetImages) {
    const key = `${image.scope_type}:${image.scope_id}`;
    if (!imageByScope.has(key)) imageByScope.set(key, image);
  }
  const references = [];
  const receiptItems = [];
  const dependencyIds = new Set();
  const selectedPaths = new Set();
  for (const request of shotAssetReferenceRequests(shot)) {
    const candidates = definitions.get(`${request.asset_type}:${request.normalized_name}`) || [];
    const labelPrefix = ASSET_TYPE_LABELS[request.asset_type] || request.asset_type;
    const sourceFieldLabel = SHOT_FIELD_LABELS[request.source_field] || request.source_field;
    const baseReceipt = {
      asset_type: request.asset_type,
      source_field: request.source_field,
      source_field_label: sourceFieldLabel,
      requested_name: request.requested_name,
      normalized_name: request.normalized_name,
      match_basis: 'normalized_name_exact',
    };
    if (!candidates.length) {
      receiptItems.push({
        ...baseReceipt,
        status: 'missing_asset_definition',
        label: `${labelPrefix} · ${request.requested_name}`,
        reason: `镜头的${sourceFieldLabel}点名了“${request.requested_name}”，但没有同类型的已确认资产定义`,
      });
      continue;
    }
    if (candidates.length > 1) {
      receiptItems.push({
        ...baseReceipt,
        status: 'ambiguous_asset_definition',
        label: `${labelPrefix} · ${request.requested_name}`,
        candidate_definition_artifact_ids: candidates.map((item) => item.id),
        reason: `有 ${candidates.length} 个${labelPrefix}资产归一化后同名，系统没有擅自选择`,
      });
      continue;
    }
    const definition = candidates[0];
    const definitionName = String(definition.content?.name || request.requested_name).trim();
    const image = imageByScope.get(`${definition.scope_type}:${definition.scope_id}`);
    const definitionReceipt = {
      ...baseReceipt,
      label: `${labelPrefix} · ${definitionName}`,
      asset_name: definitionName,
      asset_scope_id: definition.scope_id,
      definition_artifact_id: definition.id,
      definition_revision: definition.revision,
    };
    if (!image) {
      receiptItems.push({
        ...definitionReceipt,
        status: 'missing_approved_image',
        reason: `已匹配${labelPrefix}资产“${definitionName}”，但还没有可用的已确认资源图`,
      });
      continue;
    }
    const imageReceipt = {
      ...definitionReceipt,
      image_artifact_id: image.id,
      image_revision: image.revision,
      image_path: image.media_path,
    };
    if (references.length >= assetSlotLimit) {
      receiptItems.push({
        ...imageReceipt,
        status: 'omitted_by_capacity',
        reason: `视频模型的参考图容量已由更高优先级素材占满，未携带${labelPrefix}“${definitionName}”`,
      });
      continue;
    }
    if (selectedPaths.has(image.media_path)) {
      const referenceIndex = references.findIndex((item) => item.path === image.media_path);
      dependencyIds.add(definition.id);
      dependencyIds.add(image.id);
      receiptItems.push({
        ...imageReceipt,
        status: 'matched',
        reference_index: referenceIndex,
        reason: `按${sourceFieldLabel}精确匹配，复用同一张已确认资源图`,
      });
      continue;
    }
    selectedPaths.add(image.media_path);
    dependencyIds.add(definition.id);
    dependencyIds.add(image.id);
    const referenceIndex = references.length;
    references.push({
      path: image.media_path,
      artifact_id: image.id,
      definition_artifact_id: definition.id,
      scope_type: image.scope_type,
      scope_id: image.scope_id,
      asset_name: definitionName,
      label: `${labelPrefix} · ${definitionName}`,
      source: 'asset',
      role: 'reference',
      match_basis: 'normalized_name_exact',
      source_field: request.source_field,
    });
    receiptItems.push({
      ...imageReceipt,
      status: 'matched',
      reference_index: referenceIndex,
      reason: `按${sourceFieldLabel}精确匹配到已确认${labelPrefix}资源图`,
    });
  }
  const statusCounts = receiptItems.reduce((result, item) => {
    result[item.status] = Number(result[item.status] || 0) + 1;
    return result;
  }, {});
  return {
    references,
    dependencyIds: [...dependencyIds].sort((left, right) => left - right),
    receipt: {
      version: AUTOLINK_RECEIPT_VERSION,
      strategy: AUTOLINK_STRATEGY,
      capacity: {
        provider_image_limit: providerImageLimit,
        mandatory_image_count: mandatoryImageCount,
        asset_slot_limit: assetSlotLimit,
        selected_asset_images: references.length,
      },
      summary: {
        requested_count: receiptItems.length,
        matched_count: Number(statusCounts.matched || 0),
        selected_image_count: references.length,
        warning_count: receiptItems.filter((item) => item.status !== 'matched').length,
        status_counts: statusCounts,
      },
      items: receiptItems,
    },
  };
}

function selectImageReferenceArtifacts(db, run, shot, limit = 4) {
  return buildImageReferenceAutoLink(db, run, shot, limit).references;
}

function selectImageReferences(db, run, shot, limit = 4) {
  return selectImageReferenceArtifacts(db, run, shot, limit).map((item) => item.path);
}

function referenceSheetPrompt(source, run) {
  const style = run.policy?.style || run.policy?.visual_style || '电影感科幻写实';
  if (source.scope_type === 'scene') {
    const location = source.content?.location ? `\n固定地点：${source.content.location}` : '';
    const state = source.content?.reference_state ? `\n唯一参考状态：${source.content.reference_state}` : '';
    const exclusions = source.content?.negative_prompt ? `\n此状态必须排除：${source.content.negative_prompt}` : '';
    return `${style}。场景空间设定四视图，同一地点的全景、主方向、反方向、关键区域，建筑与空间锚点严格一致。\n名称：${source.content.name}${location}${state}\n生成要求：${source.content.visual_prompt}\n状态约束：本设定图只表现上述唯一参考状态，不得引入其它镜头中的过去、未来或过渡状态。${exclusions}`;
  }
  const typeLabel = source.scope_type === 'character'
    ? '角色一致性四视图，同一角色的正面、左侧面、背面、右侧面，全身，白色干净背景，每格造型完全一致'
    : '关键道具多角度产品设定图，正面、侧面、背面、细节特写，形状材质和标识完全一致';
  return `${style}。${typeLabel}。\n名称：${source.content.name}\n设定：${source.content.description}\n固定视觉锚点：${JSON.stringify(source.content.identity_anchors || source.content.continuity_rules || '')}\n生成要求：${source.content.visual_prompt}`;
}

function storyboardResourceDigest(assetText, shot) {
  return resourceDigestForShot(assetText, shot).map((item) => {
    if (item.scope_type === 'scene') {
      return {
        name: item.content.name,
        type: 'scene',
        stable_location: item.content.location || '',
        stable_time: item.content.time || '',
        baseline_reference_state: item.content.reference_state || '',
        usage: '场景参考图只锚定空间几何、材质和固定方位；镜头自身的入镜状态、出镜状态、动作和完整提示决定可变状态',
      };
    }
    return {
      name: item.content.name,
      type: item.scope_type,
      description: item.content.description,
      anchors: item.content.identity_anchors || item.content.continuity_rules || '',
    };
  });
}

function buildImagePromptPackage(stage, source, run, db) {
  const aspectPrompt = productionAspectPrompt(run.policy?.aspect_ratio);
  if (stage === 'asset_images') {
    const basePrompt = referenceSheetPrompt(source, run);
    const defaultContent = `${basePrompt}\n${aspectPrompt}`;
    const resolved = promptRegistry.resolveRuntime(db, 'production.image_asset.template', {
      default_content: defaultContent,
      variables: { base_prompt: basePrompt, aspect_prompt: aspectPrompt },
    });
    return {
      prompt: resolved.content,
      receipt: {
        prompt_id: resolved.id, prompt_version: resolved.version,
        customized: resolved.customized, content_hash: resolved.content_hash,
      },
    };
  }
  const assetText = approvedIncluded(db, run.id, 'asset_text');
  const relevant = storyboardResourceDigest(assetText, source);
  const style = run.policy?.style || run.policy?.visual_style || '电影感科幻写实';
  const photography = `${source.content.shot_type}，${source.content.camera_angle}，${source.content.camera_movement}`;
  const defaultContent = `${style}，单张电影分镜参考图，禁止拼图和分栏。\n${aspectPrompt}\n镜头构图：${source.content.visual}\n动作：${source.content.action}\n摄影：${photography}\n光线：${source.content.lighting}\n入镜连续性：${source.content.continuity_in}\n出镜连续性：${source.content.continuity_out}\n时序规则：镜头自身的入镜状态、出镜状态、动作和完整提示是可变场景状态的唯一权威；一致性资产只锚定身份和不变空间，不得引入本镜头未发生的过去、未来或过渡状态。\n角色/场景/道具固定设定：${JSON.stringify(relevant)}\n完整提示：${source.content.image_prompt}`;
  const resolved = promptRegistry.resolveRuntime(db, 'production.image_storyboard.template', {
    default_content: defaultContent,
    variables: {
      style, aspect_prompt: aspectPrompt, visual: source.content.visual || '', action: source.content.action || '',
      photography, lighting: source.content.lighting || '', continuity_in: source.content.continuity_in || '',
      continuity_out: source.content.continuity_out || '', asset_digest: JSON.stringify(relevant),
      image_prompt: source.content.image_prompt || '',
    },
  });
  return {
    prompt: resolved.content,
    receipt: {
      prompt_id: resolved.id, prompt_version: resolved.version,
      customized: resolved.customized, content_hash: resolved.content_hash,
    },
  };
}

function isVerifiedDuplicateCancellation(action) {
  return action?.status === 'cancelled'
    && action.result?.duplicate_cancelled === true
    && action.result?.task_cancelled === true;
}

function createProductionMediaService(db, cfg, log, injected = {}) {
  const adapters = { ...createDefaultAdapters(db, cfg, log), ...injected };
  const resolveVideoCapability = injected.getVideoCapability || getYinziVideoCapability;

  async function resolveShotVideoRoute(run, shot) {
    const catalog = catalogWithStoredVideoPrices(db, await adapters.fetchVideoCatalog(), run);
    return selectShotVideoRoute({ shot, catalog, policy: run.policy || {} });
  }

  async function listVideoRoutingOptions(run, shot) {
    const catalog = catalogWithStoredVideoPrices(db, await adapters.fetchVideoCatalog(), run);
    return {
      pricing_version: String(catalog?.pricing_version || ''),
      fetched_at: catalog?.fetched_at || null,
      group: String(run?.policy?.video_group || ''),
      options: listShotVideoRouteOptions({ shot, catalog, policy: run?.policy || {} }),
    };
  }

  async function ensureVideoPromptPlan(run, shot, attempt, evidence) {
    const basePrompt = String(shot.content?.video_prompt || '').trim();
    if (!evidence.length) return { state: 'ready', plan: { provider_prompt: basePrompt }, action: null };
    if (typeof adapters.generateText !== 'function') throw new Error('Video retry planning requires a configured text model');
    const latestPlan = repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_prompt_plan',
    });
    if (latestPlan?.status === 'completed'
      && Number(latestPlan.result?.source_artifact_id) === Number(shot.id)
      && JSON.stringify(latestPlan.result?.evidence || []) === JSON.stringify(evidence)) {
      return { state: 'ready', plan: latestPlan.result, action: latestPlan, reused: true };
    }
    const rawPrompts = textStages.videoRetryPlannerPrompts(shot.content, evidence);
    const resolvedPrompt = promptRuntime.resolvePair(db, 'production.video_retry.system', rawPrompts);
    let prompts = resolvedPrompt.prompts;
    let promptReceipt = resolvedPrompt.receipt;
    let action = null;
    const latestMatches = latestPlan
      && Number(latestPlan.request?.source_artifact_id) === Number(shot.id)
      && Number(latestPlan.request?.source_revision) === Number(shot.revision)
      && JSON.stringify(latestPlan.request?.evidence || []) === JSON.stringify(evidence);
    if (latestMatches && latestPlan.status === 'reserved') {
      action = latestPlan;
      const frozen = latestPlan.request?.prompt_snapshot;
      if (frozen?.system != null && frozen?.user != null) {
        prompts = { system: String(frozen.system), user: String(frozen.user) };
        promptReceipt = frozen;
      }
    } else if (latestMatches && ['submitted', 'waiting'].includes(latestPlan.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_in_progress', action: latestPlan };
    } else if (latestMatches && ['failed', 'ambiguous'].includes(latestPlan.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action: latestPlan };
    } else if (latestMatches && latestPlan.status === 'cancelled' && !latestPlan.result?.retry_authorized) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action: latestPlan };
    }
    if (!action) {
      const plannerAttempt = repo.nextActionAttempt(
        db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_prompt_plan'
      );
      const key = `shot_video_prompt_plan:shot:${shot.scope_id}:source-r${shot.revision}:video-a${attempt}:plan-a${plannerAttempt}`;
      const priorFailures = repo.listActions(db, run.id, { page_size: 200 }).items
        .filter((item) => item.kind === 'video_prompt_plan'
          && item.scope_type === 'shot'
          && item.scope_id === String(shot.scope_id)
          && ['failed', 'ambiguous', 'cancelled'].includes(item.status))
        .reverse()
        .map((item) => ({
          action_id: item.id,
          error_code: item.error_code || 'VIDEO_PROMPT_PLAN_FAILED',
          error_message: item.error_message || 'Retry planner failed without an error message',
          failed_at: item.updated_at,
          retry_reason: item.result?.retry_reason || null,
        }));
      const cost = accounting.textReservation(db, run, {
        ...prompts, scene_key: 'production_video_retry_planner', max_tokens: 5000,
      });
      const request = {
        source_artifact_id: shot.id,
        source_revision: shot.revision,
        intended_video_attempt: attempt,
        base_prompt: basePrompt,
        evidence,
        prior_failures: priorFailures,
        retry_of_action_id: latestMatches && latestPlan?.result?.retry_authorized ? latestPlan.id : null,
        prompt_snapshot: resolvedPrompt.receipt,
        model: cost.model || null,
        provider: cost.provider || null,
      };
      action = repo.reserveAction(db, {
        run_id: run.id,
        action_key: key,
        stage: 'shot_video',
        scope_type: 'shot',
        scope_id: shot.scope_id,
        kind: 'video_prompt_plan',
        attempt: plannerAttempt,
        request,
        cost,
      }).action;
    }
    if (['submitted', 'waiting'].includes(action.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_in_progress', action };
    }
    if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) {
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action };
    }
    action = repo.updateAction(db, action.id, { status: 'submitted' });
    try {
      const raw = await adapters.generateText(prompts.user, prompts.system, {
        temperature: 0.25,
        max_tokens: 5000,
        silence_timeout_ms: 120000,
        scene_key: 'production_video_retry_planner',
      });
      const plan = textStages.normalizeVideoRetryPlan(raw, log);
      action = repo.updateAction(db, action.id, {
        status: 'completed',
        result: {
          ...plan,
          source_artifact_id: shot.id,
          source_revision: shot.revision,
          evidence,
          prior_failures: action.request?.prior_failures || [],
          prompt_receipt: promptReceipt,
        },
        cost: accounting.textSettlement(db, action.id, { ...prompts, output: raw }),
      });
      return { state: 'planned', plan: action.result, action, reused: false };
    } catch (error) {
      action = repo.updateAction(db, action.id, {
        status: 'failed',
        error_code: error.code || 'VIDEO_PROMPT_PLAN_FAILED',
        error_message: error.message,
      });
      repo.updateRun(db, run.id, {
        status: 'waiting_review',
        waiting_reason: 'video_prompt_plan_failed',
        error_code: 'VIDEO_PROMPT_PLAN_FAILED',
        error_message: error.message,
      });
      return { state: 'waiting_review', reason: 'video_prompt_plan_failed', action };
    }
  }

  function imageConcurrencyFor(run, stage) {
    if (stage !== 'asset_images') return 1;
    const configured = Number(run.policy?.image_concurrency);
    if (!Number.isFinite(configured)) return 4;
    return Math.min(8, Math.max(1, Math.floor(configured)));
  }

  function imageResult(state, details = {}) {
    const response = {
      state,
      actions: details.actions || [],
      artifacts: details.artifacts || [],
      failures: details.failures || [],
      blockers: details.blockers || [],
      ...details,
    };
    if (!response.action && response.actions[0]) response.action = response.actions[0];
    if (!response.artifact && response.artifacts[0]) response.artifact = response.artifacts[0];
    return response;
  }

  function buildImageRequest(run, stage, source, target) {
    const retryEvidence = rejectedImageEvidence(db, run, stage, source);
    const rejectedReferenceOptedIn = rejectedImageReferenceOptedIn(run, source);
    const revisionReference = rejectedReferenceOptedIn && target?.status === 'rejected' && target.media_path
      ? [{ path: target.media_path, artifact_id: target.id, scope_type: target.scope_type, scope_id: target.scope_id }]
      : [];
    const fallbackAutoLink = stage === 'storyboard_images'
      ? buildImageReferenceAutoLink(db, run, source, Math.max(0, 4 - revisionReference.length), {
        providerImageLimit: 4,
        mandatoryImageCount: revisionReference.length,
      })
      : { references: [], receipt: null };
    const fallbackReferenceArtifacts = fallbackAutoLink.references;
    if (stage === 'storyboard_images'
      && target?.status === 'rejected'
      && target.media_path
      && !rejectedReferenceOptedIn
      && fallbackReferenceArtifacts.length === 0) {
      const error = codedError(
        'IMAGE_RETRY_REFERENCE_AUTHORITIES_MISSING',
        'Storyboard retry has no approved image authority after excluding the rejected frame'
      );
      error.retryEvidence = retryEvidence;
      throw error;
    }
    const referenceArtifacts = mergeImageReferenceArtifacts(revisionReference, fallbackReferenceArtifacts, 4);
    const promptPackage = buildImagePromptPackage(stage, source, run, db);
    const prompt = appendImageRevisionFeedback(
      promptPackage.prompt, retryEvidence, revisionReference.length > 0
    );
    const references = referenceArtifacts.map((item) => item.path);
    const negativePrompt = stage === 'asset_images'
      ? [source.content?.negative_prompt, 'text', 'watermark', 'labels', 'inconsistent identity', 'inconsistent geometry'].filter(Boolean).join(', ')
      : [source.content?.negative_prompt, 'split panels', 'collage', 'text watermark', 'inconsistent identity'].filter(Boolean).join(', ');
    const configuredModel = stage === 'storyboard_images'
      ? (run.policy?.storyboard_image_model || run.policy?.image_model)
      : (run.policy?.asset_image_model || run.policy?.image_model)
    const imageServiceType = stage === 'storyboard_images' ? 'storyboard_image' : 'image';
    const imageConfigId = stage === 'storyboard_images'
      ? run.policy?.storyboard_image_config_id
      : run.policy?.asset_image_config_id;
    return {
      request: {
        drama_id: run.drama_id,
        provider: 'openai',
        model: configuredModel || undefined,
        image_service_type: imageServiceType,
        image_config_id: imageConfigId == null ? undefined : Number(imageConfigId),
        prompt,
        prompt_snapshot: {
          ...promptPackage.receipt,
          final_content_hash: repo.hashJson(prompt),
          final_content: prompt,
        },
        negative_prompt: negativePrompt,
        aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        frame_type: stage === 'asset_images' ? `${source.scope_type}_reference_sheet` : 'production_storyboard',
        reference_images: references,
        reference_artifact_ids: referenceArtifacts.map((item) => item.artifact_id),
        reference_autolink_receipt: fallbackAutoLink.receipt,
        source_artifact_id: source.id,
        source_revision: source.revision,
        revision_reference_artifact_id: revisionReference[0]?.artifact_id || null,
        rejected_reference_artifact_id: target?.status === 'rejected' && target.media_path ? target.id : null,
        rejected_reference_excluded: Boolean(target?.status === 'rejected' && target.media_path && !rejectedReferenceOptedIn),
        rejected_review_evidence: retryEvidence,
      },
      retryEvidence,
    };
  }

  async function reconcileImageAction(run, stage, source, target) {
    const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
    let action = repo.getLatestAction(db, run.id, {
      stage, scope_type: source.scope_type, scope_id: source.scope_id, kind: 'image_generate',
    });
    if (action?.status === 'cancelled'
      && (action.result?.retry_authorized || (rejectedTarget && isVerifiedDuplicateCancellation(action)))) action = null;
    const selection = selectGenerationAction(action, source, rejectedTarget, {
      cancelReserved(staleAction) {
        return repo.updateAction(db, staleAction.id, {
          status: 'cancelled',
          result: {
            ...(staleAction.result || {}),
            source_artifact_id: staleAction.request?.source_artifact_id || null,
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
            superseded_before_submission: true,
          },
        });
      },
    });
    if (selection.blocked) {
      const reason = selection.blocked === 'ambiguous_external_create'
        ? 'ambiguous_image_create'
        : selection.blocked;
      const blockedAction = selection.blocked === 'ambiguous_external_create'
        ? repo.updateAction(db, selection.action.id, {
          status: 'ambiguous', error_code: 'IMAGE_CREATE_AMBIGUOUS',
          error_message: '旧图片创建请求已经外发但没有任务 ID，无法确认是否扣费，禁止自动重提',
          result: {
            ...(selection.action.result || {}),
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
          },
        })
        : selection.action;
      return { kind: 'blocked', reason, action: blockedAction, source, target };
    }
    action = selection.action;
    const actionSourceChanged = selection.sourceChanged === true;
    if (!action) {
      const attempt = repo.nextActionAttempt(db, run.id, stage, source.scope_type, source.scope_id, 'image_generate');
      const sourceAttempt = sourceGenerationAttemptCount(db, run.id, stage, source, 'image_generate') + 1;
      if (sourceAttempt > Number(run.budget?.max_image_revisions || 2) + 1) {
        return { kind: 'blocked', reason: 'image_revision_limit', source, target };
      }
      let built;
      try { built = buildImageRequest(run, stage, source, target); }
      catch (error) { return { kind: 'blocked', reason: error.code || 'image_request_invalid', error, source, target }; }
      return {
        kind: 'candidate', source, target, attempt, sourceAttempt,
        actionKey: actionKey(stage, source, attempt), request: built.request,
      };
    }
    if (action.status === 'ambiguous') return { kind: 'blocked', reason: 'ambiguous_image_create', action, source, target };
    if (action.status === 'submitted' && !action.generation_id) {
      action = repo.updateAction(db, action.id, {
        status: 'ambiguous', error_code: 'IMAGE_CREATE_AMBIGUOUS',
        error_message: '图片创建结果未持久化，禁止自动重提',
      });
      return { kind: 'blocked', reason: 'ambiguous_image_create', action, source, target };
    }
    if (action.status === 'reserved' && !action.generation_id) {
      return { kind: 'submit', source, target, action, request: action.request };
    }
    if (['submitted', 'waiting'].includes(action.status)) {
      let generation;
      try { generation = action.generation_id ? await adapters.getImage(action.generation_id) : null; }
      catch (error) { return { kind: 'active', action, source, target, pollError: error }; }
      if (!generation || ['pending', 'processing'].includes(generation.status)) {
        return { kind: 'active', action, generation, source, target, superseded: actionSourceChanged };
      }
      if (actionSourceChanged) {
        const providerCompleted = generation.status === 'completed';
        repo.updateAction(db, action.id, {
          status: providerCompleted ? 'completed' : 'failed',
          error_code: providerCompleted ? null : 'SUPERSEDED_IMAGE_GENERATION_FAILED',
          error_message: providerCompleted ? null : (generation.error_msg || '旧图片任务失败，结果仅保留为历史'),
          result: {
            ...(action.result || {}),
            source_artifact_id: action.result?.source_artifact_id ?? action.request?.source_artifact_id ?? null,
            generation_id: generation.id || action.generation_id || null,
            generation_status: generation.status,
            superseded_by_source_change: true,
            superseded_by_artifact_id: source.id,
          },
        });
        return reconcileImageAction(repo.getRun(db, run.id), stage, source, target);
      }
      if (generation.status !== 'completed') {
        const errorMessage = generation.error_msg || '图片生成失败';
        if (isAmbiguousImageGenerationFailure(generation)) {
          action = repo.updateAction(db, action.id, {
            status: 'ambiguous', error_code: 'IMAGE_GENERATION_AMBIGUOUS', error_message: errorMessage,
            result: { ...(action.result || {}), ambiguous_reason: 'provider_transport_lost', generation_id: generation.id || action.generation_id || null },
          });
          return { kind: 'blocked', reason: 'image_generation_ambiguous', action, generation, source, target };
        }
        action = repo.updateAction(db, action.id, {
          status: 'failed', error_code: 'IMAGE_GENERATION_FAILED', error_message: errorMessage,
        });
        return { kind: 'failed', reason: 'image_generation_failed', action, generation, source, target };
      }
      const existing = repo.listArtifacts(db, run.id, { stage, scope_type: source.scope_type, scope_id: source.scope_id, page_size: 20 }).items
        .find((item) => Number(item.source_action_id) === Number(action.id) && item.media_path);
      if (existing) {
        action = repo.updateAction(db, action.id, { status: 'completed', result: { ...(action.result || {}), artifact_id: existing.id } });
        return { kind: 'artifact', action, artifact: existing, source, target };
      }
      try {
        const receipt = await adapters.validateImage(generation.local_path || generation.image_url, {
          min_width: 256,
          min_height: 256,
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        const artifact = repo.createArtifact(db, {
          run_id: run.id, stage, scope_type: source.scope_type, scope_id: source.scope_id, title: source.title,
          content: {
            source_artifact_id: source.id, source_revision: source.revision,
            prompt: generation.prompt || action.request?.prompt,
            aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
            request_snapshot: {
              aspect_ratio: action.request?.aspect_ratio,
              frame_type: action.request?.frame_type,
              model: action.request?.model || generation.model || null,
            },
            included: true,
            validation: receipt,
          },
          status: 'draft', media_path: receipt.relative_path, mime_type: `image/${receipt.format || 'png'}`,
          content_hash: receipt.sha256, source_action_id: action.id, source_task_id: generation.task_id,
          source_generation_id: generation.id,
          depends_on: [...new Set([source.id, ...(Array.isArray(action.request?.reference_artifact_ids) ? action.request.reference_artifact_ids : [])]
            .map(Number).filter(Number.isInteger))],
        });
        action = repo.updateAction(db, action.id, { status: 'completed', result: { ...(action.result || {}), artifact_id: artifact.id, receipt } });
        return { kind: 'artifact', action, artifact, source, target };
      } catch (error) {
        action = repo.updateAction(db, action.id, { status: 'failed', error_code: error.code || 'IMAGE_VALIDATION_FAILED', error_message: error.message });
        return { kind: 'failed', reason: 'image_validation_failed', action, source, target, error };
      }
    }
    if (action.status === 'completed') {
      const existing = repo.getArtifact(db, action.result?.artifact_id);
      if (existing?.media_path) return { kind: 'artifact', action, artifact: existing, source, target };
      return { kind: 'blocked', reason: 'completed_image_missing_artifact', action, source, target };
    }
    if (['failed', 'cancelled'].includes(action.status)) {
      return { kind: 'blocked', reason: action.status, action, source, target };
    }
    return { kind: 'blocked', reason: 'image_action_unknown_state', action, source, target };
  }

  async function ensureImageStage(run, stage) {
    const sourceStage = stage === 'asset_images' ? 'asset_text' : 'storyboard_plan';
    const allSources = approvedIncluded(db, run.id, sourceStage);
    const sources = stage === 'storyboard_images' ? scopeShotItems(allSources, run) : allSources;
    if (!sources.length) throw new Error(`阶段 ${sourceStage} 没有已确认内容`);
    const targets = currentArtifacts(db, run.id, stage);
    const records = [];
    for (const source of sources) {
      const target = targets.find((item) => item.scope_type === source.scope_type && item.scope_id === source.scope_id);
      if (artifactMatchesSource(target, source)) continue;
      records.push(await reconcileImageAction(run, stage, source, target));
    }

    const submissions = records.filter((item) => item.kind === 'candidate' || item.kind === 'submit');
    const reserved = [];
    const concurrency = imageConcurrencyFor(run, stage);
    const activeBeforeSubmit = records.filter((item) => item.kind === 'active').length;
    const available = Math.max(0, concurrency - activeBeforeSubmit);
    for (const candidate of submissions.slice(0, available)) {
      let action = candidate.action;
      if (!action) {
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: candidate.actionKey, stage,
          scope_type: candidate.source.scope_type, scope_id: candidate.source.scope_id,
          kind: 'image_generate', attempt: candidate.attempt, request: candidate.request,
          cost: accounting.imageReservation(db, run, candidate.request),
        }).action;
      }
      if (action.status === 'reserved') {
        action = repo.updateAction(db, action.id, { status: 'submitted' });
        reserved.push({ ...candidate, action });
      } else if (action.status === 'waiting') {
        records.push({ kind: 'active', action, source: candidate.source, target: candidate.target });
      } else if (action.status === 'submitted' && !action.generation_id) {
        records.push({ kind: 'blocked', reason: 'ambiguous_image_create', action, source: candidate.source, target: candidate.target });
      }
    }
    const submissionResults = await Promise.allSettled(reserved.map(async (item) => {
      try {
        const created = await adapters.createImage(item.request);
        if (!created?.id) throw codedError('IMAGE_CREATE_AMBIGUOUS', '图片创建没有返回可追踪的 generation id');
        const action = repo.updateAction(db, item.action.id, {
          status: 'waiting', task_id: created.task_id, generation_id: created.id,
          result: { source_artifact_id: item.source.id },
        });
        return { kind: 'active', action, source: item.source, target: item.target };
      } catch (error) {
        const action = repo.updateAction(db, item.action.id, {
          status: error.code === 'IMAGE_CREATE_AMBIGUOUS' ? 'ambiguous' : 'failed',
          error_code: error.code || 'IMAGE_CREATE_FAILED', error_message: error.message,
          ...(error.code === 'IMAGE_CREATE_AMBIGUOUS' ? {} : { cost_status: 'released' }),
        });
        return { kind: 'failed', reason: action.status === 'ambiguous' ? 'ambiguous_image_create' : 'image_create_failed', action, source: item.source, target: item.target, error };
      }
    }));
    for (const result of submissionResults) {
      if (result.status === 'fulfilled') records.push(result.value);
      else records.push({ kind: 'failed', reason: 'image_create_failed', error: result.reason });
    }

    const active = records.filter((item) => item.kind === 'active' && item.action?.status === 'waiting');
    const artifacts = records.filter((item) => item.kind === 'artifact' && item.artifact).map((item) => item.artifact);
    const failures = records.filter((item) => ['failed', 'blocked'].includes(item.kind));
    const blockers = failures.filter((item) => item.kind === 'blocked');
    const latestTargets = currentArtifacts(db, run.id, stage);
    const unresolved = sources.filter((source) => {
      const target = latestTargets.find((item) => item.scope_type === source.scope_type && item.scope_id === source.scope_id);
      return !artifactMatchesSource(target, source);
    });
    if (active.length) {
      repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'image_generation' });
      return imageResult('waiting_task', {
        actions: active.map((item) => item.action), artifacts, failures, blockers,
        source: unresolved[0] || sources[0],
      });
    }
    if (blockers.length || failures.length || unresolved.length) {
      const first = failures[0];
      repo.updateRun(db, run.id, {
        status: 'waiting_review', waiting_reason: first?.reason || 'image_generation_failed',
        error_code: first?.action?.error_code || null, error_message: first?.action?.error_message || first?.error?.message || null,
      });
      return imageResult('waiting_review', {
        reason: first?.reason || 'image_generation_failed', actions: records.map((item) => item.action).filter(Boolean),
        artifacts, failures, blockers, source: first?.source || unresolved[0] || sources[0],
      });
    }
    if (artifacts.length) {
      repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
      return imageResult('progressed', { actions: records.map((item) => item.action).filter(Boolean), artifacts });
    }
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
    return imageResult('stage_ready', { actions: records.map((item) => item.action).filter(Boolean), artifacts: latestTargets });
  }

  async function ensureContinuityFrame(run, shot, previousVideo) {
    if (!previousVideo?.media_path) {
      throw codedError(
        'PREDECESSOR_VIDEO_REQUIRED',
        `镜头 ${shot.scope_id} 要求携带上一镜尾帧，但上一镜头没有已确认的本地视频`
      );
    }
    const existing = currentArtifacts(db, run.id, 'continuity_frame')
      .find((item) => item.scope_id === shot.scope_id);
    if (existing?.status === 'approved'
      && Number(existing.content?.source_artifact_id) === Number(previousVideo.id)
      && Number(existing.content?.target_shot_artifact_id) === Number(shot.id)
      && existing.media_path) {
      try {
        await adapters.validateContinuityFrame(existing.media_path, {
          expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
        });
        return existing;
      } catch (error) {
        log.warn?.('Cached predecessor tail frame is unavailable and will be rebuilt', {
          run_id: run.id, shot: shot.scope_id, artifact_id: existing.id, error: error.message,
        });
      }
    }
    const receipt = await adapters.extractContinuityFrame(previousVideo.media_path, {
      run_id: run.id,
      shot_scope_id: shot.scope_id,
      source_artifact_id: previousVideo.id,
      source_hash: previousVideo.content_hash,
    });
    const draft = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'continuity_frame',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      title: `${shot.title} predecessor tail frame`,
      content: {
        source_artifact_id: previousVideo.id,
        target_shot_artifact_id: shot.id,
        source_video_hash: previousVideo.content_hash || null,
        role: 'predecessor_tail_frame',
        validation: receipt,
        included: true,
      },
      status: 'draft',
      media_path: receipt.relative_path,
      mime_type: 'image/png',
      content_hash: receipt.sha256,
      depends_on: [previousVideo.id, shot.id],
    });
    return repo.reviewArtifact(db, draft.id, {
      reviewer_type: 'deterministic',
      decision: 'approved',
      reason: 'Extracted the exact final decoded frame from the approved predecessor video for explicit boundary use',
    }).artifact;
  }

  function artifactVideoDuration(artifact) {
    const candidates = [
      artifact?.content?.validation?.duration,
      artifact?.content?.expected_duration,
      artifact?.content?.document?.timeline?.duration,
    ];
    for (const candidate of candidates) {
      const duration = Number(candidate);
      if (Number.isFinite(duration) && duration > 0.2) return duration;
    }
    return null;
  }

  async function applyReferenceVideoBudget(run, capability, videoRefs) {
    const planned = planReferenceVideoBudget(videoRefs, {
      max_total_seconds: capability?.max_reference_video_seconds_total,
      safety_margin_seconds: capability?.reference_video_safety_margin_seconds,
    });
    if (!planned.receipt?.enforced) return planned;

    async function prepareItem(item, transport = item.transport) {
      const windowed = transport?.mode === 'tail_excerpt';
      const prepared = await adapters.prepareReferenceVideoTransport(item.original_path || item.path, {
        start_seconds: windowed ? transport.start_seconds : undefined,
        duration_seconds: windowed ? transport.duration_seconds : undefined,
        aspect_ratio: run.policy?.aspect_ratio || '16:9',
      });
      return {
        ...item,
        original_path: item.original_path || item.path,
        path: prepared.relative_path,
        transport: {
          ...transport,
          prepared_duration_seconds: Number(Number(prepared.duration).toFixed(3)),
          width: prepared.width,
          height: prepared.height,
          video_codec: prepared.video_codec,
          pixel_format: prepared.pixel_format,
          r_frame_rate: prepared.r_frame_rate,
          avg_frame_rate: prepared.avg_frame_rate,
          cache_reused: prepared.cache_reused === true,
        },
      };
    }

    const videos = [];
    for (const item of planned.videos) videos.push(await prepareItem(item));
    const totalPreparedSeconds = () => videos.reduce((sum, item) => (
      sum + Number(item.transport?.prepared_duration_seconds ?? item.transport?.duration_seconds ?? 0)
    ), 0);
    let actualTotal = totalPreparedSeconds();
    const safeTarget = Number(planned.receipt.target_total_seconds);
    let frameRoundingCorrection = 0;
    if (Number.isFinite(safeTarget) && actualTotal > safeTarget + 0.001) {
      const continuityIndex = videos.findIndex((item) => item.source === 'continuity_in');
      const continuity = continuityIndex >= 0 ? videos[continuityIndex] : null;
      const requestedDuration = Number(continuity?.transport?.duration_seconds);
      const sourceDuration = Number(continuity?.source_duration_seconds);
      const requiredReduction = actualTotal - safeTarget + (1 / 24);
      if (!continuity
        || !Number.isFinite(requestedDuration)
        || !Number.isFinite(sourceDuration)
        || requestedDuration - requiredReduction < MIN_CONTINUITY_TAIL_SECONDS) {
        throw codedError(
          'REFERENCE_VIDEO_SAFE_TARGET_EXCEEDED',
          `Final reference videos total ${actualTotal.toFixed(3)} seconds and the continuity tail cannot absorb the safe-target correction`
        );
      }
      const correctedDuration = Number((requestedDuration - requiredReduction).toFixed(3));
      const correctedTransport = {
        ...continuity.transport,
        mode: 'tail_excerpt',
        start_seconds: Number((sourceDuration - correctedDuration).toFixed(3)),
        duration_seconds: correctedDuration,
      };
      videos[continuityIndex] = await prepareItem(planned.videos[continuityIndex], correctedTransport);
      frameRoundingCorrection = Number(requiredReduction.toFixed(3));
      actualTotal = totalPreparedSeconds();
    }
    if (Number.isFinite(safeTarget) && actualTotal > safeTarget + 0.001) {
      throw codedError(
        'REFERENCE_VIDEO_SAFE_TARGET_EXCEEDED',
        `Final reference videos total ${actualTotal.toFixed(3)} seconds, above the ${safeTarget.toFixed(3)}-second safe target`
      );
    }
    if (actualTotal > Number(planned.receipt.max_total_seconds) + 0.001) {
      throw codedError(
        'REFERENCE_VIDEO_DURATION_BUDGET_EXCEEDED',
        `Prepared reference videos total ${actualTotal.toFixed(3)} seconds, above the ${planned.receipt.max_total_seconds}-second provider limit`
      );
    }
    return {
      videos,
      receipt: {
        ...planned.receipt,
        prepared_total_seconds: Number(actualTotal.toFixed(3)),
        final_transport_total_seconds: Number(actualTotal.toFixed(3)),
        frame_rounding_correction_seconds: frameRoundingCorrection,
      },
    };
  }

  async function desiredReferenceBundle(run, shot) {
    const shots = approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots);
    const storyboardImages = currentArtifacts(db, run.id, 'storyboard_images').filter((item) => item.status === 'approved');
    const previews = currentArtifacts(db, run.id, 'director_preview').filter((item) => item.status === 'approved');
    const shotVideos = approvedIncluded(db, run.id, 'shot_video');
    const shotIndex = shots.findIndex((item) => Number(item.id) === Number(shot.id));
    const previousShot = shotIndex > 0 ? shots[shotIndex - 1] : null;
    const transitionMode = transitionModeForShot(shot);
    const route = await resolveShotVideoRoute(run, shot);
    const capability = route.capability || resolveVideoCapability(route.model);
    const usesContinuityFrame = ['reference_continuation', 'strict_continuation'].includes(transitionMode);
    const strictFirstFrame = transitionMode === 'strict_continuation';
    const continuityVideo = usesContinuityFrame && previousShot
      ? shotVideos.find((item) => item.scope_id === previousShot.scope_id)
      : null;
    if (strictFirstFrame && !capabilitySupportsRole(capability, 'image', 'first_frame')) {
      throw codedError(
        'STRICT_FIRST_FRAME_UNSUPPORTED',
        `当前视频模型 ${route.model || '未选择'} 不支持严格首帧；请把镜头 ${shot.scope_id} 改为硬切，或选择明确支持 first_frame 的模型`
      );
    }
    if (usesContinuityFrame && !continuityVideo) {
      throw codedError(
        'PREDECESSOR_VIDEO_REQUIRED',
        `镜头 ${shot.scope_id} 必须等上一镜头正式视频确认后才能提取衔接尾帧`
      );
    }
    const continuityFrame = usesContinuityFrame
      ? await ensureContinuityFrame(run, shot, continuityVideo)
      : null;
    const storyboardImage = storyboardImages.find((item) => item.scope_id === shot.scope_id);
    const preview = previews.find((item) => item.scope_id === shot.scope_id);
    if (!storyboardImage?.media_path) throw new Error(`Shot ${shot.scope_id} is missing an approved storyboard image`);
    if (route.requires_director_preview && !preview?.media_path) {
      throw new Error(`Shot ${shot.scope_id} requires an approved director preview`);
    }
    const imageRefs = [];
    if (continuityFrame?.media_path) {
      imageRefs.push({
        path: continuityFrame.media_path,
        artifact_id: continuityFrame.id,
        label: strictFirstFrame ? '严格首帧' : '上一镜尾帧参考',
        source: strictFirstFrame ? 'strict_first_frame' : 'continuity_first_frame',
        role: strictFirstFrame ? 'first_frame' : 'reference',
        locked: true,
      });
    }
    imageRefs.push({
      path: storyboardImage.media_path,
      artifact_id: storyboardImage.id,
      label: '当前分镜图',
      source: 'storyboard',
      role: 'reference',
    });
    const imageLimit = Number(capability?.max_images || route.limits?.images || 4);
    const autoLink = buildImageReferenceAutoLink(db, run, shot, Math.max(0, imageLimit - imageRefs.length), {
      providerImageLimit: imageLimit,
      mandatoryImageCount: imageRefs.length,
    });
    for (const reference of autoLink.references) {
      if (!imageRefs.some((item) => item.path === reference.path)) imageRefs.push(reference);
    }
    const videoRefs = [];
    if (route.uses_reference_video && preview?.media_path) {
      videoRefs.push({
        path: preview.media_path,
        artifact_id: preview.id,
        label: '3D 导演台预演',
        source: 'director',
        source_duration_seconds: artifactVideoDuration(preview),
      });
    }
    const videoLimit = Number(capability?.max_videos || route.limits?.videos || 0);
    const videoBudget = route.uses_reference_video
      ? await applyReferenceVideoBudget(run, capability, videoRefs.slice(0, videoLimit))
      : { videos: [], receipt: { enforced: false, reason: 'reference_video_not_selected' } };
    const { capability: _capability, ...routingReceipt } = route;
    const dependencyIds = [...new Set([
      shot.id,
      storyboardImage.id,
      ...(preview?.id && route.requires_director_preview ? [preview.id] : []),
      ...(continuityVideo ? [continuityVideo.id] : []),
      ...(continuityFrame ? [continuityFrame.id] : []),
      ...autoLink.dependencyIds,
    ].map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    return {
      route,
      content: {
        source_artifact_id: shot.id,
        images: imageRefs.slice(0, imageLimit),
        videos: videoBudget.videos,
        audios: [],
        autolink_receipt: autoLink.receipt,
        routing_receipt: routingReceipt,
        routing_material_signature: routingMaterialSignature(route),
        reference_video_budget: videoBudget.receipt,
        continuity_in_artifact_id: continuityVideo?.id || null,
        continuity_frame_artifact_id: continuityFrame?.id || null,
        continuity_frame_transport: continuityFrame
          ? (strictFirstFrame ? 'strict_first_frame' : 'generic_image_reference')
          : 'none',
        strict_first_frame_artifact_id: strictFirstFrame ? (continuityFrame?.id || null) : null,
        transition_mode: transitionMode,
        previs_mode: route.previs_mode,
        uses_reference_video: route.uses_reference_video,
        requires_director_preview: route.requires_director_preview,
        bundle_origin: 'automatic_suggestion',
        limits: {
          images: Number(capability?.max_images || route.limits?.images || 4),
          videos: route.uses_reference_video
            ? Number(capability?.max_videos || route.limits?.videos || 0)
            : 0,
          audios: Number(capability?.max_audios || route.limits?.audios || 0),
        },
        included: true,
      },
      dependencyIds,
    };
  }

  function referenceBundleMatches(bundle, desired) {
    if (!bundle || !['draft', 'reviewing', 'approved'].includes(bundle.status)) return false;
    if (Number(bundle.content?.source_artifact_id) !== Number(desired.content.source_artifact_id)) return false;
    if (bundle.status === 'approved') {
      const limits = desired.content.limits || { images: 0, videos: 0, audios: 0 };
      const buckets = [
        ['images', Number(limits.images || 0)],
        ['videos', Number(limits.videos || 0)],
        ['audios', Number(limits.audios || 0)],
      ];
      for (const [key, limit] of buckets) {
        const items = Array.isArray(bundle.content?.[key]) ? bundle.content[key] : [];
        if (items.length > limit) return false;
        for (const item of items) {
          if (!String(item?.path || '').trim()) return false;
          if (item.artifact_id != null) {
            const sourceArtifact = repo.getArtifact(db, item.artifact_id);
            if (!sourceArtifact || sourceArtifact.status !== 'approved' || !sourceArtifact.media_path) return false;
            if (![item.path, item.original_path].filter(Boolean).map(String).includes(String(sourceArtifact.media_path))) return false;
          }
        }
      }
      if (desired.content.uses_reference_video === false && (bundle.content?.videos || []).length) return false;
      if (String(bundle.content?.routing_material_signature || '') !== String(desired.content.routing_material_signature || '')) return false;
      if (String(bundle.content?.transition_mode || '') !== String(desired.content.transition_mode || '')) return false;
      const desiredStrictFrameId = Number(desired.content.strict_first_frame_artifact_id || 0);
      const actualStrictFrame = (bundle.content?.images || []).find((item) => item.role === 'first_frame');
      if (desiredStrictFrameId && Number(actualStrictFrame?.artifact_id || 0) !== desiredStrictFrameId) return false;
      if (!desiredStrictFrameId && actualStrictFrame) return false;
      const desiredContinuityFrameId = Number(desired.content.continuity_frame_artifact_id || 0);
      const actualContinuityFrame = (bundle.content?.images || []).find((item) => (
        ['strict_first_frame', 'continuity_first_frame'].includes(item.source)
      ));
      if (desiredContinuityFrameId
        && Number(actualContinuityFrame?.artifact_id || 0) !== desiredContinuityFrameId) return false;
      if (!desiredContinuityFrameId && actualContinuityFrame) return false;
      if (String(bundle.content?.continuity_frame_transport || 'none')
        !== String(desired.content.continuity_frame_transport || 'none')) return false;
      const actualDependencies = repo.listUpstreamArtifactIds(db, bundle.id);
      return actualDependencies.some((id) => Number(id) === Number(desired.content.source_artifact_id));
    }
    const bundleImageIds = (bundle.content?.images || []).map((item) => item.artifact_id);
    const desiredImageIds = desired.content.images.map((item) => item.artifact_id);
    const bundleVideoIds = (bundle.content?.videos || []).map((item) => item.artifact_id);
    const desiredVideoIds = desired.content.videos.map((item) => item.artifact_id);
    const bundleAudioIds = (bundle.content?.audios || []).map((item) => item.artifact_id);
    const desiredAudioIds = desired.content.audios.map((item) => item.artifact_id);
    const videoTransportSignature = (items) => JSON.stringify((items || []).map((item) => ({
      artifact_id: item.artifact_id,
      source: item.source,
      path: item.path,
      original_path: item.original_path || null,
      source_duration_seconds: item.source_duration_seconds ?? null,
      transport: item.transport || null,
    })));
    const actualDependencies = repo.listUpstreamArtifactIds(db, bundle.id);
    return sameIdList(bundleImageIds, desiredImageIds)
      && sameIdList(bundleVideoIds, desiredVideoIds)
      && sameIdList(bundleAudioIds, desiredAudioIds)
      && videoTransportSignature(bundle.content?.videos) === videoTransportSignature(desired.content.videos)
      && JSON.stringify(bundle.content?.reference_video_budget || null) === JSON.stringify(desired.content.reference_video_budget || null)
      && String(bundle.content?.routing_material_signature || '') === String(desired.content.routing_material_signature || '')
      && Number(bundle.content?.strict_first_frame_artifact_id || 0) === Number(desired.content.strict_first_frame_artifact_id || 0)
      && Number(bundle.content?.continuity_frame_artifact_id || 0) === Number(desired.content.continuity_frame_artifact_id || 0)
      && String(bundle.content?.continuity_frame_transport || 'none') === String(desired.content.continuity_frame_transport || 'none')
      && String(bundle.content?.transition_mode || '') === String(desired.content.transition_mode || '')
      && JSON.stringify(bundle.content?.autolink_receipt || null) === JSON.stringify(desired.content.autolink_receipt || null)
      && sameIdList(actualDependencies, desired.dependencyIds);
  }

  async function ensureReferenceBundleForShot(run, shot, stateRetry = 0) {
    const latestRun = repo.getRun(db, run.id);
    if (!latestRun) throw new Error('制作任务不存在');
    const basisRun = Number(latestRun.version) === Number(run.version) ? run : latestRun;
    const desired = await desiredReferenceBundle(basisRun, shot);
    const afterDesiredRun = repo.getRun(db, run.id);
    if (Number(afterDesiredRun.version) !== Number(basisRun.version)) {
      if (stateRetry >= 2) {
        throw codedError('VIDEO_ROUTE_CONCURRENT_UPDATE', '视频模型或参考素材正在更新，请刷新后重试');
      }
      return ensureReferenceBundleForShot(afterDesiredRun, shot, stateRetry + 1);
    }
    // Read the target only after awaited route/reference preparation. This
    // prevents a late old snapshot from overwriting a bundle created while
    // the catalog request was in flight.
    const target = currentArtifacts(db, run.id, 'reference_bundle')
      .find((item) => item.scope_id === shot.scope_id);
    if (referenceBundleMatches(target, desired)) return { state: 'ready', artifact: target, route: desired.route };
    const draft = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'reference_bundle',
      scope_type: 'shot',
      scope_id: shot.scope_id,
      title: `${shot.title} reference bundle`,
      content: desired.content,
      status: 'draft',
      depends_on: desired.dependencyIds,
    });
    return { state: 'refreshed', artifact: draft, route: desired.route };
  }

  async function ensureReferenceBundles(run) {
    const shots = scopeShotItems(
      approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots),
      run
    );
    for (const shot of shots) {
      const ensured = await ensureReferenceBundleForShot(run, shot);
      if (ensured.state === 'refreshed') return { state: 'progressed', artifact: ensured.artifact };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'reference_bundle') };
  }

  function requestDirectorCapture(run) {
    if (String(run?.policy?.director_mode || 'auto') === 'off') {
      return { state: 'stage_ready', artifacts: [] };
    }
    const plans = scopeShotItems(approvedIncluded(db, run.id, 'director_plan'), run);
    if (!plans.length) throw new Error('没有已确认的导演台方案');
    const targets = currentArtifacts(db, run.id, 'director_preview');
    for (const plan of plans) {
      const target = targets.find((item) => item.scope_id === plan.scope_id);
      if (artifactMatchesSource(target, plan)) continue;
      const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
      let action = repo.getLatestAction(db, run.id, {
        stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id, kind: 'client_capture',
      });
      if (action?.status === 'cancelled' && action.result?.retry_authorized) action = null;
      if (action && Number(action.request?.source_artifact_id) !== Number(plan.id)) {
        if (action.status === 'waiting') repo.updateAction(db, action.id, { status: 'cancelled' });
        action = null;
      }
      if (rejectedTarget && action?.status === 'completed') action = null;
      if (!action) {
        const attempt = repo.nextActionAttempt(db, run.id, 'director_preview', 'shot', plan.scope_id, 'client_capture');
        if (attempt > Number(run.budget?.max_director_revisions || 2) + 1) {
          return { state: 'waiting_review', reason: 'director_revision_limit', plan, target };
        }
        const key = actionKey('director_preview', plan, attempt);
        const clientToken = crypto.randomUUID();
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: key, stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id,
          kind: 'client_capture', attempt, request: {
            client_token: clientToken,
            source_artifact_id: plan.id,
            expected_duration: plan.content?.document?.timeline?.duration || 5,
            expected_aspect_ratio: normalizeProductionAspectRatio(run.policy?.aspect_ratio),
          },
        }).action;
        action = repo.updateAction(db, action.id, { status: 'waiting' });
      }
      if (action.status === 'completed') continue;
      if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) {
        return { state: 'waiting_review', reason: action.status, action };
      }
      repo.updateRun(db, run.id, {
        status: 'waiting_client', waiting_reason: 'director_capture',
        runtime: { ...run.runtime, client_action_id: action.id },
      });
      return {
        state: 'client_action',
        client_action: {
          type: 'capture_director_preview',
          action_id: action.id,
          token: action.request.client_token,
          shot_id: plan.scope_id,
          expected_duration: action.request.expected_duration,
          expected_aspect_ratio: action.request.expected_aspect_ratio,
          director_document: plan.content.document,
        },
      };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'director_preview') };
  }

  async function acceptDirectorCapture(runId, input) {
    const run = repo.getRun(db, runId);
    if (!run) throw new Error('制作任务不存在');
    if (String(run.policy?.director_mode || 'auto') === 'off') {
      throw codedError('DIRECTOR_DISABLED', '本任务已关闭 3D 导演台，不能提交导演台 JSON 或预演视频');
    }
    const action = repo.getAction(db, input.action_id);
    if (!action || action.run_id !== runId || action.kind !== 'client_capture') throw new Error('客户端动作不存在');
    if (action.status === 'completed') return { reused: true, artifact: repo.getArtifact(db, action.result?.artifact_id) };
    if (action.status !== 'waiting') throw new Error('客户端动作当前不可提交');
    const provided = Buffer.from(String(input.token || ''));
    const expected = Buffer.from(String(action.request?.client_token || ''));
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new Error('客户端动作令牌无效');
    const expectedDuration = Number(action.request.expected_duration) || 5;
    const receipt = await adapters.validateVideo(input.media_path, {
      expected_duration: expectedDuration,
      duration_tolerance: Math.max(1.5, expectedDuration * 0.3),
      min_bytes: 8192,
      expected_aspect_ratio: normalizeProductionAspectRatio(
        action.request?.expected_aspect_ratio || run.policy?.aspect_ratio
      ),
    });
    if (input.frame_count != null && Number(input.frame_count) < expectedDuration * 15) {
      throw new Error('3D 预演录制帧数不足');
    }
    const plan = repo.getArtifact(db, action.request.source_artifact_id);
    if (!plan || plan.status !== 'approved') throw new Error('对应导演台方案已失效');
    const artifact = repo.createArtifact(db, {
      run_id: run.id, stage: 'director_preview', scope_type: 'shot', scope_id: plan.scope_id,
      title: `${plan.title} 3D 预演`,
      content: {
        source_artifact_id: plan.id,
        expected_duration: expectedDuration,
        aspect_ratio: normalizeProductionAspectRatio(action.request?.expected_aspect_ratio || run.policy?.aspect_ratio),
        frame_count: input.frame_count == null ? null : Number(input.frame_count),
        frame_path: input.frame_path || null,
        validation: receipt,
        included: true,
      },
      status: 'draft', media_path: receipt.relative_path,
      mime_type: receipt.signature === 'webm' ? 'video/webm' : 'video/mp4',
      content_hash: receipt.sha256, source_action_id: action.id, depends_on: [plan.id],
    });
    repo.updateAction(db, action.id, { status: 'completed', result: { artifact_id: artifact.id, receipt } });
    repo.updateRun(db, run.id, {
      status: 'running', waiting_reason: null,
      runtime: { ...run.runtime, client_action_id: null },
    });
    return { reused: false, artifact, receipt };
  }

  async function ensureShotVideos(run) {
    const shots = scopeShotItems(
      approvedIncluded(db, run.id, 'storyboard_plan').sort(compareShots),
      run
    );
    const targets = currentArtifacts(db, run.id, 'shot_video');
    for (const shot of shots) {
      const target = targets.find((item) => item.scope_id === shot.scope_id);
      if (artifactMatchesSource(target, shot)) continue;
      const rejectedTarget = target && ['rejected', 'failed', 'invalidated'].includes(target.status);
      let action = repo.getLatestAction(db, run.id, {
        stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id, kind: 'video_generate',
      });
      const explicitRetryGrant = action?.status === 'cancelled' && action.result?.retry_authorized === true;
      if (explicitRetryGrant) action = null;
      const selection = selectGenerationAction(action, shot, rejectedTarget, {
        cancelReserved(staleAction) {
          return repo.updateAction(db, staleAction.id, {
            status: 'cancelled',
            result: {
              ...(staleAction.result || {}),
              source_artifact_id: staleAction.request?.source_artifact_id || null,
              superseded_by_source_change: true,
              superseded_by_artifact_id: shot.id,
              superseded_before_submission: true,
            },
          });
        },
      });
      if (selection.blocked) {
        const reason = selection.blocked === 'ambiguous_external_create'
          ? 'ambiguous_video_create'
          : selection.blocked;
        const blockedAction = selection.blocked === 'ambiguous_external_create'
          ? repo.updateAction(db, selection.action.id, {
            status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS',
            error_message: '旧视频创建请求已经外发但没有任务 ID，无法确认是否扣费，禁止自动重提',
            result: {
              ...(selection.action.result || {}),
              superseded_by_source_change: true,
              superseded_by_artifact_id: shot.id,
            },
          })
          : selection.action;
        return { state: 'waiting_review', reason, action: blockedAction, shot };
      }
      action = selection.action;
      const actionSourceChanged = selection.sourceChanged === true;
      let route = action?.request?.routing_receipt
        ? {
          ...action.request.routing_receipt,
          capability: resolveVideoCapability(action.request.routing_receipt.model),
        }
        : null;
      let model = route?.model || '';
      let capability = route?.capability || resolveVideoCapability(model);
      let duration = Number(route?.duration || shot.content.duration);
      if (!action) {
        const bundleState = await ensureReferenceBundleForShot(run, shot);
        let bundle = bundleState.artifact;
        route = bundleState.route;
        model = route?.model || '';
        capability = route?.capability || resolveVideoCapability(model);
        duration = Number(route?.duration || shot.content.duration);
        if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
        if (!bundle) throw new Error(`Shot ${shot.scope_id} is missing a reference bundle`);
        if (bundleState.state === 'refreshed' || bundle.status !== 'approved') {
          const reason = bundleState.state === 'refreshed'
            ? 'reference_bundle_stale'
            : 'reference_bundle_review_required';
          repo.updateRun(db, run.id, {
            current_stage: 'reference_bundle',
            current_scope_type: 'shot',
            current_scope_id: String(shot.scope_id),
            status: 'waiting_review',
            waiting_reason: reason,
            error_code: bundleState.state === 'refreshed' ? 'STALE_REFERENCE_BUNDLE' : null,
            error_message: bundleState.state === 'refreshed'
              ? '参考包已变化，已退回可见审批步骤，未提交视频'
              : null,
          });
          repo.appendEvent(db, run.id, 'reference_bundle.review_required', {
            stage: 'reference_bundle', scope_type: 'shot', scope_id: shot.scope_id,
            payload: { artifact_id: bundle.id, reason },
          });
          return { state: 'waiting_review', reason, artifact: bundle, shot };
        }
        const refs = bundle.content || {};
        const limits = refs.limits || route.limits || { images: 4, videos: 3, audios: 1 };
        if ((refs.images || []).length > Number(limits.images)
          || (refs.videos || []).length > Number(limits.videos)
          || (refs.audios || []).length > Number(limits.audios)) {
          throw new Error(`Shot ${shot.scope_id} reference media exceeds the ${limits.images}/${limits.videos}/${limits.audios} limit`);
        }
        if (!route.uses_reference_video && (refs.videos || []).length) {
          throw codedError('VIDEO_ROUTE_REFERENCE_UNSUPPORTED', `短镜头 ${shot.scope_id} 不允许上传参考视频`);
        }
        const attempt = repo.nextActionAttempt(db, run.id, 'shot_video', 'shot', shot.scope_id, 'video_generate');
        const sourceAttempt = sourceGenerationAttemptCount(db, run.id, 'shot_video', shot, 'video_generate') + 1;
        if (sourceAttempt > Number(run.budget?.max_video_attempts_per_shot || 2) && !explicitRetryGrant) {
          return { state: 'waiting_review', reason: 'shot_video_attempt_limit', shot, target };
        }
        const key = actionKey('shot_video', shot, attempt);
        const retryEvidence = rejectedVideoEvidence(db, run, shot);
        const promptPlan = await ensureVideoPromptPlan(run, shot, attempt, retryEvidence);
        if (promptPlan.state === 'planned') {
          repo.updateRun(db, run.id, {
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          return { state: 'progressed', reason: 'video_prompt_planned', action: promptPlan.action, shot };
        }
        if (promptPlan.state !== 'ready') return { ...promptPlan, shot };

        // Catalog and prompt planning are awaited operations. Reload both the
        // run and bundle after them so a concurrent model switch cannot submit
        // the route snapshot captured before the await.
        const validationRun = repo.getRun(db, run.id);
        const validationVersion = Number(validationRun.version);
        const validatedBundleState = await ensureReferenceBundleForShot(validationRun, shot);
        const dispatchRun = repo.getRun(db, run.id);
        const currentBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const dispatchStateChanged = Number(dispatchRun.version) !== validationVersion;
        const validatedBundle = validatedBundleState.artifact;
        if (dispatchStateChanged
          || validatedBundleState.state === 'refreshed'
          || !validatedBundle
          || validatedBundle.status !== 'approved'
          || Number(validatedBundle.id) !== Number(bundle.id)) {
          const reviewBundle = currentBundle || validatedBundle || bundle;
          repo.updateRun(db, run.id, {
            current_stage: 'reference_bundle',
            current_scope_type: 'shot',
            current_scope_id: String(shot.scope_id),
            status: 'waiting_review',
            waiting_reason: 'video_dispatch_state_changed',
            error_code: 'VIDEO_DISPATCH_STATE_CHANGED',
            error_message: '视频模型或参考包在提交前发生变化，已停止旧请求并退回参考包核对；未提交视频',
          });
          repo.appendEvent(db, run.id, 'video.dispatch_revalidation_blocked', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              previous_bundle_artifact_id: bundle?.id || null,
              current_bundle_artifact_id: reviewBundle?.id || null,
              previous_model: model || null,
              current_model: validatedBundleState.route?.model || null,
              run_version_changed: dispatchStateChanged,
              paid_submission: false,
            },
          });
          return {
            state: 'waiting_review',
            reason: 'video_dispatch_state_changed',
            artifact: reviewBundle,
            shot,
          };
        }
        bundle = validatedBundle;
        route = validatedBundleState.route;
        model = route?.model || '';
        capability = route?.capability || resolveVideoCapability(model);
        duration = Number(route?.duration || shot.content.duration);
        if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
        const dispatchRefs = bundle.content || {};
        const dispatchLimits = dispatchRefs.limits || route.limits || { images: 4, videos: 3, audios: 1 };
        if ((dispatchRefs.images || []).length > Number(dispatchLimits.images)
          || (dispatchRefs.videos || []).length > Number(dispatchLimits.videos)
          || (dispatchRefs.audios || []).length > Number(dispatchLimits.audios)) {
          throw codedError('VIDEO_DISPATCH_CONTRACT_MISMATCH', '参考包在提交前超过了当前模型的媒体数量上限');
        }
        if (!route.uses_reference_video && (dispatchRefs.videos || []).length) {
          throw codedError('VIDEO_ROUTE_REFERENCE_UNSUPPORTED', `短镜头 ${shot.scope_id} 不允许上传参考视频`);
        }
        const transitionMode = transitionModeForShot(shot);
        const strictFirstFrame = (dispatchRefs.images || []).find((item) => item.role === 'first_frame');
        const continuityReference = (dispatchRefs.images || []).find((item) => item.source === 'continuity_first_frame');
        if (transitionMode === 'strict_continuation' && !strictFirstFrame?.path) {
          throw codedError('STRICT_FIRST_FRAME_MISSING', `镜头 ${shot.scope_id} 的参考包缺少派生严格首帧`);
        }
        if (transitionMode === 'reference_continuation' && !continuityReference?.path) {
          throw codedError('CONTINUITY_FRAME_MISSING', `镜头 ${shot.scope_id} 选择了尾帧参考续接，但参考包缺少上一镜尾帧`);
        }
        if (strictFirstFrame && !capabilitySupportsRole(capability, 'image', 'first_frame')) {
          throw codedError(
            'STRICT_FIRST_FRAME_UNSUPPORTED',
            `当前视频模型 ${model} 不支持严格首帧，已在付费提交前停止`
          );
        }
        const promptPackage = buildProviderPromptPackage(
          db,
          dispatchRun,
          shot,
          bundle,
          promptPlan.plan.provider_prompt,
          capability
        );
        const request = {
          drama_id: dispatchRun.drama_id,
          provider: dispatchRun.policy?.video_provider || 'yinzi',
          model,
          duration,
          aspect_ratio: dispatchRun.policy?.aspect_ratio || '16:9',
          resolution: dispatchRun.policy?.video_resolution || capability?.resolution || '480p',
          prompt: promptPackage.prompt,
          prompt_contract: promptPackage.receipt,
          prompt_plan_action_id: promptPlan.action?.id || undefined,
          failure_memory: promptPlan.plan.failure_memory || undefined,
          retry_evidence: retryEvidence.length ? retryEvidence : undefined,
          bundle_artifact_id: bundle.id,
          transition_mode: transitionMode,
          watermark: false,
          first_frame_url: strictFirstFrame?.path,
          reference_image_urls: (dispatchRefs.images || [])
            .filter((item) => item.role !== 'first_frame')
            .map((item) => item.path),
          reference_video_urls: (dispatchRefs.videos || []).map((item) => item.path),
          reference_audio_urls: (dispatchRefs.audios || []).map((item) => item.path),
          reference_video_budget: dispatchRefs.reference_video_budget || null,
          routing_receipt: (() => { const { capability: _capability, ...receipt } = route; return receipt; })(),
          routing_material_signature: routingMaterialSignature(route),
        };
        const dispatchReceipt = assertVideoDispatchContract({
          run: dispatchRun, shot, route, bundle, request,
        });
        action = repo.reserveAction(db, {
          run_id: run.id, action_key: key, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
          kind: 'video_generate', attempt, request, reserved_video_seconds: duration,
          cost: accounting.videoReservation(db, dispatchRun, request, route),
        }).action;
        repo.updateAction(db, action.id, { status: 'submitted' });
        let created;
        try { created = await adapters.createVideo(request); }
        catch (error) {
          repo.updateAction(db, action.id, {
            status: 'failed', error_code: 'VIDEO_CREATE_FAILED', error_message: error.message,
            cost_status: 'released',
            result: {
              source_artifact_id: shot.id,
              bundle_artifact_id: bundle.id,
              routing_material_signature: routingMaterialSignature(route),
              dispatch_receipt: dispatchReceipt,
            },
          });
          throw error;
        }
        const persistedDispatchReceipt = assertVideoDispatchContract({
          run: dispatchRun,
          shot,
          route,
          bundle,
          request,
          persistedModel: created.model || null,
        });
        action = repo.updateAction(db, action.id, {
          status: 'waiting', task_id: created.task_id, generation_id: created.id,
          result: {
            source_artifact_id: shot.id,
            bundle_artifact_id: bundle.id,
            routing_material_signature: routingMaterialSignature(route),
            dispatch_receipt: persistedDispatchReceipt,
          },
        });
        repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: 'video_generation' });
        return { state: 'waiting_provider', action, shot };
      }
      if (!route) route = await resolveShotVideoRoute(repo.getRun(db, run.id), shot);
      model = route?.model || '';
      capability = route?.capability || resolveVideoCapability(model);
      duration = Number(route?.duration || shot.content.duration);
      if (!model) throw new Error(`镜头 ${shot.scope_id} 没有可用的视频模型`);
      if (action.status === 'submitted' && !action.generation_id) {
        repo.updateAction(db, action.id, { status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: '视频创建结果不明确，禁止自动重提' });
        return { state: 'waiting_review', reason: 'ambiguous_video_create', action: repo.getAction(db, action.id) };
      }
      if (['reserved', 'submitted', 'waiting'].includes(action.status)) {
        const generation = action.generation_id ? await adapters.getVideo(action.generation_id) : null;
        const capturedBundleId = Number(action.result?.bundle_artifact_id ?? action.request?.bundle_artifact_id);
        const liveRun = repo.getRun(db, run.id);
        const liveBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const configuredModel = configuredVideoModelForShot(liveRun, shot);
        const dispatchedModel = String(action.request?.model || action.request?.routing_receipt?.model || '').trim();
        const actionRouteSuperseded = (Number.isInteger(capturedBundleId)
          && liveBundle
          && Number(liveBundle.id) !== capturedBundleId)
          || (configuredModel && dispatchedModel && configuredModel !== dispatchedModel)
          || actionSourceChanged;
        if (!generation || ['pending', 'processing'].includes(generation.status)) {
          if (generation?.provider_task_id && generation.provider_task_id !== action.provider_id) {
            action = repo.updateAction(db, action.id, { status: 'waiting', provider_id: generation.provider_task_id });
          }
          const waitingReason = actionRouteSuperseded ? 'superseded_video_waiting' : 'video_generation';
          if (liveRun.status !== 'waiting_provider' || liveRun.waiting_reason !== waitingReason) {
            repo.updateRun(db, run.id, { status: 'waiting_provider', waiting_reason: waitingReason });
          }
          return {
            state: 'waiting_provider',
            reason: actionRouteSuperseded ? 'superseded_video_waiting' : 'video_generation',
            action,
            generation,
          };
        }
        if (generation.status !== 'completed' && !actionRouteSuperseded) {
          const errorMessage = generation.error_msg || '视频生成失败';
          repo.updateAction(db, action.id, { status: 'failed', error_code: 'VIDEO_GENERATION_FAILED', error_message: errorMessage });
          repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'video_generation_failed', error_code: 'VIDEO_GENERATION_FAILED', error_message: errorMessage });
          return { state: 'waiting_review', reason: 'video_generation_failed', generation };
        }
        const completionRun = repo.getRun(db, run.id);
        const completionVersion = Number(completionRun.version);
        const bundleState = await ensureReferenceBundleForShot(completionRun, shot);
        const afterBundleRun = repo.getRun(db, run.id);
        const bundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id) || bundleState.artifact;
        const completionStateChanged = Number(afterBundleRun.version) !== completionVersion;
        const staleBundle = completionStateChanged
          || actionSourceChanged
          || !bundle
          || bundleState.state === 'refreshed'
          || bundle.status !== 'approved'
          || !Number.isInteger(capturedBundleId)
          || capturedBundleId !== Number(bundle.id);
        if (staleBundle) {
          const providerFailed = generation.status !== 'completed';
          const staleMessage = providerFailed
            ? (generation.error_msg || '旧模型视频生成失败；当前模型路由已变化，失败只保留为历史')
            : `Reference bundle changed before generation ${generation.id} completed`;
          repo.updateAction(db, action.id, {
            status: providerFailed ? 'failed' : 'completed',
            error_code: providerFailed ? 'SUPERSEDED_VIDEO_GENERATION_FAILED' : null,
            error_message: providerFailed ? staleMessage : null,
            result: {
              ...(action.result || {}),
              generation_id: generation.id,
              generation_status: generation.status,
              superseded_by_route_change: true,
              superseded_by_source_change: actionSourceChanged,
              superseded_by_artifact_id: actionSourceChanged ? shot.id : null,
              stale_bundle_artifact_id: Number.isInteger(capturedBundleId) ? capturedBundleId : null,
              current_bundle_artifact_id: bundle?.id || null,
            },
          });
          repo.updateRun(db, run.id, {
            current_stage: bundle?.status === 'approved' ? 'shot_video' : 'reference_bundle',
            current_scope_type: 'shot', current_scope_id: String(shot.scope_id),
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          repo.appendEvent(db, run.id, 'action.superseded_converged', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              action_id: action.id,
              generation_id: generation.id || action.generation_id || null,
              generation_status: generation.status,
              source_changed: actionSourceChanged,
              old_bundle_artifact_id: Number.isInteger(capturedBundleId) ? capturedBundleId : null,
              current_bundle_artifact_id: bundle?.id || null,
            },
          });
          return { state: 'progressed', reason: 'superseded_video_converged', generation, bundle };
        }
        const completionDispatchReceipt = assertVideoDispatchContract({
          run: afterBundleRun,
          shot,
          route,
          bundle,
          request: action.request,
          persistedModel: generation.model || action.result?.dispatch_receipt?.persisted_generation_model || null,
        });
        const receipt = await adapters.validateVideo(generation.local_path || generation.video_url, {
          expected_duration: duration,
          duration_tolerance: Math.max(1.2, duration * 0.25),
          expected_aspect_ratio: normalizeProductionAspectRatio(afterBundleRun.policy?.aspect_ratio),
        });
        const transitionMode = transitionModeForShot(shot);
        let boundaryValidation = { mode: transitionMode, evaluated: transitionMode === 'opening' ? false : true };
        if (transitionMode === 'strict_continuation') {
          const strictFirstFrame = (bundle.content?.images || []).find((item) => item.role === 'first_frame');
          try {
            boundaryValidation = await adapters.compareStrictFirstFrame(
              strictFirstFrame?.path,
              receipt.relative_path,
              { threshold: Number(afterBundleRun.policy?.strict_first_frame_similarity || 0.9) }
            );
          } catch (error) {
            boundaryValidation = { mode: transitionMode, passed: false, error: error.message };
          }
          if (!boundaryValidation?.passed) {
            const message = boundaryValidation.error
              || `生成视频首帧与指定严格首帧相似度 ${Number(boundaryValidation.similarity || 0).toFixed(4)} 未达到 ${Number(boundaryValidation.threshold || 0.9).toFixed(4)}`;
            repo.updateAction(db, action.id, {
              status: 'failed',
              error_code: 'STRICT_FIRST_FRAME_MISMATCH',
              error_message: message,
              result: { ...(action.result || {}), generation_id: generation.id, boundary_validation: boundaryValidation },
            });
            repo.updateRun(db, run.id, {
              status: 'waiting_review',
              waiting_reason: 'strict_first_frame_mismatch',
              error_code: 'STRICT_FIRST_FRAME_MISMATCH',
              error_message: message,
            });
            return { state: 'waiting_review', reason: 'strict_first_frame_mismatch', generation, boundary_validation: boundaryValidation };
          }
        } else if (transitionMode === 'reference_continuation') {
          const continuityReference = (bundle.content?.images || [])
            .find((item) => item.source === 'continuity_first_frame');
          try {
            const comparison = await adapters.compareStrictFirstFrame(
              continuityReference?.path,
              receipt.relative_path,
              { threshold: 0 }
            );
            boundaryValidation = {
              ...comparison,
              mode: 'reference_continuation',
              passed: undefined,
              threshold: undefined,
              informational_only: true,
              expected_frame_path: continuityReference?.path || comparison.expected_frame_path,
            };
          } catch (error) {
            boundaryValidation = {
              mode: 'reference_continuation',
              informational_only: true,
              probe_error: error.message,
            };
          }
        } else if (transitionMode === 'hard_cut' && bundle.content?.continuity_in_artifact_id) {
          const previousVideo = repo.getArtifact(db, bundle.content.continuity_in_artifact_id);
          if (previousVideo?.media_path) {
            try {
              boundaryValidation = await adapters.probeHardCutBoundary(previousVideo.media_path, receipt.relative_path);
            } catch (error) {
              boundaryValidation = { mode: transitionMode, informational_only: true, probe_error: error.message };
              log.warn?.('Hard-cut boundary probe could not be completed', {
                run_id: run.id, shot: shot.scope_id, error: error.message,
              });
            }
          }
        }
        const finalRun = repo.getRun(db, run.id);
        const finalBundle = currentArtifacts(db, run.id, 'reference_bundle')
          .find((item) => item.scope_id === shot.scope_id);
        const finalConfiguredModel = configuredVideoModelForShot(finalRun, shot);
        const finalRouteChanged = !finalBundle
          || finalBundle.status !== 'approved'
          || Number(finalBundle.id) !== capturedBundleId
          || (finalConfiguredModel && finalConfiguredModel !== dispatchedModel);
        if (finalRouteChanged) {
          const staleMessage = `Reference bundle changed while validating generation ${generation.id}`;
          repo.updateAction(db, action.id, {
            status: 'completed',
            error_code: null,
            error_message: null,
            result: {
              ...(action.result || {}),
              dispatch_receipt: completionDispatchReceipt,
              generation_id: generation.id,
              superseded_by_route_change: true,
              stale_bundle_artifact_id: capturedBundleId,
              current_bundle_artifact_id: finalBundle?.id || null,
            },
          });
          repo.updateRun(db, run.id, {
            current_stage: finalBundle?.status === 'approved' ? 'shot_video' : 'reference_bundle',
            current_scope_type: 'shot', current_scope_id: String(shot.scope_id),
            status: 'running', waiting_reason: null, error_code: null, error_message: null,
          });
          repo.appendEvent(db, run.id, 'action.superseded_converged', {
            stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
            payload: {
              action_id: action.id,
              generation_id: generation.id || action.generation_id || null,
              generation_status: generation.status,
              source_changed: false,
              old_bundle_artifact_id: capturedBundleId,
              current_bundle_artifact_id: finalBundle?.id || null,
            },
          });
          return { state: 'progressed', reason: 'superseded_video_converged', generation, bundle: finalBundle };
        }
        const artifact = repo.createArtifact(db, {
          run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: shot.scope_id,
          title: shot.title,
          content: {
            source_artifact_id: shot.id,
            bundle_artifact_id: bundle.id,
            provider_generation_id: generation.id,
            routing_receipt: action.request?.routing_receipt || null,
            routing_material_signature: action.request?.routing_material_signature || null,
            aspect_ratio: normalizeProductionAspectRatio(afterBundleRun.policy?.aspect_ratio),
            dispatch_transport: {
              first_frame: action.request?.first_frame_url || null,
              reference_images: action.request?.reference_image_urls || [],
              reference_videos: action.request?.reference_video_urls || [],
              reference_audios: action.request?.reference_audio_urls || [],
            },
            validation: receipt,
            boundary_validation: boundaryValidation,
            prompt_contract: generation.prompt_contract || action.request?.prompt_contract || null,
            provider_prompt_receipt: generation.provider_prompt_receipt || null,
            approval_blockers: generation.provider_prompt_receipt?.status === 'truncated'
              ? ['PROVIDER_PROMPT_TRUNCATED']
              : [],
            included: true,
          },
          status: 'draft', media_path: receipt.relative_path, mime_type: 'video/mp4',
          content_hash: receipt.sha256, source_action_id: action.id,
          source_task_id: generation.task_id, source_generation_id: generation.id,
          depends_on: [shot.id, bundle.id],
        });
        repo.updateAction(db, action.id, {
          status: 'completed',
          result: {
            ...(action.result || {}),
            artifact_id: artifact.id,
            receipt,
            generation_id: generation.id,
            dispatch_receipt: completionDispatchReceipt,
          },
        });
        repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });
        return { state: 'progressed', artifact };
      }
      if (['failed', 'ambiguous', 'cancelled'].includes(action.status)) return { state: 'waiting_review', reason: action.status, action };
    }
    return { state: 'stage_ready', artifacts: currentArtifacts(db, run.id, 'shot_video') };
  }

  return {
    ensureImageStage,
    ensureReferenceBundles,
    ensureReferenceBundleForShot,
    requestDirectorCapture,
    acceptDirectorCapture,
    ensureShotVideos,
    resolveShotVideoRoute,
    listVideoRoutingOptions,
    selectImageReferences: (run, shot, limit) => selectImageReferences(db, run, shot, limit),
    buildImageReferenceAutoLink: (run, shot, limit, options) => buildImageReferenceAutoLink(db, run, shot, limit, options),
  };
}

module.exports = {
  createProductionMediaService,
  assertVideoDispatchContract,
  isAmbiguousImageGenerationFailure,
  buildProviderPrompt,
  buildProviderPromptPackage,
  normalizeAutoLinkName,
  PROVIDER_PROMPT_MAX_CHARS,
  PROVIDER_PROMPT_PROFILE,
};
