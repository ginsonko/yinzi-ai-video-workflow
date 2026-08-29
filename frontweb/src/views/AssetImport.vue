<template>
  <div class="page">
    <header class="hero"><div><p class="eyebrow">V0.4 · 智能资产导入</p><h1>把现有素材无痛接入工作流</h1><p class="sub">选择文件夹或多个文件，先由 AI 整理成可审核计划；确认后才写入项目，随时可回滚。</p></div><el-button @click="$router.push('/')">返回项目</el-button></header>
    <el-card class="card" shadow="never"><div class="form-row"><el-input v-model="sourceLabel" placeholder="来源备注（例如：第一季素材）" /><el-input v-model="targetRunId" placeholder="目标制作任务 ID（可稍后填写）" /><el-button type="primary" @click="create">创建导入会话</el-button></div><input ref="fileInput" type="file" multiple webkitdirectory directory hidden @change="onFiles"><div class="choose-row"><el-button class="choose" @click="fileInput?.click()">选择文件夹 / 多个文件</el-button><el-switch v-model="useAiClassifier" active-text="使用 AI 理解图片/视频/文本" inactive-text="仅本地规则（不调用模型）" /></div><span class="hint">支持 txt、md、docx、pdf、json、csv、图片、视频、音频；AI 分类只有开启后才调用，确认前不会写入项目。</span><div v-if="recentSessions.length" class="recent-imports"><span class="recent-label">可继续的导入会话</span><el-button v-for="item in recentSessions" :key="item.id" link type="primary" @click="resume(item)">{{ item.source_label || item.id.slice(0, 8) }} · {{ statusText(item.status) }}</el-button></div></el-card>
    <el-card v-if="session" class="card" shadow="never">
      <div class="card-head"><div><h2>导入会话 {{ session.id.slice(0, 8) }}</h2><el-tag :type="statusType">{{ statusLabel }}</el-tag><small class="revision">计划版本 {{ session.version }}</small></div><div class="actions"><el-button :loading="scanning" :disabled="!files.length" @click="scan">重新分析</el-button><el-button :loading="savingPlan" :disabled="session.status !== 'planned' || !items.length" @click="savePlanEdits">保存计划修改</el-button><el-button type="primary" :disabled="session.status !== 'planned'" @click="apply">确认导入</el-button><el-button type="danger" plain :disabled="session.status !== 'applied'" @click="rollback">回滚</el-button></div></div>
      <el-alert v-if="error" :title="error" type="error" show-icon />
      <div v-if="plan.summary" class="stats"><span>文件 {{ plan.summary.total }}</span><span>可导入 {{ plan.summary.ready }}</span><span>待处理 {{ plan.summary.partial + plan.summary.unknown }}</span><span>已排除 {{ plan.summary.excluded || 0 }}</span><span>冲突 {{ plan.conflicts?.length || 0 }}</span></div>
      <div v-if="plan.conflicts?.length" class="reorganize-row"><el-input v-model="reorganizeReason" placeholder="告诉 AI 如何处理冲突，例如：保留最新版本，旧版本作为候选" /><el-button :loading="reorganizing" @click="reorganize">让 AI 重新整理</el-button></div>
      <el-table :data="items" stripe>
        <el-table-column prop="relative_path" label="文件" min-width="220" show-overflow-tooltip />
        <el-table-column label="识别类型" width="150"><template #default="{ row }"><el-select v-model="row.detected_type" size="small" filterable allow-create><el-option v-for="type in editableTypes" :key="type" :label="typeLabel(type)" :value="type" /></el-select></template></el-table-column>
        <el-table-column label="拟放入阶段" width="165"><template #default="{ row }"><el-select v-model="row.candidate_stage" size="small" clearable filterable placeholder="不导入"><el-option v-for="stage in editableStages" :key="stage" :label="stageLabel(stage)" :value="stage" /></el-select></template></el-table-column>
        <el-table-column label="作用域" width="185"><template #default="{ row }"><div class="scope-cell"><el-select v-model="row.candidate_scope_type" size="small"><el-option v-for="scope in editableScopes" :key="scope" :label="scopeLabel(scope)" :value="scope" /></el-select><el-input v-model="row.candidate_scope_id" size="small" placeholder="对象 ID" /></div></template></el-table-column>
        <el-table-column label="置信度" width="100"><template #default="{ row }">{{ row.confidence == null ? '—' : `${Math.round(row.confidence * 100)}%` }}</template></el-table-column>
        <el-table-column label="导入" width="72"><template #default="{ row }"><el-switch :model-value="row.status !== 'excluded'" @update:model-value="value => row.status = value ? (row.error_code ? 'partial' : 'ready') : 'excluded'" /></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag size="small" :type="itemStatusType(row.status)">{{ itemStatusLabel(row) }}</el-tag></template></el-table-column>
        <el-table-column label="判断依据" min-width="210" show-overflow-tooltip><template #default="{ row }">{{ evidenceLabel(row) }}</template></el-table-column>
      </el-table>
      <el-alert v-if="plan.conflicts?.length" class="conflicts" title="存在需要你确认的冲突；系统不会静默覆盖" type="warning" show-icon :description="plan.conflicts.map(c => `${c.type}: ${c.paths?.join('、') || c.target}`).join('；')" />
    </el-card>
  </div>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assetImportAPI } from '@/api/assetImport'
const fileInput = ref(); const sourceLabel = ref(''); const targetRunId = ref(''); const files = ref([]); const session = ref(null); const plan = ref({}); const items = ref([]); const scanning = ref(false); const savingPlan = ref(false); const error = ref(''); const recentSessions = ref([]); const reorganizeReason = ref(''); const reorganizing = ref(false); const useAiClassifier = ref(false)
const editableTypes = ['script', 'storyboard', 'character', 'scene', 'prop', 'asset_text', 'image', 'video', 'audio', 'director_preview', 'shot_video', 'final_edit', 'unknown']
const editableStages = ['script', 'asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit']
const editableScopes = ['run', 'resource', 'shot']
const typeLabel = (value) => ({ script: '剧本', storyboard: '分镜稿', character: '角色', scene: '场景', prop: '道具', asset_text: '资源文本', image: '图片', video: '视频', audio: '音频', director_preview: '导演台预演', shot_video: '分镜视频', final_edit: '成片/音频', unknown: '未识别' }[value] || value)
const stageLabel = (value) => ({ script: '剧本', asset_text: '资源设定', asset_images: '资源图', storyboard_plan: '分镜脚本', storyboard_images: '分镜图', director_preview: '3D 导演台', shot_video: '分镜视频', final_edit: '最终剪辑' }[value] || value)
const scopeLabel = (value) => ({ run: '项目', resource: '资源对象', shot: '镜头' }[value] || value)
const itemStatusLabel = (row) => row.status === 'excluded' ? '已排除' : row.status === 'partial' ? `部分可用${row.error_message ? `：${row.error_message}` : ''}` : row.status === 'failed' ? '解析失败' : row.candidate_stage ? '可导入' : '待指定阶段'
const itemStatusType = (value) => ({ ready: 'success', partial: 'warning', failed: 'danger', excluded: 'info' }[value] || 'info')
const evidenceLabel = (row) => { const source = row.evidence?.source === 'multimodal_ai' ? `AI（${row.evidence.model || 'gpt-5.6-sol'}）` : row.evidence?.source === 'local_rules' ? '本地规则' : row.evidence?.source === 'extension_and_metadata' ? '扩展名和元数据' : row.evidence?.source || '—'; return row.error_message ? `${source}；${row.error_message}` : source }
const statusLabel = computed(() => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[session.value?.status] || session.value?.status || ''))
const statusType = computed(() => ({ planned: 'warning', applied: 'success', rolled_back: 'info' }[session.value?.status] || 'info'))
const statusText = (value) => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[value] || value)
function onFiles(event) { files.value = [...(event.target.files || [])].map(file => ({ file, relative_path: file.webkitRelativePath || file.name, name: file.name })) }
async function create() { error.value = ''; try { const res = await assetImportAPI.create({ source_label: sourceLabel.value, target_run_id: targetRunId.value || null }); session.value = res.data || res; ElMessage.success('导入会话已创建') } catch (e) { error.value = e.message } }
async function loadSessions() { try { const res = await assetImportAPI.list({ page_size: 20 }); recentSessions.value = (res.items || []).filter(item => item.status !== 'rolled_back') } catch (_) { recentSessions.value = [] } }
async function resume(item) { try { const res = await assetImportAPI.get(item.id); const data = res.data || res; session.value = data.session; plan.value = session.value.plan || {}; items.value = data.items || []; sourceLabel.value = session.value.source_label || ''; targetRunId.value = session.value.target_run_id || ''; ElMessage.success('已恢复导入会话') } catch (e) { error.value = e.message } }
async function scan() {
  if (!session.value) return ElMessage.warning('请先创建导入会话')
  if (!files.value.length) return ElMessage.warning('请先选择文件夹或文件')
  scanning.value = true; error.value = ''
  try {
    // Web File objects intentionally do not expose absolute paths. Upload to
    // a session-scoped staging area first, then scan opaque source tokens.
    const form = new FormData()
    const relativePaths = []
    files.value.forEach(item => { form.append('files', item.file, item.name); relativePaths.push(item.relative_path) })
    form.append('relative_paths', JSON.stringify(relativePaths))
    const uploaded = await assetImportAPI.upload(session.value.id, form, { timeout: 600000 })
    const descriptors = (uploaded.files || []).map(item => ({ ...item, source_token: item.source_token }))
    const res = await assetImportAPI.scan(session.value.id, { files: descriptors, classifier_enabled: useAiClassifier.value, options: { classifier_enabled: useAiClassifier.value, classifier_model: 'gpt-5.6-sol' } })
    const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || []
    ElMessage.success(`已分析 ${descriptors.length} 个文件`)
  } catch (e) { error.value = e.message } finally { scanning.value = false }
}
async function reorganize() { if (!session.value || !reorganizeReason.value.trim()) return ElMessage.warning('请先填写整理要求'); reorganizing.value = true; try { const res = await assetImportAPI.reorganize(session.value.id, { instruction: reorganizeReason.value.trim() }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = plan.value.items || items.value; ElMessage.success(data.deferred ? '已保存整理要求，等待 AI 配置后重试' : 'AI 已重新整理导入计划') } catch (e) { error.value = e.message } finally { reorganizing.value = false } }
async function savePlanEdits() { if (!session.value || !items.value.length) return; savingPlan.value = true; error.value = ''; try { const res = await assetImportAPI.updatePlan(session.value.id, { expected_version: session.value.version, reason: '用户在导入预览中逐项确认类型、阶段和是否导入', items: items.value.map(row => ({ id: row.id, detected_type: row.detected_type, candidate_stage: row.candidate_stage || null, candidate_scope_type: row.candidate_scope_type || 'run', candidate_scope_id: row.candidate_scope_id || '', include: row.status !== 'excluded' })) }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || items.value; ElMessage.success(`计划已保存（${data.changed_item_ids?.length || 0} 项更新）`) } catch (e) { error.value = e.message || '计划保存失败' } finally { savingPlan.value = false } }
async function apply() { try { await ElMessageBox.confirm('确认后会把可导入项写入目标项目，仍可通过“回滚”撤销本次导入。', '确认导入'); const res = await assetImportAPI.apply(session.value.id, { confirm: true }); session.value = (res.data || res).session; ElMessage.success('导入完成') } catch (e) { if (e !== 'cancel') error.value = e.message } }
async function rollback() { try { await ElMessageBox.confirm('回滚会软删除本次创建的资产并移除导入副本，是否继续？', '确认回滚', { type: 'warning' }); const res = await assetImportAPI.rollback(session.value.id); session.value = (res.data || res).session; ElMessage.success('已回滚') } catch (e) { if (e !== 'cancel') error.value = e.message } }
onMounted(loadSessions)
</script>
<style scoped>
.page{min-height:100vh;padding:42px clamp(20px,5vw,72px);background:linear-gradient(135deg,#f7f9ff,#eef3ff);color:#17213a}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.eyebrow{color:#5b6ee1;font-weight:700;letter-spacing:.08em}.hero h1{margin:8px 0;font-size:34px}.sub{color:#65708a}.card{max-width:1180px;margin:16px auto;border:0;border-radius:18px}.form-row,.card-head,.actions,.stats{display:flex;gap:12px;align-items:center}.form-row>*{flex:1}.form-row .el-button{flex:0 0 auto}.choose-row{display:flex;align-items:center;gap:20px;flex-wrap:wrap;margin-top:18px}.hint{display:block;margin-top:10px;color:#7b849b;font-size:13px}.card-head{justify-content:space-between;margin-bottom:20px}.card-head small.revision{margin-left:10px;color:#8790a6}.stats{padding:14px 0;color:#59647e;flex-wrap:wrap}.stats span{padding:8px 14px;background:#f4f6fb;border-radius:10px}.conflicts{margin-top:16px}.reorganize-row{display:flex;gap:12px;margin:12px 0}.reorganize-row .el-input{flex:1}.scope-cell{display:flex;gap:4px;align-items:center}.scope-cell .el-input{width:82px}.recent-imports{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}.recent-label{font-size:13px;color:#7b849b}
</style>
