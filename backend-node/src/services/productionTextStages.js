const { safeParseAIJSON } = require('../utils/safeJson');

function cleanText(value, max = 20000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function unwrapArray(parsed, keys) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  for (const key of keys) if (Array.isArray(parsed[key])) return parsed[key];
  return [];
}

function parseJson(raw, log) {
  if (raw && typeof raw === 'object') return raw;
  return safeParseAIJSON(String(raw || ''), log);
}

function normalizeScript(raw) {
  const text = cleanText(raw, 50000);
  if (text.length < 80) throw new Error('AI 返回的剧本过短，请调整故事要求后重试');
  return {
    text,
    format: 'screenplay_markdown',
    included: true,
    required_fields: ['text'],
  };
}

function normalizeResource(item, type, index) {
  const fallbackName = `${type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'} ${index + 1}`;
  const name = cleanText(item?.name || item?.title || item?.location || fallbackName, 100);
  const description = cleanText(item?.description || item?.appearance || item?.prompt || '', 4000);
  if (!name || !description) return null;
  const common = {
    ...item,
    type,
    name,
    description,
    visual_prompt: cleanText(item?.visual_prompt || item?.image_prompt || description, 4000),
    negative_prompt: cleanText(item?.negative_prompt || '', 1000),
    included: item?.included !== false,
    required_fields: ['name', 'description', 'visual_prompt'],
  };
  if (type === 'character') {
    common.role = cleanText(item?.role || '角色', 100);
    common.appearance = cleanText(item?.appearance || description, 4000);
    common.identity_anchors = Array.isArray(item?.identity_anchors)
      ? item.identity_anchors.map((value) => cleanText(value, 300)).filter(Boolean).slice(0, 12)
      : [];
    common.continuity_rules = cleanText(item?.continuity_rules || '', 2000);
  } else if (type === 'scene') {
    common.location = cleanText(item?.location || name, 200);
    common.time = cleanText(item?.time || item?.time_of_day || '', 100);
    common.spatial_anchors = Array.isArray(item?.spatial_anchors)
      ? item.spatial_anchors.map((value) => cleanText(value, 300)).filter(Boolean).slice(0, 12)
      : [];
  } else {
    common.category = cleanText(item?.category || item?.type_name || '关键道具', 100);
    common.continuity_rules = cleanText(item?.continuity_rules || '', 2000);
  }
  return common;
}

function normalizeResources(raw, log) {
  const parsed = parseJson(raw, log);
  const characters = unwrapArray(parsed, ['characters', 'roles']).map((item, index) => normalizeResource(item, 'character', index)).filter(Boolean);
  const scenes = unwrapArray(parsed, ['scenes', 'locations']).map((item, index) => normalizeResource(item, 'scene', index)).filter(Boolean);
  const props = unwrapArray(parsed, ['props', 'objects']).map((item, index) => normalizeResource(item, 'prop', index)).filter(Boolean);
  if (!characters.length) throw new Error('资源提取结果缺少角色');
  if (!scenes.length) throw new Error('资源提取结果缺少场景');
  return { characters, scenes, props };
}

const TRANSITION_MODES = new Set(['opening', 'hard_cut', 'reference_continuation', 'strict_continuation']);

function defaultBoundaryPrompt(mode, fields = {}) {
  if (mode === 'opening') {
    return `这是成片的开场镜头，从独立完整的开场构图开始。入镜状态：${fields.cut_in || '按本镜头设定建立人物、场景和道具'}。`;
  }
  if (mode === 'strict_continuation') {
    return `这是同一摄影镜头的严格续拍。生成画面的第一帧必须逐像素承接指定首帧；从${fields.cut_in || '上一段最后状态'}继续同一动作和同一运镜，结束于${fields.cut_out || '本镜头规定的出镜状态'}。`;
  }
  if (mode === 'reference_continuation') {
    return `这是使用上一镜最终帧作普通参考图的连续画面。参考图用于尽量保持角色、场景、道具和构图状态，但不是像素级严格首帧。入镜状态：${fields.cut_in || '从上一镜已完成的出镜状态建立本镜头'}；本镜结束于${fields.cut_out || '本镜头规定的稳定出镜状态'}。`;
  }
  return `这是一次明确硬切后的新摄影镜头，不得延续上一段尚未完成的运镜或动作。切镜依据：${fields.cut_motivation || '上一镜头完整结束后切换到新的独立机位'}。切入状态：${fields.cut_in || '按本镜头设定重新建立构图'}。`;
}

function normalizeShot(item, index, options = {}) {
  const number = Math.max(1, Number(item?.number || item?.shot_number || index + 1));
  const title = cleanText(item?.title || `镜头 ${number}`, 120);
  const action = cleanText(item?.action || item?.description || '', 4000);
  const visual = cleanText(item?.visual || item?.composition || item?.layout_description || '', 4000);
  const videoPrompt = cleanText(item?.video_prompt || [visual, action].filter(Boolean).join('。'), 6000);
  if (!action || !visual || !videoPrompt) return null;
  const durationMin = Math.max(5, Number(options.duration_min) || 5);
  const durationMax = Math.max(durationMin, Number(options.duration_max) || 15);
  const duration = Math.max(durationMin, Math.min(durationMax, Math.round(Number(item?.duration) || 5)));
  const requestedProfile = ['short_image_guided', 'long_previs_guided'].includes(item?.route_profile)
    ? item.route_profile
    : null;
  const routeProfile = requestedProfile || (duration <= 5 ? 'short_image_guided' : 'long_previs_guided');
  const continuityIn = cleanText(item?.continuity_in || '', 2000);
  const continuityOut = cleanText(item?.continuity_out || '', 2000);
  const requestedMode = TRANSITION_MODES.has(item?.transition_mode) ? item.transition_mode : null;
  let transitionMode = requestedMode || (number === 1 ? 'opening' : 'hard_cut');
  if (number === 1) transitionMode = 'opening';
  if (transitionMode === 'strict_continuation' && options.strict_first_frame_supported !== true) {
    transitionMode = 'reference_continuation';
  }
  const cutIn = cleanText(item?.cut_in || continuityIn || (number === 1 ? '建立本片开场状态' : '从新的独立机位建立本镜头状态'), 2000);
  const cutOut = cleanText(item?.cut_out || continuityOut || '本镜头动作完整结束并形成可剪辑的稳定状态', 2000);
  const cutMotivation = transitionMode === 'hard_cut'
    ? cleanText(item?.cut_motivation || '上一镜头在完整动作或明确视觉变化上结束，本镜头切换到新的独立机位', 2000)
    : '';
  const continuousTakeId = transitionMode === 'strict_continuation'
    ? cleanText(item?.continuous_take_id || `continuous-take-${Math.max(1, number - 1)}-${number}`, 200)
    : '';
  const boundaryPrompt = cleanText(item?.boundary_prompt || defaultBoundaryPrompt(transitionMode, {
    cut_in: cutIn,
    cut_out: cutOut,
    cut_motivation: cutMotivation,
  }), 3000);
  const requiredFields = ['title', 'action', 'visual', 'video_prompt', 'route_profile', 'transition_mode', 'cut_in', 'cut_out', 'boundary_prompt'];
  if (transitionMode === 'hard_cut') requiredFields.push('cut_motivation');
  if (transitionMode === 'strict_continuation') requiredFields.push('continuous_take_id');
  return {
    ...item,
    number,
    title,
    duration,
    action,
    visual,
    dialogue: cleanText(item?.dialogue || '', 3000),
    narration: cleanText(item?.narration || '', 3000),
    shot_type: cleanText(item?.shot_type || '中景', 100),
    camera_angle: cleanText(item?.camera_angle || item?.angle || '平视', 100),
    camera_movement: cleanText(item?.camera_movement || item?.movement || '缓慢推进', 200),
    lighting: cleanText(item?.lighting || '', 1000),
    continuity_in: continuityIn,
    continuity_out: continuityOut,
    transition_mode: transitionMode,
    route_profile: routeProfile,
    previs_mode: ['auto', 'force', 'skip'].includes(item?.previs_mode) ? item.previs_mode : 'auto',
    cut_motivation: cutMotivation,
    cut_in: cutIn,
    cut_out: cutOut,
    continuous_take_id: continuousTakeId,
    boundary_prompt: boundaryPrompt,
    character_names: Array.isArray(item?.character_names || item?.characters)
      ? (item.character_names || item.characters).map((value) => cleanText(typeof value === 'object' ? value.name : value, 100)).filter(Boolean)
      : [],
    scene_name: cleanText(item?.scene_name || item?.scene || '', 200),
    prop_names: Array.isArray(item?.prop_names || item?.props)
      ? (item.prop_names || item.props).map((value) => cleanText(typeof value === 'object' ? value.name : value, 100)).filter(Boolean)
      : [],
    image_prompt: cleanText(item?.image_prompt || [visual, action].filter(Boolean).join('。'), 5000),
    video_prompt: videoPrompt,
    included: item?.included !== false,
    required_fields: requiredFields,
  };
}

function normalizeShots(raw, log, maxShots = 12, options = {}) {
  const parsed = parseJson(raw, log);
  const shots = unwrapArray(parsed, ['shots', 'storyboards', 'scenes'])
    .map((item, index) => normalizeShot(item, index, options))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxShots) || 12));
  if (!shots.length) throw new Error('分镜结果为空或缺少动作/构图');
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
  return { shots, total_duration: total };
}

function scriptPrompts(source, policy = {}) {
  const targetShots = Math.max(1, Number(policy.target_shots) || 3);
  const style = cleanText(policy.style || policy.visual_style || '电影感科幻写实', 300);
  return {
    system: `你是拥有创作决策权的专业短片编剧。把用户输入视为创作简报，而不是等待用户补完的问卷。用户明确给出的角色、世界观、情节、风格、时长和禁区是必须遵守的硬约束；对于用户没有指定的姓名、关系、场景细节、冲突、动作、对白、转折和结局，你必须主动做出一致、合理、可拍摄的创作选择，不能回答“用户未指定”、不能把普通创作决定退回给用户，也不要要求补充非必要信息。输入很简略或只要求你自行创作时，应直接构思一个完整短片。\n必须包含：片名、人物表、场景表，以及按场次书写的环境、动作、对白和必要旁白。重点保证因果清晰、角色动机明确、视觉动作可拍摄、前后连续，并控制在目标镜头规模内。不要输出 JSON，不要解释创作过程。`,
    user: `请根据以下创作简报完成约 ${targetShots} 个镜头规模的短片剧本。视觉风格：${style}。明确要求必须保留；未指定的创作要素由你直接决定并写完整。\n\n创作简报：\n${cleanText(source, 45000)}`,
  };
}

function resourcePrompts(scriptText, policy = {}) {
  const style = cleanText(policy.style || policy.visual_style || '电影感科幻写实', 300);
  return {
    system: `你是影视前期资产总监。阅读剧本并抽取真正需要保持一致性的角色、场景、关键道具。只返回 JSON 对象，不要 Markdown。\n结构：{"characters":[...],"scenes":[...],"props":[...]}。\n每个角色必须有 name, role, description, appearance, identity_anchors(数组), continuity_rules, visual_prompt, negative_prompt。\n每个场景必须有 name, location, time, description, spatial_anchors(数组), visual_prompt, negative_prompt。\n每个道具必须有 name, category, description, continuity_rules, visual_prompt, negative_prompt。\n描述必须具体、可见、可用于一致性生图，不要用空泛形容词。`,
    user: `视觉风格：${style}\n请抽取并设计以下剧本所需资产：\n\n${cleanText(scriptText, 45000)}`,
  };
}

function storyboardPrompts(scriptText, resources, policy = {}) {
  const targetShots = Math.max(1, Number(policy.target_shots) || 3);
  const maxSeconds = Math.max(5, Number(policy.max_total_seconds || policy.total_seconds || 60));
  const minShotSeconds = Math.max(5, Number(policy.video_duration_min) || 5);
  const strictSupported = policy.strict_first_frame_supported === true;
  const transitionRule = strictSupported
    ? '默认使用 hard_cut。只有同一画面状态确实需要连续时才使用 reference_continuation；只有必须像素级承接且会提供严格首帧时才使用 strict_continuation。'
    : '默认使用 hard_cut。需要连续画面时可使用 reference_continuation，把上一镜尾帧作为普通参考图；当前模型不支持 strict_continuation。';
  return {
    system: `你是电影导演和分镜师。只返回 JSON 对象，不要 Markdown。结构：{"shots":[...]}。\n每个生成视频必须对应一个完整摄影镜头；同一次运镜、同一个尚未完成的物理动作不得拆到两个视频请求中。需要拆分时，必须把边界安排在真实镜头切换处。\n每个镜头必须包含 number,title,duration(${minShotSeconds}到15秒),route_profile,previs_mode,action,visual,dialogue,narration,shot_type,camera_angle,camera_movement,lighting,continuity_in,continuity_out,transition_mode,cut_motivation,cut_in,cut_out,continuous_take_id,boundary_prompt,character_names,scene_name,prop_names,image_prompt,video_prompt。\n第一镜 transition_mode 必须是 opening。${transitionRule}\n即梦片段只允许 5到15 秒；紧凑五秒镜头只承载一个完整视觉节拍，连续长镜头才承载同一机位内的完整连续动作，不得为了凑时长填充无意义动作。\nhard_cut 只需要记录剪辑依据，不要制造任何遮挡、闪光、烟雾、甩镜或其它转场效果来掩盖切换。切镜依据应是信息变化、反应、视线关系、动作节拍完成或有意义的景别/角度变化；前镜动作在 cut_out 前完整结束，后镜从独立新机位和 cut_in 状态开始。\nvideo_prompt 要按时间顺序写清主体动作、镜头运动、场景不变量和结尾状态；boundary_prompt 要明确这是开场、自然硬切后的新镜头、携带上一镜尾帧作普通参考图的续接，还是严格首帧续拍。route_profile 只能依据镜头是紧凑五秒节拍还是需要更长的连续动作填写 short_image_guided 或 long_previs_guided，不能填写模型名。`,
    user: `请把剧本拆成约 ${targetShots} 个完整摄影镜头，总时长不要超过 ${maxSeconds} 秒。必须复用资产表中的名称。每个镜头时长为 5到15 秒，并在自身时长内完成一个有意义的摄影节拍。每个镜头都要在自身时长内完成动作并形成可剪辑的结尾，不要把一个动作或一次运镜悬在两个视频之间。正常镜头之间直接硬切，不要为了衔接添加金光、主体遮挡、爪子遮挡等刻意效果；只有画面状态确实需要尽量连续时才选择尾帧参考续接。\n\n剧本：\n${cleanText(scriptText, 40000)}\n\n已审批资产：\n${JSON.stringify(resources).slice(0, 30000)}`,
  };
}

function shotContinuityRevisionPrompts(input) {
  const strictSupported = input.strict_first_frame_supported === true;
  return {
    system: `You are a continuity editor revising one rough shot after the previous shot has been formally approved.
Return one strict JSON object with shape {"shot":{...}} and no Markdown.
The shot must contain number,title,duration,route_profile,previs_mode,action,visual,dialogue,narration,shot_type,camera_angle,camera_movement,lighting,continuity_in,continuity_out,transition_mode,cut_motivation,cut_in,cut_out,continuous_take_id,boundary_prompt,character_names,scene_name,prop_names,image_prompt,video_prompt.
Treat the approved predecessor artifact, its exit-state plan, and review evidence as authoritative handoff facts. Do not claim to observe pixels that are not described in the evidence. Preserve the story objective and immutable asset identities, but revise staging, entry state, timing, composition, and camera language to create a truthful editorial boundary.
Every generated clip must be one complete camera shot. Never split one camera move or an unfinished physical action across requests.
${strictSupported ? 'Default to hard_cut. Use reference_continuation for best-effort state matching. Use strict_continuation only when the same camera take is essential and the exact predecessor tail frame will be supplied as first_frame.' : 'The selected video model has no strict first_frame role. Use hard_cut for a new setup or reference_continuation when the predecessor tail should be sent as an ordinary image reference. Never claim pixel-exact continuation.'}`,
    user: `Previous approved shot plan:\n${JSON.stringify(input.previous_shot || {}).slice(0, 16000)}

Approved predecessor video artifact and validation:\n${JSON.stringify(input.previous_video || {}).slice(0, 12000)}

Approval evidence:\n${JSON.stringify(input.approval_evidence || []).slice(0, 12000)}

Current rough next-shot plan:\n${JSON.stringify(input.rough_shot || {}).slice(0, 16000)}

Immutable approved assets:\n${JSON.stringify(input.assets || []).slice(0, 20000)}

Revise exactly this next shot. Keep its shot number and duration within 5 to 15 seconds. Use a compact five-second image-guided shot for a reaction or angle change, and a longer shot only for one complete continuous action. Make continuity_in an explicit story-state handoff, complete all action inside this clip, and keep image_prompt/video_prompt directly production-ready. Do not add a visual transition effect merely to hide the cut.`,
  };
}

function normalizeShotRevision(raw, log, expectedNumber, options = {}) {
  const parsed = parseJson(raw, log);
  const candidate = parsed?.shot && typeof parsed.shot === 'object'
    ? { ...parsed.shot, number: expectedNumber }
    : parsed;
  const normalized = normalizeShots(
    candidate?.shot ? { shots: [{ ...candidate.shot, number: expectedNumber }] }
      : Array.isArray(candidate?.shots) ? { shots: [{ ...candidate.shots[0], number: expectedNumber }] }
        : { shots: [{ ...(candidate || {}), number: expectedNumber }] },
    log,
    1,
    options
  );
  return normalized.shots[0];
}

function shotRevisionPrompts(input = {}) {
  return {
    system: 'You are a film continuity editor revising one production shot from a user instruction. Preserve explicit story facts, approved identities, scene geometry, props, timing constraints, and honest editorial boundaries. Return one production-ready shot.',
    user: `User revision request:\n${cleanText(input.instruction, 4000)}

Current shot:\n${JSON.stringify(input.shot || {}).slice(0, 18000)}

Previous planned shot:\n${JSON.stringify(input.previous_shot || null).slice(0, 8000)}

Next planned shot:\n${JSON.stringify(input.next_shot || null).slice(0, 8000)}

Approved assets:\n${JSON.stringify(input.assets || []).slice(0, 20000)}

Rewrite exactly one complete camera shot. Keep the same shot number, finish the action inside this clip, and keep duration within ${Number(input.duration_min) || 5} to ${Number(input.duration_max) || 15} seconds. Do not add a transition effect merely to hide a cut.`,
  };
}

function shotSplitPrompts(input = {}) {
  return {
    system: 'You are a film editor splitting one overloaded production shot into two independent camera shots at a real editorial cut. Preserve explicit story facts and approved asset identities.',
    user: `User split request:\n${cleanText(input.instruction, 4000)}

Shot to split:\n${JSON.stringify(input.shot || {}).slice(0, 18000)}

Previous planned shot:\n${JSON.stringify(input.previous_shot || null).slice(0, 8000)}

Following planned shot:\n${JSON.stringify(input.next_shot || null).slice(0, 8000)}

Approved assets:\n${JSON.stringify(input.assets || []).slice(0, 20000)}

Return two complete camera shots. The first keeps number ${input.current_number}; the inserted second uses number ${input.next_number}. Each must last ${Number(input.duration_min) || 5} to ${Number(input.duration_max) || 15} seconds and end in a stable editable state. Put the split at action completion, reaction, information change, eyeline, or a meaningful shot-size/angle change. Use a normal hard cut unless continuity genuinely requires an ordinary tail-frame reference.`,
  };
}

function shotPickupPrompts(input = {}) {
  return {
    system: 'You are a film director adding one purposeful pickup shot to an existing sequence. Preserve approved asset identities and build an honest cut-in and cut-out.',
    user: `User pickup request:\n${cleanText(input.instruction, 4000)}

Previous planned shot:\n${JSON.stringify(input.previous_shot || null).slice(0, 12000)}

Following planned shot:\n${JSON.stringify(input.next_shot || null).slice(0, 12000)}

Screenplay context:\n${cleanText(input.script, 20000)}

Approved assets:\n${JSON.stringify(input.assets || []).slice(0, 20000)}

Create one new complete camera shot numbered ${input.number}. It must add clear narrative value rather than duplicate adjacent coverage, last ${Number(input.duration_min) || 5} to ${Number(input.duration_max) || 15} seconds, and form a normal editable cut boundary.`,
  };
}

function normalizeShotSplit(raw, log, currentNumber, nextNumber, options = {}) {
  const parsed = parseJson(raw, log);
  const current = normalizeShotRevision(
    { shot: parsed?.current_shot || parsed?.first_shot || parsed?.shots?.[0] },
    log,
    currentNumber,
    options
  );
  const next = normalizeShotRevision(
    { shot: parsed?.next_shot || parsed?.second_shot || parsed?.shots?.[1] },
    log,
    nextNumber,
    options
  );
  if (!current || !next) throw new Error('镜头拆分结果必须包含两个完整镜头');
  return { current_shot: current, next_shot: next };
}

function recoverShotRevisionFromApprovedRough(roughShot, previousShot, options = {}) {
  const expectedNumber = Math.max(1, Number(roughShot?.number || options.expected_number) || 1);
  const strictSupported = options.strict_first_frame_supported === true;
  const requestedMode = TRANSITION_MODES.has(roughShot?.transition_mode)
    ? roughShot.transition_mode
    : (expectedNumber === 1 ? 'opening' : 'hard_cut');
  const transitionMode = requestedMode === 'strict_continuation' && !strictSupported
    ? 'reference_continuation'
    : requestedMode;
  const previousExit = cleanText(
    previousShot?.cut_out || previousShot?.continuity_out || '上一镜头的叙事动作已经完整结束',
    1200
  );
  const sceneEntry = cleanText(
    roughShot?.cut_in || roughShot?.continuity_in || roughShot?.scene_name || '本镜头设定的独立画面状态',
    1200
  );
  const continuityIn = transitionMode === 'hard_cut'
    ? cleanText(`叙事状态承接：${previousExit}。画面在剪辑点硬切，从新的独立机位建立：${sceneEntry}。`, 2000)
    : cleanText(roughShot?.continuity_in || previousExit, 2000);
  const cutMotivation = transitionMode === 'hard_cut'
    ? cleanText(
      roughShot?.cut_motivation || '上一镜头动作完整结束后，切换到新的场景、景别或信息视角',
      2000
    )
    : '';
  const normalized = normalizeShot({
    ...roughShot,
    number: expectedNumber,
    transition_mode: transitionMode,
    continuity_in: continuityIn,
    cut_in: sceneEntry,
    cut_motivation: cutMotivation,
    continuous_take_id: transitionMode === 'strict_continuation'
      ? roughShot?.continuous_take_id
      : '',
    boundary_prompt: transitionMode === 'hard_cut'
      ? `${defaultBoundaryPrompt('hard_cut', {
        cut_in: sceneEntry,
        cut_out: roughShot?.cut_out || roughShot?.continuity_out,
        cut_motivation: cutMotivation,
      })} 不使用上一段视频尾帧，不继承上一段运镜、构图或场景像素。`
      : roughShot?.boundary_prompt,
  }, 0, {
    duration_min: options.duration_min,
    duration_max: options.duration_max,
    strict_first_frame_supported: strictSupported,
  });
  if (!normalized) throw new Error('已确认粗分镜缺少动作或构图，不能进行本地恢复');
  return normalized;
}

function videoRetryPlannerPrompts(shot, evidence = []) {
  return {
    system: `You are the continuity editor who prepares a corrected prompt for an AI video model.
Return one strict JSON object and no Markdown. Required shape:
{"failure_memory":[{"review_id":1,"observed_failure":"...","violated_constraint":"...","required_state":"..."}],"provider_prompt":"..."}
Treat rejected results as diagnostic examples for your own planning. Do not copy them into a negative-prompt list.
Convert every creative failure into a concrete positive state, placement, timing, or motion instruction.
The provider_prompt must be chronological, directly filmable, concise, and self-contained. Preserve the approved identity, location, named assets, camera intent, duration, entry state, exit state, transition_mode, and boundary_prompt.
For hard_cut, never say "continue the exact prior frame" or continue an unfinished prior camera move. Begin after the approved visible cut from the independent cut_in composition. For reference_continuation, treat the predecessor tail as an ordinary image reference and never promise pixel-exact matching. For strict_continuation, preserve the exact supplied first-frame requirement.`,
    user: `Approved shot object:\n${JSON.stringify(shot).slice(0, 30000)}\n\nRejected-result evidence, oldest first:\n${JSON.stringify(evidence).slice(0, 30000)}\n\nRewrite the video prompt so the desired state is explicit at the exact time each prior failure occurred.`,
  };
}

function normalizeVideoRetryPlan(raw, log) {
  const parsed = parseJson(raw, log);
  const providerPrompt = cleanText(parsed?.provider_prompt || parsed?.revised_video_prompt || '', 12000);
  if (providerPrompt.length < 40) throw new Error('Video retry planner returned an empty or unusable provider prompt');
  const failureMemory = Array.isArray(parsed?.failure_memory)
    ? parsed.failure_memory.map((item) => ({
      review_id: Number(item?.review_id) || null,
      observed_failure: cleanText(item?.observed_failure || '', 1000),
      violated_constraint: cleanText(item?.violated_constraint || '', 1000),
      required_state: cleanText(item?.required_state || item?.positive_correction || '', 2000),
    })).filter((item) => item.observed_failure && item.violated_constraint && item.required_state).slice(0, 20)
    : [];
  if (!failureMemory.length) throw new Error('Video retry planner did not return structured failure memory');
  return { failure_memory: failureMemory, provider_prompt: providerPrompt };
}

function fieldAssistPrompts(input) {
  const field = cleanText(input.field_key || input.field || 'text', 100);
  const instruction = cleanText(input.instruction || '优化表达，使内容更具体并可直接使用', 1000);
  const current = cleanText(input.current_value || '', 10000);
  const context = JSON.stringify(input.context || {}).slice(0, 20000);
  const constraint = cleanText(input.constraints || '', 1000);
  return {
    system: `你是影视制作工作流中的字段级写作助手。你只负责当前字段，不得修改其他字段，不得输出解释、标题、Markdown 围栏或 JSON 包装。保留用户已经明确的事实和专有名称。`,
    user: `字段：${field}\n用户引导：${instruction}\n格式或长度约束：${constraint || '沿用当前字段的语言和体例'}\n当前内容：\n${current || '（空）'}\n\n上下文：\n${context}\n\n请只输出可直接填入该字段的新内容。`,
  };
}

function reviewPrompts(artifact, profile = {}) {
  const skills = Array.isArray(profile.skills) ? profile.skills.join('\n') : cleanText(profile.skills || '', 4000);
  const priorReviews = Array.isArray(profile.previous_reviews)
    ? profile.previous_reviews.slice(0, 6).map((item) => ({
      decision: cleanText(item?.decision || '', 40),
      reason: cleanText(item?.reason || '', 1200),
      scores: item?.scores && typeof item.scores === 'object' ? item.scores : {},
    }))
    : [];
  return {
    system: `你是务实的影视制作质量审批员，目标是让项目可靠推进，而不是追求无限润色。只返回 JSON：{"decision":"approved|rejected|needs_human","reason":"...","confidence":0到1,"severity":"minor|major|critical","blocking_issues":["..."],"improvement_notes":["..."],"requires_human_authority":false,"scores":{"clarity":0到100,"continuity":0到100,"production_ready":0到100}}。\n先区分阻断问题与改进建议。只有违反用户明确约束、故事因果或角色/场景连续性明显错误、缺少后续制作必需字段、内容不可生成或媒体证据出现明确严重错误，才是 blocking issue。措辞、可选细节、主观审美和后续可完善的轻微问题只能写入 improvement_notes。没有阻断问题就必须 approved；存在可由 AI 修复的阻断问题时 rejected，并合并给出一次具体修改意见。只有必须由人提供授权、预算、凭据、不可推断的必要事实或外部核对时才可 needs_human，且 requires_human_authority=true。不确定或低置信度本身不等于需要人工。复审只检查旧阻断是否解决及是否出现严重回归，不得移动标准。`,
    user: `审批标准：${cleanText(profile.prompt || profile.criteria || '满足明确约束、因果与连续性成立、具备进入下一制作阶段的必要信息', 4000)}\n评审技能/检查清单：${skills || '使用默认影视连续性与可制作性检查'}\n先前审核记录（复审时不得新增非阻断门槛）：${JSON.stringify(priorReviews).slice(0, 8000)}\n阶段：${artifact.stage}\n标题：${artifact.title || ''}\n内容：${JSON.stringify(artifact.content).slice(0, 30000)}`,
  };
}

function normalizeReview(raw, log) {
  const parsed = parseJson(raw, log);
  let decision = ['approved', 'rejected', 'needs_human'].includes(parsed?.decision)
    ? parsed.decision
    : 'needs_human';
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
  const severity = ['minor', 'major', 'critical'].includes(parsed?.severity) ? parsed.severity : 'major';
  const blockingIssues = Array.isArray(parsed?.blocking_issues)
    ? parsed.blocking_issues.map((item) => cleanText(item, 1200)).filter(Boolean).slice(0, 12)
    : [];
  const improvementNotes = Array.isArray(parsed?.improvement_notes)
    ? parsed.improvement_notes.map((item) => cleanText(item, 1200)).filter(Boolean).slice(0, 12)
    : [];
  const requiresHumanAuthority = parsed?.requires_human_authority === true;
  if (decision === 'needs_human' && !requiresHumanAuthority) decision = blockingIssues.length ? 'rejected' : 'approved';
  if (decision === 'rejected' && !blockingIssues.length && severity === 'minor') decision = 'approved';
  if (decision === 'approved') blockingIssues.length = 0;
  return {
    decision,
    reason: cleanText(parsed?.reason || (decision === 'approved' ? '符合审批标准' : 'AI 未给出充分理由'), 4000),
    confidence,
    severity,
    blocking_issues: blockingIssues,
    improvement_notes: improvementNotes,
    requires_human_authority: decision === 'needs_human' && requiresHumanAuthority,
    scores: parsed?.scores && typeof parsed.scores === 'object' ? parsed.scores : {},
  };
}

module.exports = {
  cleanText,
  normalizeScript,
  normalizeResources,
  normalizeShots,
  normalizeShotRevision,
  normalizeShotSplit,
  normalizeReview,
  scriptPrompts,
  resourcePrompts,
  storyboardPrompts,
  shotRevisionPrompts,
  shotSplitPrompts,
  shotPickupPrompts,
  shotContinuityRevisionPrompts,
  recoverShotRevisionFromApprovedRough,
  videoRetryPlannerPrompts,
  normalizeVideoRetryPlan,
  fieldAssistPrompts,
  reviewPrompts,
};
