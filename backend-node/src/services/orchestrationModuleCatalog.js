const clone = (value) => JSON.parse(JSON.stringify(value));

function moduleContract(moduleId, versionTrack, phase, executor, status, description, inputs, outputs, sideEffects = {}) {
  return Object.freeze({
    module_id: moduleId,
    version: 1,
    version_track: versionTrack,
    phase,
    executor,
    availability: status,
    description,
    inputs,
    outputs,
    side_effects: {
      network: false,
      filesystem_write: false,
      database_write: true,
      external_write: false,
      paid: false,
      ...sideEffects,
    },
    idempotency: 'session_id + node_key; retries increment attempt without creating another logical node',
    unknown_input_policy: 'preserve_and_explain',
    recovery: 'read the persisted session, node, immutable events and latest receipt before continuing',
  });
}

const MODULES = Object.freeze([
  // V1 - orchestration foundation
  moduleContract('session.create', 'V1', 'intake', 'local', 'integrated', 'Create a durable Codex orchestration session.', ['user_goal', 'source_context'], ['session']),
  moduleContract('asset.scan', 'V1', 'intake', 'codex', 'bridge', 'Inspect user-authorized files or folders and persist a bounded inventory.', ['paths'], ['asset_inventory'], { filesystem_write: true }),
  moduleContract('asset.classify', 'V1', 'intake', 'codex', 'bridge', 'Classify assets by fact, authority and intended use without silently sending them to a model.', ['asset_inventory', 'user_goal'], ['asset_roles']),
  moduleContract('asset.bind', 'V1', 'plan', 'codex', 'bridge', 'Bind assets to product, character, scene, shot or timeline scopes.', ['asset_roles'], ['asset_bindings']),
  moduleContract('plan.propose', 'V1', 'plan', 'codex', 'integrated', 'Persist a revisable dynamic plan and its dependency graph.', ['goal', 'facts', 'module_candidates'], ['plan_revision']),
  moduleContract('plan.confirm', 'V1', 'plan', 'manual', 'integrated', 'Confirm the current plan without hiding earlier revisions.', ['plan_revision'], ['confirmed_plan']),
  moduleContract('node.run', 'V1', 'create', 'codex', 'integrated', 'Record that a selected executor has started a module node.', ['node'], ['progress']),
  moduleContract('node.retry', 'V1', 'create', 'manual', 'integrated', 'Retry one logical node with the same node key and a new attempt.', ['failed_node'], ['ready_node']),
  moduleContract('manual.override', 'V1', 'plan', 'manual', 'integrated', 'Let a user edit, skip, reopen or replace a planned node with an auditable event.', ['node', 'patch'], ['updated_node']),
  moduleContract('session.pause', 'V1', 'deliver', 'manual', 'integrated', 'Pause orchestration without deleting outputs or cancelling unrelated provider work.', ['session'], ['paused_session']),
  moduleContract('session.resume', 'V1', 'deliver', 'manual', 'integrated', 'Resume from durable state after reading the latest checkpoint.', ['session'], ['running_session']),
  moduleContract('session.checkpoint', 'V1', 'deliver', 'codex', 'integrated', 'Save a compact recovery checkpoint and event cursor.', ['session_state'], ['checkpoint']),
  moduleContract('session.readback', 'V1', 'deliver', 'codex', 'integrated', 'Read the authoritative session, nodes, receipts and events.', ['session_id'], ['session_bundle']),

  // V2 - research and creative reasoning; Codex performs research with its
  // available tools and records evidence here. The backend never scrapes by itself.
  moduleContract('research.request', 'V2', 'research', 'codex', 'bridge', 'Define a bounded research question, sources and stop condition.', ['research_goal'], ['research_brief'], { network: true }),
  moduleContract('research.record-source', 'V2', 'research', 'codex', 'integrated', 'Persist source URL, date, metrics and a non-copying summary.', ['source_evidence'], ['source_record']),
  moduleContract('research.extract-patterns', 'V2', 'research', 'codex', 'bridge', 'Extract reusable structural patterns without treating third-party media as licensed assets.', ['source_records'], ['patterns']),
  moduleContract('product.extract-facts', 'V2', 'research', 'codex', 'bridge', 'Separate product facts, claims, uncertainty and conflicts.', ['product_assets'], ['fact_sheet']),
  moduleContract('creative.generate-directions', 'V2', 'plan', 'codex', 'bridge', 'Generate several traceable creative directions from facts and research.', ['fact_sheet', 'patterns'], ['creative_directions']),
  moduleContract('shot.plan-grid', 'V2', 'plan', 'codex', 'bridge', 'Plan shots or a nine-grid movement board while preserving subject authority.', ['creative_direction', 'asset_bindings'], ['shot_plan']),
  moduleContract('copy.generate', 'V2', 'create', 'codex', 'bridge', 'Create script, voiceover, subtitles or CTA grounded in confirmed facts.', ['fact_sheet', 'creative_direction'], ['copy_assets']),
  moduleContract('qa.claim-trace', 'V2', 'qa', 'codex', 'bridge', 'Check that product claims, figures and citations trace back to evidence.', ['fact_sheet', 'deliverable'], ['qa_receipt']),

  // V3 - maps onto existing workflow/media capabilities. Codex chooses and
  // calls the concrete existing API, then records the returned artifact.
  moduleContract('video.import', 'V3', 'create', 'local', 'bridge', 'Import a user-owned video as a direct timeline clip.', ['video_asset', 'timeline_target'], ['direct_clip'], { filesystem_write: true }),
  moduleContract('video.trim', 'V3', 'edit', 'local', 'bridge', 'Trim a clip without regenerating it.', ['video_asset', 'time_range'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.concat', 'V3', 'edit', 'local', 'bridge', 'Concatenate compatible timeline clips.', ['video_assets'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.speed', 'V3', 'edit', 'local', 'bridge', 'Change clip speed with explicit audio policy.', ['video_asset', 'speed'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.color', 'V3', 'edit', 'local', 'bridge', 'Apply reversible color parameters or a saved preset.', ['video_asset', 'color_settings'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.audio', 'V3', 'edit', 'local', 'bridge', 'Mix, preserve, replace or duck audio tracks.', ['video_asset', 'audio_assets'], ['video_asset'], { filesystem_write: true }),
  moduleContract('subtitle.create', 'V3', 'edit', 'codex', 'bridge', 'Create timed subtitles and retain source text provenance.', ['copy_asset', 'timeline'], ['subtitle_asset'], { filesystem_write: true }),
  moduleContract('image.generate', 'V3', 'create', 'provider', 'bridge', 'Use the configured image provider through the existing workflow.', ['prompt', 'reference_assets'], ['image_asset'], { network: true, external_write: true, paid: true }),
  moduleContract('video.generate', 'V3', 'create', 'provider', 'bridge', 'Use the configured video provider through the existing idempotent workflow.', ['prompt', 'reference_bundle'], ['video_asset'], { network: true, external_write: true, paid: true }),
  moduleContract('video.timeline-assemble', 'V3', 'edit', 'local', 'bridge', 'Assemble imported and generated clips into one auditable timeline.', ['timeline_clips'], ['timeline_asset'], { filesystem_write: true }),
  moduleContract('deliver.export', 'V3', 'deliver', 'local', 'bridge', 'Export final media and its provenance package.', ['approved_timeline'], ['delivery_bundle'], { filesystem_write: true }),
  // The professional Blender line starts with a zero-side-effect capability
  // and smoke-plan bridge. Actual rendering is deliberately a later module
  // after the local Blender installation and artifact contracts are verified.
  moduleContract('director.blender-smoke', 'V3', 'create', 'local', 'bridge', 'Probe the local Blender installation and prepare a deterministic offline smoke plan without starting a process or creating media.', ['scene_document', 'request_key'], ['blender_capability', 'smoke_plan'], { filesystem_write: false, database_write: false }),
  moduleContract('director.blender-render', 'V3', 'create', 'local', 'integrated', 'Render a normalized director scene locally with Blender, export an editable project, sampled frames and a browser GLB proxy, then encode an optional reference preview without provider charges.', ['scene_document', 'request_key'], ['blend_project', 'rendered_frames', 'glb_preview', 'reference_video', 'render_manifest'], { filesystem_write: true, database_write: false }),

  // V4 - proposal/sandbox capabilities. Application remains a deliberate
  // Codex action with diff, tests, confirmation and rollback outside this API.
  moduleContract('provider.diagnose', 'V4', 'qa', 'codex', 'advisory', 'Diagnose a provider protocol from redacted evidence without paid probing.', ['provider_evidence'], ['diagnosis']),
  moduleContract('adapter.propose', 'V4', 'plan', 'codex', 'advisory', 'Propose a versioned provider adapter without applying it.', ['diagnosis'], ['patch_proposal']),
  moduleContract('adapter.test-sandbox', 'V4', 'qa', 'codex', 'advisory', 'Run fixtures and zero-side-effect protocol tests in an isolated checkout.', ['patch_proposal', 'fixtures'], ['test_receipt']),
  moduleContract('patch.propose', 'V4', 'plan', 'codex', 'advisory', 'Record a source patch proposal, scope and rollback anchor.', ['problem', 'evidence'], ['patch_proposal']),
  moduleContract('patch.test', 'V4', 'qa', 'codex', 'advisory', 'Record focused, full and adversarial test evidence for a patch.', ['patch_proposal'], ['test_receipt']),
  moduleContract('patch.apply', 'V4', 'deliver', 'manual', 'advisory', 'Apply an approved patch only after user confirmation and rollback preparation.', ['approved_patch', 'rollback_anchor'], ['applied_patch'], { filesystem_write: true, external_write: true }),
  moduleContract('module.register', 'V4', 'deliver', 'manual', 'advisory', 'Register an approved module contract without redefining unknown work as invalid.', ['module_contract'], ['module_registration'], { filesystem_write: true }),
  moduleContract('skill.export', 'V4', 'deliver', 'codex', 'integrated', 'Export the current orchestration contract and examples as a versioned Skill package.', ['module_contracts', 'usage_examples'], ['skill_bundle'], { filesystem_write: true }),
  moduleContract('session.replay', 'V4', 'qa', 'codex', 'integrated', 'Replay persisted decisions and receipts without re-executing paid side effects.', ['session_bundle'], ['replay_report']),
]);

const BY_ID = new Map(MODULES.map((item) => [item.module_id, item]));

function listModules(query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const track = String(query.version_track || '').trim().toUpperCase();
  const availability = String(query.availability || '').trim().toLowerCase();
  const items = MODULES.filter((item) => {
    if (track && item.version_track !== track) return false;
    if (availability && item.availability !== availability) return false;
    if (q && !`${item.module_id} ${item.description} ${item.phase}`.toLowerCase().includes(q)) return false;
    return true;
  });
  return { schema_version: 1, open_world: true, items: clone(items), total: items.length };
}

function getModule(moduleId) {
  return clone(BY_ID.get(String(moduleId || '').trim()) || null);
}

module.exports = { MODULES, getModule, listModules };
