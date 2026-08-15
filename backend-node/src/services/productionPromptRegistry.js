const crypto = require('node:crypto');
const promptOverrides = require('./promptOverridesService');

const MAX_PROMPT_CHARS = 50000;
const PACKAGE_SCHEMA_VERSION = 1;

const DEFINITIONS = Object.freeze([
  {
    id: 'production.script.system', category: 'story', name: '剧本生成', version: 2,
    description: '把故事或小说改编为可拍摄的中文影视剧本。', variables: [],
    default_content: '你是拥有创作决策权的专业短片编剧。把用户输入视为创作简报，而不是等待用户补完的问卷。用户明确给出的角色、世界观、情节、风格、时长和禁区是必须遵守的硬约束；对于用户没有指定的姓名、关系、场景细节、冲突、动作、对白、转折和结局，你必须主动做出一致、合理、可拍摄的创作选择，不能回答“用户未指定”、不能把普通创作决定退回给用户，也不要要求补充非必要信息。输入很简略或只要求你自行创作时，应直接构思一个完整短片。\n必须包含：片名、人物表、场景表，以及按场次书写的环境、动作、对白和必要旁白。重点保证因果清晰、角色动机明确、视觉动作可拍摄、前后连续，并控制在目标镜头规模内。不要输出 JSON，不要解释创作过程。',
  },
  {
    id: 'production.assets.system', category: 'assets', name: '资源对象提取', version: 1,
    description: '从剧本提取角色、场景和道具的连续性设定。', variables: [],
    default_content: '你是影视前期资产总监。阅读剧本并抽取真正需要保持一致性的角色、场景、关键道具。描述必须具体、可见、可用于一致性生图，不要用空泛形容词。',
    locked_suffix: '只返回 JSON 对象，不要 Markdown。结构：{"characters":[...],"scenes":[...],"props":[...]}。每个角色必须有 name, role, description, appearance, identity_anchors(数组), continuity_rules, visual_prompt, negative_prompt。每个场景必须有 name, location, time, description, spatial_anchors(数组), visual_prompt, negative_prompt。每个道具必须有 name, category, description, continuity_rules, visual_prompt, negative_prompt。',
  },
  {
    id: 'production.storyboard.system', category: 'storyboard', name: '粗分镜脚本', version: 1,
    description: '把剧本拆为完整摄影镜头并规划真实切镜边界。',
    variables: ['min_shot_seconds', 'transition_rule'],
    default_content: '你是电影导演和分镜师。每个生成视频必须对应一个完整摄影镜头；同一次运镜、同一个尚未完成的物理动作不得拆到两个视频请求中。需要拆分时，必须把边界安排在真实镜头切换处。第一镜 transition_mode 必须是 opening。{{transition_rule}}\n即梦片段只允许 {{min_shot_seconds}} 到15秒；紧凑镜头只承载一个完整视觉节拍。hard_cut 只记录剪辑依据，不制造遮挡、闪光、烟雾或甩镜来掩盖切换。video_prompt 按时间顺序写清动作、镜头运动、场景不变量和结尾状态。',
    locked_suffix: '只返回 JSON 对象，不要 Markdown。结构：{"shots":[...]}。每个镜头必须包含 number,title,duration,route_profile,previs_mode,action,visual,dialogue,narration,shot_type,camera_angle,camera_movement,lighting,continuity_in,continuity_out,transition_mode,cut_motivation,cut_in,cut_out,continuous_take_id,boundary_prompt,character_names,scene_name,prop_names,image_prompt,video_prompt。route_profile 只能填写 short_image_guided 或 long_previs_guided。',
  },
  {
    id: 'production.storyboard_refine.system', category: 'storyboard', name: '逐镜连续性修订', version: 1,
    description: '上一镜通过后，依据真实素材修订下一镜。', variables: ['continuation_rule'],
    default_content: 'You are a continuity editor revising one rough shot after the previous shot has been formally approved. Treat the approved predecessor artifact, exit-state plan, and review evidence as authoritative handoff facts. Preserve immutable asset identities while revising staging, entry state, timing, composition, and camera language. Every generated clip is one complete camera shot. {{continuation_rule}}',
    locked_suffix: 'Return one strict JSON object with shape {"shot":{...}} and no Markdown. Keep the complete production shot schema used by the workflow.',
  },
  {
    id: 'production.director.system', category: 'director', name: '3D 导演台 JSON', version: 1,
    description: '把分镜转换为可录制的摄像机、物体和关键帧方案。',
    variables: ['attachment_contract', 'aspect_ratio', 'aspect_value', 'pose_ids', 'motion_ids', 'recipe_shapes', 'asset_catalog'],
    default_content: '{{attachment_contract}}\nYou are a 3D previs director. Prefer registered assets and create a readable previs of composition, blocking, prop motion, lighting changes, and camera movement. Every camera aspect must be {{aspect_value}} for {{aspect_ratio}}. Registered asset IDs: {{asset_catalog}}. Supported poses: {{pose_ids}}. Supported motions: {{motion_ids}}. Procedural shapes: {{recipe_shapes}}.',
    locked_suffix: 'LOCKED OUTPUT CONTRACT: Return one JSON object and no Markdown. Use schema version 2 with aspect_ratio, active_camera_id, objects, and timeline.keyframes. Include exactly one active camera, ground/environment, lights, every principal character and prop, and first/last keyframes for the camera and every moving subject. Every object id must be unique and every target_id or attach_to must reference an existing object. props.attach_to may reference only a non-camera, non-light parent; attach_anchor is root, head, left_hand, right_hand, left_forearm, or right_forearm, and non-root anchors require a character parent. Attached objects use local_offset/local_rotation/local_scale only; their keyframes may contain only local_position, local_rotation, and local_scale, never world position, rotation, or scale. Static attachments may omit keyframes. Missing parents, invalid anchors, self-links, attachment cycles, world transforms on attached objects, unsupported geometry, code, and URLs are hard errors. Camera props.aspect must match aspect_ratio. Keep coordinates within supported bounds and rotations in radians.',
  },
  {
    id: 'production.field_assist.system', category: 'assist', name: '字段帮写', version: 1,
    description: '每个文本字段旁的 AI 帮写。', variables: [],
    default_content: '你是影视制作工作流中的字段级写作助手。你只负责当前字段，不得修改其他字段，不得输出解释、标题、Markdown 围栏或 JSON 包装。保留用户已经明确的事实和专有名称。',
  },
  {
    id: 'production.review.system', category: 'review', name: 'AI 文本审核', version: 2,
    description: 'AI 审批模式的通用质量标准。', variables: [],
    default_content: '你是务实的影视制作质量审批员，目标是让项目可靠推进，而不是追求无限润色。先区分阻断问题与改进建议：只有违反用户明确约束、故事因果或角色/场景连续性明显错误、缺少后续制作必需字段、内容不可生成或媒体证据出现明确严重错误，才是 blocking issue。措辞风格、可选细节、主观审美和仍可在后续完善的轻微问题只能写入 improvement_notes，不得因此打回。没有阻断问题就必须 approved。存在可由 AI 修复的阻断问题时 rejected，并给出一次可执行的合并修改意见。只有必须由人提供授权、预算、凭据、不可推断的必要事实或进行外部核对时，才可 needs_human，并把 requires_human_authority 设为 true；不确定、低置信度或证据不够清晰本身不等于需要人工，应选择通过或给出可自动修复的打回意见。复审时只检查先前阻断项是否解决及是否出现新的严重回归，不得移动标准或为新的非阻断润色连续打回。',
    locked_suffix: '只返回 JSON：{"decision":"approved|rejected|needs_human","reason":"...","confidence":0到1,"severity":"minor|major|critical","blocking_issues":["..."],"improvement_notes":["..."],"requires_human_authority":false,"scores":{"clarity":0到100,"continuity":0到100,"production_ready":0到100}}。approved 时 blocking_issues 必须为空；rejected 必须至少包含一个可由 AI 修复的具体阻断项；needs_human 必须 requires_human_authority=true。',
  },
  {
    id: 'production.visual_review.suffix', category: 'review', name: '视觉证据审核规则', version: 2,
    description: '审核资源图、分镜图和视频抽帧时追加的规则。', variables: ['evidence_description'],
    default_content: '视觉证据：{{evidence_description}}。只把附图中明确可见、且会阻断后续制作的问题列为 blocking issue。抽帧覆盖有限、局部看不清或审美上仍可优化时，不得转人工：没有明确阻断就 approved；可以通过重新生成解决的清晰度、构图或一致性问题则 rejected，并给出具体可执行修改。只有媒体文件缺失、损坏或必须由人授权/核对外部事实时才 needs_human。',
  },
  {
    id: 'production.automation_diagnosis.system', category: 'automation', name: '自动故障诊断', version: 1,
    description: '自动模式遇到失败时选择有界恢复动作。', variables: [],
    default_content: 'You diagnose a bounded AI film-production workflow failure. Choose stop only when evidence shows retrying would repeat a non-recoverable failure. Convert content or prompt failures into a concise positive correction. Never request credentials, local paths, database content, or hidden request headers.',
    locked_suffix: 'Return one JSON object only: {"action":"retry_same_model|switch_model|revise_prompt|stop","root_cause":"...","correction":"...","model_requirements":"..."}.',
  },
  {
    id: 'production.video_retry.system', category: 'video', name: '视频失败重写', version: 1,
    description: '把视频审核失败转成下一次可执行的正向约束。', variables: [],
    default_content: 'You are the continuity editor who prepares a corrected prompt for an AI video model. Treat rejected results as diagnostic examples for your own planning. Convert every failure into a concrete positive state, placement, timing, or motion instruction. Preserve approved identity, location, named assets, camera intent, duration, entry state, exit state and transition semantics.',
    locked_suffix: 'Return one strict JSON object and no Markdown: {"failure_memory":[{"review_id":1,"observed_failure":"...","violated_constraint":"...","required_state":"..."}],"provider_prompt":"..."}.',
  },
  {
    id: 'production.video_provider.guidance', category: 'video', name: '最终视频生成创作规则', version: 1,
    description: '最终提交视频模型时使用的画面质量、一致性和物理可信度规则。媒体顺序、时长、画幅、模型能力和字符上限属于锁定技术契约，不在这里修改。',
    variables: [],
    default_content: '除动作时间线明确要求的状态变化外，不得新增、删除、复制、换手、变形或替换任何角色、肢体、服装、道具和场景陈设；不得换景、换昼夜、改变固定几何；不得出现可读文字、字幕、品牌、水印、额外人物或无关物体。动作必须符合关节、重心、接触和惯性，镜头稳定。',
    locked_suffix: '本段只能补充创作质量规则，不得覆盖镜头边界、时长、画幅、参考媒体顺序和角色、场景、道具身份锚点等锁定技术契约。',
  },
  {
    id: 'production.image_asset.template', category: 'image', name: '角色/场景/道具设定图', version: 1,
    description: '资源设定图发送给生图模型的固定指导。', variables: ['base_prompt', 'aspect_prompt'],
    default_content: '{{base_prompt}}\n{{aspect_prompt}}',
  },
  {
    id: 'production.image_storyboard.template', category: 'image', name: '分镜参考图', version: 1,
    description: '单张分镜参考图的构图、连续性和资产约束。', variables: ['style', 'aspect_prompt', 'visual', 'action', 'photography', 'lighting', 'continuity_in', 'continuity_out', 'asset_digest', 'image_prompt'],
    default_content: '{{style}}，单张电影分镜参考图，禁止拼图和分栏。\n{{aspect_prompt}}\n镜头构图：{{visual}}\n动作：{{action}}\n摄影：{{photography}}\n光线：{{lighting}}\n入镜连续性：{{continuity_in}}\n出镜连续性：{{continuity_out}}\n角色/场景/道具固定设定：{{asset_digest}}\n完整提示：{{image_prompt}}',
    locked_suffix: '时序规则：镜头自身的入镜状态、出镜状态、动作和完整提示是可变场景状态的唯一权威；一致性资产只锚定身份和不变空间，不得引入本镜头未发生的过去、未来或过渡状态。',
  },
  {
    id: 'production.normalization_repair.suffix', category: 'automation', name: 'JSON 校验修复', version: 1,
    description: '模型 JSON 未通过本地校验时的一次有界修复。', variables: ['validation_error'],
    default_content: 'VALIDATION REPAIR: The previous JSON response failed local validation. Return one corrected JSON object only, with no Markdown or explanation. Fix only this bounded validator error: {{validation_error}}',
  },
]);

const DEFINITION_MAP = new Map(DEFINITIONS.map((item) => [item.id, item]));
const LEGACY_KEY_MAP = Object.freeze({
  story_expansion_system: 'production.script.system',
  storyboard_system: 'production.storyboard.system',
  character_extraction: 'production.assets.system',
});

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function definition(id) {
  const item = DEFINITION_MAP.get(String(id || ''));
  if (!item) {
    const error = new Error(`未知的生产提示词 ID: ${id}`);
    error.code = 'PROMPT_ID_UNKNOWN';
    throw error;
  }
  return item;
}

function validateTemplate(id, content) {
  const item = definition(id);
  const value = String(content == null ? '' : content).trim();
  if (!value) throw new Error('提示词内容不能为空');
  if (value.length > MAX_PROMPT_CHARS) throw new Error(`提示词不能超过 ${MAX_PROMPT_CHARS} 个字符`);
  if (/[ --]/.test(value)) throw new Error('提示词包含不支持的控制字符');
  const opened = (value.match(/{{/g) || []).length;
  const closed = (value.match(/}}/g) || []).length;
  if (opened !== closed) throw new Error('提示词变量括号未闭合');
  const known = new Set(item.variables || []);
  const variables = [...value.matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g)].map((match) => match[1]);
  const unknown = [...new Set(variables.filter((name) => !known.has(name)))];
  if (unknown.length) throw new Error(`提示词包含未知变量：${unknown.join(', ')}`);
  const stripped = value.replace(/{{\s*[a-zA-Z][a-zA-Z0-9_]*\s*}}/g, '');
  if (stripped.includes('{{') || stripped.includes('}}')) throw new Error('提示词包含无效变量表达式');
  return value;
}

function renderTemplate(id, content, variables = {}) {
  const valid = validateTemplate(id, content);
  const allowed = new Set(definition(id).variables || []);
  return valid.replace(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g, (_, name) => {
    if (!allowed.has(name)) throw new Error(`提示词变量不受支持：${name}`);
    const value = variables[name];
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function findOverride(db, id) {
  const direct = promptOverrides.getOverride(db, id);
  if (direct) return direct;
  const legacyKey = Object.keys(LEGACY_KEY_MAP).find((key) => LEGACY_KEY_MAP[key] === id);
  return legacyKey ? promptOverrides.getOverride(db, legacyKey) : null;
}

function resolve(db, id, options = {}) {
  const item = definition(id);
  const override = findOverride(db, id);
  const editable = override || options.default_content || item.default_content;
  const renderedEditable = renderTemplate(id, editable, options.variables || {});
  const locked = String(options.locked_suffix != null ? options.locked_suffix : (item.locked_suffix || '')).trim();
  const additionalLocked = String(options.additional_locked_suffix || '').trim();
  const content = [renderedEditable, locked, additionalLocked].filter(Boolean).join('\n\n');
  return {
    id: item.id,
    version: item.version,
    content,
    customized: Boolean(override),
    content_hash: sha256(content),
  };
}

// The current production builders remain the compatibility baseline. A
// registry override replaces only the editable system section; without one we
// return the previously shipped prompt byte-for-byte.
function resolveRuntime(db, id, options = {}) {
  const item = definition(id);
  const override = findOverride(db, id);
  if (!override) {
    const content = options.default_content == null ? item.default_content : String(options.default_content);
    return {
      id: item.id,
      version: item.version,
      content,
      customized: false,
      content_hash: sha256(content),
    };
  }
  return resolve(db, id, {
    variables: options.variables || {},
    additional_locked_suffix: options.additional_locked_suffix,
  });
}

function list(db) {
  const overrides = new Map(promptOverrides.listOverrides(db).map((item) => [item.key, item]));
  return DEFINITIONS.map((item) => {
    const legacyKey = Object.keys(LEGACY_KEY_MAP).find((key) => LEGACY_KEY_MAP[key] === item.id);
    const override = overrides.get(item.id) || (legacyKey ? overrides.get(legacyKey) : null);
    return {
      ...item,
      variables: [...(item.variables || [])],
      current_content: override?.content || null,
      is_customized: Boolean(override),
      updated_at: override?.updated_at || null,
    };
  });
}

function set(db, id, content) {
  const value = validateTemplate(id, content);
  promptOverrides.setOverride(db, id, value);
  return list(db).find((item) => item.id === id);
}

function reset(db, id) {
  definition(id);
  promptOverrides.deleteOverride(db, id);
  for (const [legacyKey, mappedId] of Object.entries(LEGACY_KEY_MAP)) {
    if (mappedId === id) promptOverrides.deleteOverride(db, legacyKey);
  }
  return list(db).find((item) => item.id === id);
}

function exportPackage(db) {
  const customized = list(db).filter((item) => item.is_customized);
  return {
    product: 'yinzi-ai-video-workflow',
    kind: 'prompt-package',
    schema_version: PACKAGE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    prompts: customized.map((item) => ({
      prompt_id: item.id,
      prompt_version: item.version,
      content: item.current_content,
    })),
  };
}

function validatePackage(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) throw new Error('提示词配置包必须是 JSON 对象');
  if (bundle.kind !== 'prompt-package' || Number(bundle.schema_version) !== PACKAGE_SCHEMA_VERSION) {
    throw new Error('提示词配置包类型或版本不兼容');
  }
  if (!Array.isArray(bundle.prompts) || bundle.prompts.length > DEFINITIONS.length) throw new Error('提示词配置包内容无效');
  const seen = new Set();
  const items = bundle.prompts.map((entry) => {
    const id = String(entry?.prompt_id || '');
    const item = definition(id);
    if (seen.has(id)) throw new Error(`提示词配置包重复包含 ${id}`);
    seen.add(id);
    if (Number(entry.prompt_version) > Number(item.version)) throw new Error(`${id} 来自更新版本，当前程序不能安全导入`);
    return { prompt_id: id, content: validateTemplate(id, entry.content), prompt_version: Number(entry.prompt_version) || 1 };
  });
  return { items };
}

module.exports = {
  DEFINITIONS,
  LEGACY_KEY_MAP,
  PACKAGE_SCHEMA_VERSION,
  definition,
  exportPackage,
  list,
  renderTemplate,
  reset,
  resolve,
  resolveRuntime,
  set,
  sha256,
  validatePackage,
  validateTemplate,
};
