<template>
  <div class="codex-console">
    <header class="console-header">
      <button class="brand" type="button" @click="router.push('/')">
        <span class="brand-dot">银</span>
        <span><strong>Codex 银子万能视频工作流</strong><small>Codex 负责决策，系统负责记录、执行与恢复</small></span>
      </button>
      <nav>
        <el-button text @click="router.push('/')">项目</el-button>
        <el-button text @click="router.push('/media-library')">素材库</el-button>
        <el-button text @click="router.push('/series-groups')">剧集组</el-button>
        <el-button text @click="router.push('/ai-config')">模型与 Key</el-button>
        <el-button text @click="router.push('/advanced-settings')">提示词与高级设置</el-button>
      </nav>
    </header>

    <main>
      <section class="hero">
        <div>
          <p class="eyebrow">OBSERVABLE · RESUMABLE · OPEN WORLD</p>
          <h1>这里不和用户聊天，只把 Codex 的工作变得看得见、接得住。</h1>
          <p>你继续在 Codex 中说需求、发送文件或告诉它文件夹位置。编排台负责实时记录动态流程、输入输出、失败原因、费用和检查点；Codex 不在线时，你仍可以手动推进。</p>
        </div>
        <div class="hero-actions">
          <el-button :loading="loading" @click="loadSessions">刷新任务</el-button>
          <el-button type="primary" :disabled="runtimeWriteBlocked" @click="showCreate = true">手动建立观察任务</el-button>
        </div>
      </section>

      <section :class="['runtime-banner', runtimeIdentityError ? 'runtime-danger' : 'runtime-ok']" aria-live="polite">
        <div class="runtime-mark"></div>
        <div class="runtime-copy">
          <strong>{{ runtimeIdentityError ? '当前页面无法确认后端身份' : '已连接到可审计工作流运行时' }}</strong>
          <span v-if="runtimeIdentityError">{{ runtimeIdentityError }} 页面仍可保留当前查看状态；修复或固定后端后再执行写操作。</span>
          <span v-else>版本 {{ runtimeIdentity?.app_version || '未知' }} · 源码 {{ runtimeIdentity?.source_revision || '未知' }} · 数据 {{ runtimeIdentity?.database?.fingerprint || '未知' }} · {{ runtimeIdentity?.canonical ? 'canonical 实例' : '本地实例' }}</span>
        </div>
        <el-button size="small" text @click="loadRuntimeIdentity(false)">重新检查</el-button>
        <el-button v-if="runtimeIdentityMismatch" size="small" type="warning" plain @click="loadRuntimeIdentity(true)">确认切换到当前实例</el-button>
      </section>

      <section v-if="onboarding" class="onboarding-card" aria-live="polite">
        <div class="onboarding-copy">
          <small>第一次使用</small>
          <h2>只要在 Codex 里说需求，剩下的交给它</h2>
          <p>{{ onboarding.next_steps?.[0] }}</p>
          <p class="onboarding-muted">{{ onboarding.low_gate_notice }}</p>
        </div>
        <div class="onboarding-status">
          <span class="onboarding-chip">已连接</span>
          <span>文本 {{ onboarding.active_config_counts?.text || 0 }} · 图片 {{ onboarding.active_config_counts?.image || 0 }} · 视频 {{ onboarding.active_config_counts?.video || 0 }}</span>
          <span class="onboarding-budget">{{ onboarding.budget_hint }}</span>
        </div>
      </section>

      <section class="layout">
        <aside class="sessions-panel">
          <div class="panel-title"><div><small>任务索引</small><h2>Codex 编排任务</h2></div><span>{{ sessions.length }}</span></div>
          <div v-if="sessionsError" class="inline-error">{{ sessionsError }} <button @click="loadSessions">重试</button></div>
          <div v-if="loading" class="skeleton-stack"><span v-for="i in 4" :key="i"></span></div>
          <button
            v-for="item in sessions"
            v-else
            :key="item.id"
            :class="['session-item', { active: selectedId === item.id }]"
            type="button"
            @click="selectSession(item.id)"
          >
            <span class="session-status" :class="statusTone(item.status)"></span>
            <span><strong>{{ item.title || '未命名任务' }}</strong><small>{{ item.user_goal || '等待 Codex 写入目标' }}</small></span>
            <em>{{ statusLabel(item.status) }}</em>
          </button>
          <div v-if="!loading && !sessions.length" class="empty-list">
            <strong>还没有编排任务</strong>
            <p>在 Codex 中安装 Skill 后，它会在开始工作时自动创建。你也可以先建一个空任务观察接口。</p>
          </div>
        </aside>

        <section class="workspace">
          <template v-if="bundle?.session">
            <header class="session-header">
              <div>
                <div class="status-line"><span :class="['status-pill', statusTone(bundle.session.status)]">{{ statusLabel(bundle.session.status) }}</span><span v-if="showTechnical">计划版本 {{ bundle.session.plan_revision }}</span><span v-if="showTechnical">状态版本 {{ bundle.session.version }}</span></div>
                <h2>{{ bundle.session.title }}</h2>
                <p>{{ bundle.session.user_goal || 'Codex 尚未写入任务目标。' }}</p>
              </div>
              <div class="session-actions">
                <el-button v-if="bundle.session.status === 'waiting_confirmation'" type="primary" :disabled="runtimeWriteBlocked" @click="confirmPlan">确认这个计划</el-button>
                <el-button v-if="bundle.session.status === 'planned'" type="primary" :disabled="runtimeWriteBlocked" @click="startSession">开始制作</el-button>
                <el-button v-if="['running', 'planned', 'waiting_confirmation'].includes(bundle.session.status)" :disabled="runtimeWriteBlocked" @click="pauseSession">暂停编排</el-button>
                <el-button v-if="bundle.session.status === 'paused'" type="primary" plain :disabled="runtimeWriteBlocked" @click="resumeSession">从检查点继续</el-button>
                <el-button :disabled="runtimeWriteBlocked" @click="saveCheckpoint">保存检查点</el-button>
                <el-button @click="downloadExport">导出审计包</el-button>
              </div>
            </header>

            <div class="metric-grid">
              <article><small>动态节点</small><strong>{{ countSummary.done }} / {{ countSummary.all }}</strong><el-progress :percentage="countSummary.percent" :show-text="false" :stroke-width="6" /></article>
              <article><small>关联项目</small><strong>{{ bundle.session.linked_drama_id || '未关联' }}</strong><span>{{ bundle.session.linked_run_id ? `任务 ${shortId(bundle.session.linked_run_id)}` : '可由 Codex 后续绑定' }}</span></article>
              <article><small>费用真值</small><strong>{{ formatCost(bundle.session.usage) }}</strong><span>{{ formatBudget(bundle.session.budget) }}</span></article>
              <article><small>恢复点</small><strong>{{ bundle.session.checkpoint?.saved_at ? '已保存' : '尚未保存' }}</strong><span>{{ bundle.session.checkpoint?.summary || '节点与事件仍持续落库' }}</span></article>
            </div>

            <div class="experience-grid">
              <OrchestrationProgress :session="bundle.session" :nodes="bundle.nodes" />
              <OrchestrationDelivery :delivery="delivery" />
            </div>

            <OrchestrationArtifactGallery :items="artifacts" :loading="artifactsLoading" :error="artifactsError" />

            <section class="plan-card">
              <div class="section-heading">
                <div><small>当前方案</small><h3>Codex 动态执行计划</h3></div>
                <div class="plan-heading-actions"><div class="legend"><span><i class="success"></i>完成</span><span><i class="active"></i>执行</span><span><i class="warning"></i>处理</span><span><i class="neutral"></i>等待</span></div><el-button size="small" text @click="showTechnical = !showTechnical">{{ showTechnical ? '隐藏高级信息' : '显示高级信息' }}</el-button><el-button size="small" plain :disabled="runtimeWriteBlocked" @click="openPlanEditor">人工编辑计划</el-button></div>
              </div>
              <p class="plan-summary">{{ bundle.session.plan?.summary || '计划尚未生成。Codex 可以根据用户目标和素材自由添加、跳过或重排节点。' }}</p>
              <div class="timeline">
                <article v-for="(node, index) in bundle.nodes" :key="node.id" :class="['node-card', statusTone(node.status)]">
                  <div class="node-rail"><span>{{ index + 1 }}</span><i></i></div>
                  <div class="node-body">
                    <header>
                      <div><small>{{ phaseLabel(node.phase) }}</small><h4>{{ humanModule(node.module_id) }}</h4><code v-if="showTechnical">{{ node.module_id }}</code></div>
                      <span :class="['status-pill', statusTone(node.status)]">{{ statusLabel(node.status, true) }}</span>
                    </header>
                    <div class="node-meta"><span>{{ moduleAvailabilityLabel(node) }}</span><span>执行：{{ executorLabel(node.executor) }}</span><span>尝试 #{{ node.attempt }}</span><span v-if="node.config_revision">配置 {{ node.config_revision }}</span></div>
                    <p v-if="progressLabel(node)" class="progress-message">{{ progressLabel(node) }}</p>
                    <div v-if="node.input_refs?.length || node.output_refs?.length" class="io-grid">
                      <div><strong>输入</strong><span v-for="(ref, i) in node.input_refs" :key="`in-${i}`">{{ referenceLabel(ref) }}</span><em v-if="!node.input_refs?.length">无</em></div>
                      <div><strong>输出</strong><span v-for="(ref, i) in node.output_refs" :key="`out-${i}`">{{ referenceLabel(ref) }}</span><em v-if="!node.output_refs?.length">尚未产出</em></div>
                    </div>
                    <div v-if="latestReceipt(bundle, node.id)" :class="['receipt-box', receiptTone(latestReceipt(bundle, node.id))]">
                      <small>{{ node.attempt > latestReceipt(bundle, node.id).attempt ? '上一次执行回执（当前已重试）' : '最近一次执行回执' }}</small>
                      <strong>{{ latestReceipt(bundle, node.id).message || '节点已有执行回执' }}</strong>
                      <span>来源：{{ latestReceipt(bundle, node.id).source }} · 原始代码：{{ latestReceipt(bundle, node.id).original_code || '无' }} · 可重试：{{ retryLabel(latestReceipt(bundle, node.id).retryable) }}</span>
                      <span v-if="latestReceipt(bundle, node.id).attempted?.length">已尝试：{{ latestReceipt(bundle, node.id).attempted.join('、') }}</span>
                    </div>
                    <div v-if="providerFailureGuidance(node, latestReceipt(bundle, node.id))" :class="['recovery-box', `recovery-${providerFailureGuidance(node, latestReceipt(bundle, node.id)).kind}`]">
                      <strong>{{ providerFailureGuidance(node, latestReceipt(bundle, node.id)).title }}</strong>
                      <p>{{ providerFailureGuidance(node, latestReceipt(bundle, node.id)).summary }}</p>
                      <ol><li v-for="step in providerFailureGuidance(node, latestReceipt(bundle, node.id)).steps" :key="step">{{ step }}</li></ol>
                      <el-button v-if="providerFailureGuidance(node, latestReceipt(bundle, node.id)).action === 'open_ai_config'" size="small" type="warning" plain @click="router.push('/ai-config')">前往模型与 Key</el-button>
                    </div>
                    <footer>
                      <el-button v-if="node.status === 'ready'" size="small" type="primary" :disabled="runtimeWriteBlocked" @click="setNode(node, 'running')">标记开始</el-button>
                      <el-button v-if="['pending', 'waiting_confirmation'].includes(node.status)" size="small" type="primary" plain :disabled="runtimeWriteBlocked" @click="takeOverNode(node)">人工接管</el-button>
                      <el-button v-if="node.status === 'running'" size="small" type="success" plain :disabled="runtimeWriteBlocked" @click="setNode(node, 'succeeded')">标记完成</el-button>
                      <el-button v-if="node.status === 'running'" size="small" type="danger" plain :disabled="runtimeWriteBlocked" @click="openFail(node)">记录失败</el-button>
                      <el-button v-if="canDirectlyRetryNode(node, latestReceipt(bundle, node.id))" size="small" type="primary" :disabled="runtimeWriteBlocked" @click="retryNode(node)">直接重试</el-button>
                      <el-button v-if="['pending', 'ready', 'waiting_confirmation', 'failed', 'partial'].includes(node.status)" size="small" text :disabled="runtimeWriteBlocked" @click="setNode(node, 'skipped')">跳过</el-button>
                      <el-button v-if="['succeeded', 'skipped'].includes(node.status)" size="small" text :disabled="runtimeWriteBlocked" @click="reopenNode(node)">重开</el-button>
                      <el-button size="small" text :disabled="runtimeWriteBlocked" @click="openNodeEditor(node)">编辑节点</el-button>
                      <el-button size="small" text @click="inspectNode(node)">查看技术信息</el-button>
                    </footer>
                  </div>
                </article>
              </div>
              <div v-if="!bundle.nodes.length" class="empty-plan">Codex 尚未写入节点。模块不会限制它能做什么；未知任务也可以作为人工节点记录。</div>
            </section>

            <section class="audit-grid">
              <article class="events-card">
                <div class="section-heading"><div><small>不可变记录</small><h3>最近活动</h3></div><span>{{ bundle.events.length }} 条</span></div>
                <ol>
                  <li v-for="event in recentEvents" :key="event.id"><time>{{ formatTime(event.created_at) }}</time><span><strong>{{ eventLabel(event.event_type) }}</strong><small>{{ eventSummary(event) }}</small></span><em>{{ event.actor }}</em></li>
                </ol>
              </article>
              <article class="manual-card">
                <small>人工接管</small><h3>Codex 不在线，也能继续</h3>
                <p>界面只修改结构化状态，不替你伪造供应商结果。真正媒体执行仍使用现有工作流或 Codex 工具。</p>
                <div class="manual-links">
                  <button @click="openLinkedWorkflow"><strong>打开关联工作流</strong><span>{{ bundle.session.linked_run_id ? '继续现有制作任务' : '尚未关联，可由 Codex 或人工绑定' }}</span></button>
                  <button @click="openLinkEditor"><strong>关联现有项目/任务</strong><span>填写项目 ID 和 production run ID，保留两边真实状态</span></button>
                  <button @click="router.push('/media-library')"><strong>检查素材库</strong><span>查看已经生成和导入的图片、视频与音频</span></button>
                  <button @click="router.push('/series-groups')"><strong>检查剧集组</strong><span>确认哪些项目共用角色和资源</span></button>
                </div>
              </article>
            </section>
            <OrchestrationFeedback :disabled="runtimeWriteBlocked || !bundle?.session" :submitting="feedbackSubmitting" :submitted="feedbackSubmitted" @submit="recordFeedback" />
          </template>

          <div v-else-if="detailLoading" class="workspace-loading">正在读取编排真值…</div>
          <div v-else-if="detailError" class="workspace-empty workspace-error"><span>!</span><h2>{{ detailError.title }}</h2><p>{{ detailError.message }}</p><div class="workspace-empty-actions"><el-button type="primary" @click="refreshCurrentTask">刷新这个任务</el-button><el-button v-if="sessions.length" plain @click="openRecentTask">打开最近任务</el-button><el-button text @click="returnToTaskIndex">返回任务索引</el-button></div></div>
          <div v-else class="workspace-empty"><span>⌁</span><h2>选择一个任务查看 Codex 的实时决策</h2><p>系统不会代替 Codex 与用户聊天，只负责把每个节点的事实和操作边界保存下来。</p></div>
        </section>
      </section>
    </main>

    <el-dialog v-model="showCreate" title="建立一个可审计任务" width="min(560px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="任务标题"><el-input v-model="createForm.title" placeholder="例如：商品A 15秒投流视频" /></el-form-item>
        <el-form-item label="用户目标"><el-input v-model="createForm.user_goal" type="textarea" :rows="4" placeholder="通常由 Codex 自动写入；这里也允许人工建立任务。" /></el-form-item>
        <el-form-item label="协作模式"><el-radio-group v-model="createForm.mode"><el-radio-button value="auto">自动</el-radio-button><el-radio-button value="collaborate">协作</el-radio-button><el-radio-button value="manual">手动</el-radio-button></el-radio-group></el-form-item>
      </el-form>
      <template #footer><el-button @click="showCreate = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="runtimeWriteBlocked" @click="createSession">建立任务</el-button></template>
    </el-dialog>

    <el-dialog v-model="showFailure" title="记录真实失败" width="min(620px, 92vw)">
      <p class="dialog-note">不会要求填写长理由；原始错误和下一步会保存在审计回执里。</p>
      <el-form label-position="top">
        <el-form-item label="错误信息"><el-input v-model="failureForm.message" placeholder="例如：上游暂时失败" /></el-form-item>
        <el-form-item label="原始错误代码"><el-input v-model="failureForm.code" placeholder="未知也可以留空" /></el-form-item>
        <el-form-item label="是否可重试"><el-select v-model="failureForm.retryable" style="width:100%"><el-option value="true" label="可以重试" /><el-option value="false" label="不可重试" /><el-option value="unknown" label="尚不确定" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="showFailure = false">取消</el-button><el-button type="danger" :disabled="runtimeWriteBlocked" @click="saveFailure">记录失败</el-button></template>
    </el-dialog>

    <el-dialog v-model="showInspect" title="节点技术信息" width="min(760px, 94vw)">
      <pre class="technical-json">{{ JSON.stringify(inspectTarget, null, 2) }}</pre>
    </el-dialog>

    <el-dialog v-model="showPlan" title="人工编辑动态计划" width="min(980px, 96vw)" top="5vh">
      <p class="dialog-note">这是完整人工接管入口。保存会创建新的计划版本，历史节点、事件和回执不会被覆盖；未知模块也允许保留。</p>
      <el-form label-position="top">
        <el-form-item label="计划摘要"><el-input v-model="planForm.summary" type="textarea" :rows="2" placeholder="用一句话说明现在为什么这样安排" /></el-form-item>
        <div class="plan-editor-list">
          <article v-for="(node, index) in planForm.nodes" :key="`${node.node_key}-${index}`" class="plan-editor-node">
            <header><strong>节点 {{ index + 1 }}</strong><span><el-button size="small" text :disabled="index === 0" @click="movePlanNode(index, -1)">上移</el-button><el-button size="small" text :disabled="index === planForm.nodes.length - 1" @click="movePlanNode(index, 1)">下移</el-button><el-button size="small" text type="danger" @click="removePlanNode(index)">移除</el-button></span></header>
            <div class="plan-editor-fields">
              <el-form-item label="稳定节点键"><el-input v-model="node.node_key" placeholder="例如 product-facts" /></el-form-item>
              <el-form-item label="模块"><el-input v-model="node.module_id" placeholder="未知模块也允许填写" /></el-form-item>
              <el-form-item label="阶段"><el-select v-model="node.phase"><el-option v-for="phase in phaseOptions" :key="phase.value" :label="phase.label" :value="phase.value" /></el-select></el-form-item>
              <el-form-item label="执行者"><el-select v-model="node.executor"><el-option v-for="executor in executorOptions" :key="executor.value" :label="executor.label" :value="executor.value" /></el-select></el-form-item>
              <el-form-item class="wide-field" label="依赖节点键（逗号分隔）"><el-input v-model="node.depends_text" placeholder="例如 scan-assets, product-facts" /></el-form-item>
              <el-form-item class="wide-field" label="判断依据/验收要求"><el-input v-model="node.note" placeholder="为什么需要这个节点，怎样算完成" /></el-form-item>
            </div>
          </article>
        </div>
        <el-button plain @click="addPlanNode">＋ 增加节点</el-button>
      </el-form>
      <template #footer><el-button @click="showPlan = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="runtimeWriteBlocked" @click="savePlan">保存为新版本</el-button></template>
    </el-dialog>

    <el-dialog v-model="showNodeEdit" title="编辑节点信息" width="min(700px, 94vw)">
      <p class="dialog-note">这里修改当前节点的可审计输入、输出和判断信息，不会伪造服务商结果。</p>
      <el-form label-position="top">
        <el-form-item label="执行说明"><el-input v-model="nodeEditForm.message" placeholder="例如：使用用户上传商品白底图作为权威主体" /></el-form-item>
        <el-form-item label="输入引用（每行：类型 | ID或路径 | 角色）"><el-input v-model="nodeEditForm.inputs" type="textarea" :rows="4" placeholder="image | D:\素材\商品.png | product_authority" /></el-form-item>
        <el-form-item label="输出引用（每行：类型 | ID或路径 | 角色）"><el-input v-model="nodeEditForm.outputs" type="textarea" :rows="4" placeholder="video | clip-01 | direct_clip" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="showNodeEdit = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="runtimeWriteBlocked" @click="saveNodeEdit">保存节点信息</el-button></template>
    </el-dialog>

    <el-dialog v-model="showLink" title="关联现有工作流" width="min(620px, 92vw)">
      <p class="dialog-note">关联只建立可追溯关系，不复制或覆盖原有 production run。</p>
      <el-form label-position="top">
        <el-form-item label="项目 ID"><el-input-number v-model="linkForm.linked_drama_id" :min="1" controls-position="right" style="width:100%" /></el-form-item>
        <el-form-item label="Production run ID"><el-input v-model="linkForm.linked_run_id" placeholder="UUID；不清楚可以留空" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="showLink = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="runtimeWriteBlocked" @click="saveLink">保存关联</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import orchestrationAPI from '@/api/orchestration'
import { canDirectlyRetryNode, formatBudgetTruth, latestReceipt, moduleAvailabilityLabel, progressLabel, providerFailureGuidance, statusLabel, statusTone, summarizeCounts } from '@/utils/orchestrationView'
import { canWriteRuntime, runtimeIdentityKey } from '@/utils/runtimeIdentityGuard'
import { orchestrationReceiptTone } from '@/utils/orchestrationReceiptTone'
import OrchestrationProgress from '@/components/orchestration/OrchestrationProgress.vue'
import OrchestrationArtifactGallery from '@/components/orchestration/OrchestrationArtifactGallery.vue'
import OrchestrationFeedback from '@/components/orchestration/OrchestrationFeedback.vue'
import OrchestrationDelivery from '@/components/orchestration/OrchestrationDelivery.vue'

const route = useRoute()
const router = useRouter()
const sessions = ref([])
const bundle = ref(null)
const loading = ref(false)
const detailLoading = ref(false)
const detailError = ref(null)
const saving = ref(false)
const sessionsError = ref('')
const runtimeIdentity = ref(null)
const runtimeIdentityError = ref('')
const runtimeIdentityBaseline = ref(null)
const runtimeIdentityMismatch = ref(false)
const onboarding = ref(null)
const artifacts = ref([])
const artifactsLoading = ref(false)
const artifactsError = ref('')
const delivery = ref({})
const feedbackSubmitting = ref(false)
const feedbackSubmitted = ref(false)
const showTechnical = ref(false)
const selectedId = computed(() => String(route.params.id || ''))
const runtimeWriteBlocked = computed(() => !canWriteRuntime({ identity: runtimeIdentity.value, baselineKey: runtimeIdentityBaseline.value, error: runtimeIdentityError.value, mismatch: runtimeIdentityMismatch.value }))
const showCreate = ref(false)
const showFailure = ref(false)
const showInspect = ref(false)
const showPlan = ref(false)
const showNodeEdit = ref(false)
const showLink = ref(false)
const inspectTarget = ref(null)
const failureNode = ref(null)
const createForm = reactive({ title: '', user_goal: '', mode: 'collaborate' })
const failureForm = reactive({ message: '', code: '', retryable: 'true' })
const planForm = reactive({ summary: '', nodes: [] })
const nodeEditForm = reactive({ node: null, message: '', inputs: '', outputs: '' })
const linkForm = reactive({ linked_drama_id: undefined, linked_run_id: '' })
const phaseOptions = [
  { value: 'intake', label: '素材与目标' }, { value: 'research', label: '研究' }, { value: 'plan', label: '规划' },
  { value: 'create', label: '创作' }, { value: 'edit', label: '剪辑' }, { value: 'qa', label: '验收' }, { value: 'deliver', label: '交付' },
]
const executorOptions = [{ value: 'codex', label: 'Codex' }, { value: 'local', label: '本地执行器' }, { value: 'provider', label: '模型服务商' }, { value: 'manual', label: '人工' }]
let timer = null

const countSummary = computed(() => summarizeCounts(bundle.value?.counts || {}))
const recentEvents = computed(() => [...(bundle.value?.events || [])].reverse().slice(0, 18))

function shortId(value) { return String(value || '').slice(0, 8) }
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
function formatCost(usage = {}) {
  const raw = usage.actual_cost_cny ?? usage.cost_cny ?? usage.actual_cost_usd ?? usage.cost_usd
  const amount = Number(raw)
  if (!Number.isFinite(amount) || raw == null) return '尚无已结算费用'
  const currency = String(usage.currency || (usage.actual_cost_cny != null || usage.cost_cny != null ? 'CNY' : 'USD')).toUpperCase()
  return `${amount.toFixed(currency === 'CNY' ? 2 : 4)} ${currency}`
}
function formatBudget(budget = {}) {
  return formatBudgetTruth(budget)
}
function phaseLabel(value) { return ({ intake: '素材与目标', research: '研究', plan: '规划', create: '创作', edit: '剪辑', qa: '验收', deliver: '交付' })[value] || value || '动态阶段' }
function executorLabel(value) { return ({ codex: 'Codex', local: '本地执行器', provider: '模型服务商', manual: '人工', system: '系统' })[value] || value || '未知' }
function retryLabel(value) { return ({ true: '是', false: '否', unknown: '尚不确定' })[String(value)] || '尚不确定' }
function humanModule(value) {
  return ({
    'session.create': '建立持久任务', 'asset.scan': '扫描素材', 'asset.classify': '理解素材用途', 'asset.bind': '绑定素材与对象',
    'plan.propose': '设计动态流程', 'plan.confirm': '确认流程', 'product.extract-facts': '提取产品事实', 'research.request': '调研同类作品',
    'research.extract-patterns': '总结热门结构', 'creative.generate-directions': '设计创意方向', 'shot.plan-grid': '设计镜头与九宫格',
    'copy.generate': '生成文案与字幕', 'image.generate': '生成图片', 'video.generate': '生成视频', 'video.import': '复用已有视频',
    'video.timeline-assemble': '编排时间线', 'deliver.export': '导出成片', 'qa.claim-trace': '核对事实与宣称',
    'provider.diagnose': '诊断供应商协议', 'patch.propose': '提出代码修复', 'patch.test': '沙盒验收修复',
  })[value] || value
}
function referenceLabel(ref = {}) { return [ref.role, ref.type, ref.title || ref.id || ref.path].filter(Boolean).join(' · ') || '未命名引用' }
function eventLabel(value) { return ({
  'session.created': '建立编排任务', 'session.updated': '更新任务状态', 'session.started': '开始执行',
  'session.checkpoint_saved': '保存恢复检查点', 'session.resumed_from_checkpoint': '从检查点继续',
  'plan.proposed': 'Codex 提交新计划', 'plan.confirmed': '计划已确认', 'node.ready': '节点已就绪',
  'node.running': '开始执行节点', 'node.succeeded': '节点完成', 'node.partial': '节点部分完成',
  'node.failed': '节点失败', 'node.skipped': '节点已跳过', 'node.retry_authorized': '授权节点重试',
})[value] || value }
function eventSummary(event) {
  const p = event.payload || {}
  return [p.node_key, p.module_id, p.summary, p.note].filter(Boolean).join(' · ') || '已记录'
}

async function loadSessions(selectFirst = true) {
  loading.value = true; sessionsError.value = ''
  try {
    const data = await orchestrationAPI.sessions({ limit: 100 })
    sessions.value = data.items || []
    if (selectFirst && !selectedId.value && sessions.value[0]) await router.replace(`/codex-console/${sessions.value[0].id}`)
  } catch (error) { sessionsError.value = error.message || '无法读取编排任务' }
  finally { loading.value = false }
}
async function loadRuntimeIdentity(allowRebind = false) {
  runtimeIdentityError.value = ''
  try {
    const identity = await orchestrationAPI.runtimeIdentity()
    if (!identity?.schema || identity?.orchestration_router !== true) throw new Error('运行时未声明当前编排能力')
    const key = runtimeIdentityKey(identity)
    if (!runtimeIdentityBaseline.value) runtimeIdentityBaseline.value = key
    else if (runtimeIdentityBaseline.value !== key && !allowRebind) {
      runtimeIdentityMismatch.value = true
      runtimeIdentity.value = identity
      runtimeIdentityError.value = '检测到后端实例或数据源已变化；为避免把任务写入另一套运行时，当前仅保留读取。请确认后再绑定当前实例。'
      return
    } else if (allowRebind) {
      runtimeIdentityBaseline.value = key
    }
    runtimeIdentityMismatch.value = false
    runtimeIdentity.value = identity
  } catch (error) {
    // Keep the last successful identity for diagnostics and read-only viewing,
    // but fail closed for every write while the runtime is unknown.
    runtimeIdentityError.value = error.message || '无法读取运行时身份'
  }
}
async function loadOnboarding() {
  try { onboarding.value = await orchestrationAPI.onboarding() }
  catch (_) { onboarding.value = null }
}
function assertRuntimeReady() {
  if (!runtimeWriteBlocked.value) return true
  ElMessage.warning(runtimeIdentityMismatch.value
    ? '后端实例已变化：当前只允许查看。确认切换到当前实例后才能写入。'
    : '当前无法确认后端身份，写操作已暂停；请先重新检查运行时。')
  return false
}
async function loadBundle(silent = false) {
  if (!selectedId.value) { bundle.value = null; detailError.value = null; return }
  if (!silent) detailLoading.value = true
  try {
    bundle.value = await orchestrationAPI.get(selectedId.value, { include_inactive: false, event_limit: 200 })
    detailError.value = null
    if ((!artifacts.value || !artifacts.value.length) && Array.isArray(bundle.value?.artifacts)) artifacts.value = bundle.value.artifacts
    if ((!delivery.value || !delivery.value.items?.length) && bundle.value?.delivery) delivery.value = bundle.value.delivery
  }
  catch (error) {
    const status = Number(error?.response?.status)
    const missing = status === 404 || /编排任务不存在|ORCHESTRATION_NOT_FOUND|not found/i.test(String(error?.message || ''))
    if (missing) {
      bundle.value = null
      detailError.value = { title: '这个任务已经不存在或已被清理', message: '任务索引仍然可用。你可以刷新任务、打开最近任务，或返回任务索引；不会影响其它任务，也不会影响仍在后台运行的 Codex 工作。' }
    } else if (!silent) {
      detailError.value = { title: '暂时无法读取这个任务', message: `${error?.message || '读取失败'}。可以稍后刷新；如果 Codex 仍在工作，不要重复提交同一个付费动作。` }
    }
  }
  finally { detailLoading.value = false }
}
async function loadExperience(silent = true) {
  if (!selectedId.value || detailError.value) return
  if (!silent) artifactsLoading.value = true
  try {
    const data = await orchestrationAPI.artifacts(selectedId.value)
    artifacts.value = Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : [])
    artifactsError.value = ''
  } catch (error) {
    // Keep the last successful gallery; an unavailable optional endpoint is not a reason to erase evidence.
    if (!artifacts.value.length) artifactsError.value = error.message || '成果暂时无法读取'
  } finally { artifactsLoading.value = false }
  try { delivery.value = await orchestrationAPI.delivery(selectedId.value) || {} }
  catch (_) { if (!delivery.value?.items?.length) delivery.value = {} }
}
async function selectSession(id) { if (selectedId.value !== id) await router.push(`/codex-console/${id}`) }
async function refreshCurrentTask() { await loadBundle(false); if (!detailError.value) await loadExperience(false) }
async function openRecentTask() { if (sessions.value[0]) await router.push(`/codex-console/${sessions.value[0].id}`) }
async function returnToTaskIndex() { await router.push('/codex-console') }
async function createSession() {
  if (!assertRuntimeReady()) return
  if (!createForm.title.trim() && !createForm.user_goal.trim()) return ElMessage.warning('至少填写任务标题或目标')
  saving.value = true
  try {
    const result = await orchestrationAPI.create({ ...createForm, actor: 'user', idempotency_key: `manual-${Date.now()}` })
    showCreate.value = false
    Object.assign(createForm, { title: '', user_goal: '', mode: 'collaborate' })
    await loadSessions(false); await router.push(`/codex-console/${result.session.id}`)
  } finally { saving.value = false }
}
async function pauseSession() { if (!assertRuntimeReady()) return; bundle.value = await orchestrationAPI.pause(selectedId.value, { expected_version: bundle.value.session.version, actor: 'user' }); await loadSessions(false) }
async function resumeSession() { if (!assertRuntimeReady()) return; bundle.value = await orchestrationAPI.resume(selectedId.value, { expected_version: bundle.value.session.version, actor: 'user' }); await loadSessions(false) }
async function confirmPlan() {
  if (!assertRuntimeReady()) return
  saving.value = true
  try { bundle.value = await orchestrationAPI.confirm(selectedId.value, { expected_version: bundle.value.session.version, actor: 'user' }); ElMessage.success('计划已确认；可以开始制作'); await loadSessions(false) }
  finally { saving.value = false }
}
async function startSession() {
  if (!assertRuntimeReady()) return
  saving.value = true
  try { bundle.value = await orchestrationAPI.start(selectedId.value, { expected_version: bundle.value.session.version, actor: 'user' }); ElMessage.success('制作已开始'); await loadSessions(false) }
  finally { saving.value = false }
}
async function saveCheckpoint() {
  if (!assertRuntimeReady()) return
  bundle.value = await orchestrationAPI.checkpoint(selectedId.value, { actor: 'user', checkpoint: { summary: `用户在编排台保存；当前完成 ${countSummary.value.done}/${countSummary.value.all} 个节点` } })
  ElMessage.success('检查点已保存，Codex 换会话后可以从这里恢复')
}
async function setNode(node, status) {
  if (!assertRuntimeReady()) return
  const body = { status, expected_version: node.version, actor: 'user' }
  if (status === 'running') body.progress = { state: 'local_started', message: '用户在编排台标记为开始；等待执行器写入真实进度' }
  const result = await orchestrationAPI.updateNode(selectedId.value, node.id, body)
  bundle.value = result.bundle; await loadSessions(false)
}
async function takeOverNode(node) {
  if (!assertRuntimeReady()) return
  const result = await orchestrationAPI.nodeAction(selectedId.value, node.id, 'start', { actor: 'user', force: true, progress: { state: 'local_started', message: '用户已明确人工接管该节点' } })
  bundle.value = result.bundle; await loadSessions(false)
}
async function reopenNode(node) {
  if (!assertRuntimeReady()) return
  const result = await orchestrationAPI.nodeAction(selectedId.value, node.id, 'reopen', { actor: 'user' })
  bundle.value = result.bundle; await loadSessions(false)
}
function openFail(node) { failureNode.value = node; Object.assign(failureForm, { message: '', code: '', retryable: 'true' }); showFailure.value = true }
async function saveFailure() {
  if (!assertRuntimeReady()) return
  const node = failureNode.value
  const message = failureForm.message.trim() || '执行器返回失败，尚未补充详细原因'
  const result = await orchestrationAPI.updateNode(selectedId.value, node.id, {
    status: 'failed', expected_version: node.version, actor: 'user',
    error: { code: failureForm.code.trim() || null, message, retryable: failureForm.retryable },
    receipt: { status: 'failed', source: node.executor || 'manual', original_code: failureForm.code.trim() || null, message, retryable: failureForm.retryable, next_actions: ['retry', 'skip', 'manual'] },
  })
  bundle.value = result.bundle; showFailure.value = false; await loadSessions(false)
}
async function retryNode(node) { if (!assertRuntimeReady()) return; const result = await orchestrationAPI.retryNode(selectedId.value, node.id, { actor: 'user' }); bundle.value = result.bundle; await loadSessions(false) }
function blankPlanNode(index = 0) { return { node_key: `step-${Date.now()}-${index + 1}`, module_id: 'manual.override', phase: 'create', executor: 'manual', depends_text: '', note: '' } }
function openPlanEditor() {
  planForm.summary = bundle.value.session.plan?.summary || ''
  planForm.nodes = bundle.value.nodes.map((node) => ({ node_key: node.node_key, module_id: node.module_id, phase: node.phase, executor: node.executor, depends_text: (node.depends_on || []).join(', '), note: node.decision?.note || node.decision?.acceptance || '' }))
  showPlan.value = true
}
function addPlanNode() { planForm.nodes.push(blankPlanNode(planForm.nodes.length)) }
function removePlanNode(index) { planForm.nodes.splice(index, 1) }
function movePlanNode(index, offset) { const target = index + offset; if (target < 0 || target >= planForm.nodes.length) return; const [item] = planForm.nodes.splice(index, 1); planForm.nodes.splice(target, 0, item) }
async function savePlan() {
  if (!assertRuntimeReady()) return
  if (!planForm.nodes.length) return ElMessage.warning('计划至少需要一个节点')
  const keys = planForm.nodes.map((node) => node.node_key.trim())
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return ElMessage.warning('每个节点需要唯一且非空的稳定节点键')
  saving.value = true
  try {
    bundle.value = await orchestrationAPI.submitPlan(selectedId.value, {
      expected_revision: bundle.value.session.plan_revision, actor: 'user', confirm: true,
      plan: { ...(bundle.value.session.plan || {}), summary: planForm.summary.trim() || '用户人工调整的动态计划' },
      nodes: planForm.nodes.map((node, index) => ({
        node_key: node.node_key.trim(), module_id: node.module_id.trim() || 'manual.override', phase: node.phase, executor: node.executor, sort_order: index,
        depends_on: node.depends_text.split(',').map((item) => item.trim()).filter(Boolean), decision: { note: node.note.trim(), edited_by: 'user' },
      })),
    })
    showPlan.value = false; await loadSessions(false); ElMessage.success('计划已保存为新版本')
  } finally { saving.value = false }
}
async function recordFeedback(payload) {
  if (!assertRuntimeReady() || !selectedId.value || !payload?.message) return
  feedbackSubmitting.value = true; feedbackSubmitted.value = false
  try {
    const result = await orchestrationAPI.feedback(selectedId.value, {
      ...payload, expected_version: bundle.value.session.version, actor: 'user', idempotency_key: `feedback-${selectedId.value}-${Date.now()}`,
    })
    if (result?.bundle) bundle.value = result.bundle
    else if (result?.session) bundle.value = { ...(bundle.value || {}), session: result.session }
    feedbackSubmitted.value = true
    ElMessage.success(payload.pause ? '修改意见已记录，后续步骤已暂停' : '修改意见已记录')
    await loadSessions(false); await loadExperience(false)
  } catch (error) { ElMessage.warning(error.message || '修改意见暂时没有提交成功，原文仍保留在输入框') }
  finally { feedbackSubmitting.value = false }
}
function refsToText(items = []) { return items.map((item) => [item.type || '', item.id || item.path || item.title || '', item.role || ''].join(' | ')).join('\n') }
function textToRefs(value) { return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => { const [type, target, role] = line.split('|').map((part) => part.trim()); const ref = { type: type || 'unknown', role: role || 'manual' }; if (/^[A-Za-z]:[\\/]/.test(target || '') || (target || '').includes('/')) ref.path = target; else ref.id = target || `manual-${Date.now()}`; return ref }) }
function openNodeEditor(node) { Object.assign(nodeEditForm, { node, message: node.decision?.note || '', inputs: refsToText(node.input_refs), outputs: refsToText(node.output_refs) }); showNodeEdit.value = true }
async function saveNodeEdit() {
  if (!assertRuntimeReady()) return
  const node = nodeEditForm.node; if (!node) return
  saving.value = true
  try {
    const result = await orchestrationAPI.updateNode(selectedId.value, node.id, { expected_version: node.version, actor: 'user', input_refs: textToRefs(nodeEditForm.inputs), output_refs: textToRefs(nodeEditForm.outputs), decision: { ...(node.decision || {}), note: nodeEditForm.message.trim(), edited_by: 'user' } })
    bundle.value = result.bundle; showNodeEdit.value = false; await loadSessions(false); ElMessage.success('节点信息已保存')
  } finally { saving.value = false }
}
function openLinkEditor() { Object.assign(linkForm, { linked_drama_id: bundle.value.session.linked_drama_id || undefined, linked_run_id: bundle.value.session.linked_run_id || '' }); showLink.value = true }
async function saveLink() {
  if (!assertRuntimeReady()) return
  saving.value = true
  try { bundle.value = await orchestrationAPI.update(selectedId.value, { expected_version: bundle.value.session.version, actor: 'user', linked_drama_id: linkForm.linked_drama_id || null, linked_run_id: linkForm.linked_run_id.trim() || null, note: '用户更新现有工作流关联' }); showLink.value = false; await loadSessions(false); ElMessage.success('工作流关联已保存') }
  finally { saving.value = false }
}
function inspectNode(node) { inspectTarget.value = { node, module_contract_status: moduleAvailabilityLabel(node), latest_receipt: latestReceipt(bundle.value, node.id) }; showInspect.value = true }
function receiptTone(receipt) {
  return orchestrationReceiptTone(receipt)
}
function openLinkedWorkflow() {
  if (!bundle.value.session.linked_run_id || !bundle.value.session.linked_drama_id) return ElMessage.info('当前任务尚未关联现有工作流；Codex 可以通过 API 补充 linked_drama_id 和 linked_run_id')
  router.push({ name: 'production-workflow', params: { id: bundle.value.session.linked_drama_id }, query: { run: bundle.value.session.linked_run_id } })
}
async function downloadExport() {
  const data = await orchestrationAPI.export(selectedId.value)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `codex-orchestration-${shortId(selectedId.value)}.json`; a.click(); URL.revokeObjectURL(url)
}

watch(selectedId, async () => { await loadBundle(); await loadExperience(false); feedbackSubmitted.value = false })
onMounted(async () => { await loadRuntimeIdentity(); await loadOnboarding(); await loadSessions(); await loadBundle(); await loadExperience(false); timer = window.setInterval(() => { loadBundle(true); loadExperience(true); loadRuntimeIdentity(); loadOnboarding() }, 5000) })
onBeforeUnmount(() => { if (timer) window.clearInterval(timer) })
</script>

<style scoped>
.codex-console { min-height: 100vh; color: #e7eee9; background: #0b0f0e; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.console-header { position: sticky; top: 0; z-index: 20; min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 22px; padding: 10px clamp(16px, 4vw, 54px); border-bottom: 1px solid #26302d; background: rgba(11,15,14,.94); backdrop-filter: blur(16px); }
.brand { min-width: 0; display: flex; align-items: center; gap: 11px; padding: 0; color: inherit; border: 0; background: none; text-align: left; cursor: pointer; }
.brand-dot { width: 38px; height: 38px; display: grid; place-items: center; flex: none; border-radius: 10px; color: #0b1512; background: linear-gradient(135deg,#5eead4,#86efac); font-size: 17px; font-weight: 900; }
.brand > span:last-child { min-width: 0; display: grid; gap: 2px; }
.brand strong { font-size: 14px; white-space: nowrap; }
.brand small { color: #7d8b85; font-size: 10px; white-space: nowrap; }
.console-header nav { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.console-header :deep(.el-button.is-text) { color: #9ba8a2; }
main { max-width: 1640px; margin: 0 auto; padding: 30px clamp(14px, 3vw, 42px) 70px; }
.hero { display: flex; justify-content: space-between; gap: 32px; padding: 14px 0 30px; }
.hero > div:first-child { max-width: 860px; }
.eyebrow, .panel-title small, .section-heading small, .manual-card > small { margin: 0 0 8px; color: #62d9c2; font-size: 10px; font-weight: 800; letter-spacing: .16em; }
.hero h1 { max-width: 790px; margin: 0; color: #f4f8f6; font-size: clamp(28px, 4vw, 52px); line-height: 1.08; letter-spacing: -.035em; }
.hero p:not(.eyebrow) { max-width: 780px; margin: 16px 0 0; color: #8e9d96; font-size: 14px; line-height: 1.8; }
.hero-actions { display: flex; align-items: flex-start; gap: 9px; flex-wrap: wrap; }
.onboarding-card { display:flex; justify-content:space-between; gap:18px; margin:0 0 16px; padding:16px 18px; border:1px solid #31554a; border-radius:12px; background:linear-gradient(115deg,#10251e,#111b18); }
.onboarding-copy { min-width:0; }
.onboarding-copy small { color:#5eead4; font-size:9px; font-weight:800; letter-spacing:.12em; }
.onboarding-copy h2 { margin:5px 0 6px; color:#eaf8ef; font-size:17px; }
.onboarding-copy p { margin:0; color:#a9c1b5; font-size:11px; line-height:1.6; }
.onboarding-copy .onboarding-muted { margin-top:4px; color:#789186; font-size:10px; }
.onboarding-status { min-width:230px; display:grid; align-content:center; justify-items:end; gap:5px; color:#86a096; font-size:10px; text-align:right; }
.onboarding-chip { padding:4px 8px; border:1px solid #2b765f; border-radius:999px; color:#86efac; background:#102e22; font-size:9px; }
.onboarding-budget { max-width:360px; color:#71887d; font-size:9px; line-height:1.4; }
.layout { display: grid; grid-template-columns: minmax(250px, 310px) minmax(0, 1fr); gap: 18px; align-items: start; }
.sessions-panel, .workspace > section, .session-header, .metric-grid article { border: 1px solid #26312d; border-radius: 12px; background: #111715; }
.sessions-panel { position: sticky; top: 86px; max-height: calc(100vh - 110px); overflow: auto; padding: 13px; }
.panel-title, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.panel-title { padding: 5px 4px 12px; border-bottom: 1px solid #252e2b; }
.panel-title h2, .section-heading h3 { margin: 0; color: #e9efec; font-size: 15px; }
.panel-title > span { color: #718078; font-size: 12px; }
.session-item { width: 100%; min-width: 0; display: grid; grid-template-columns: 8px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 12px 8px; border: 0; border-bottom: 1px solid #202825; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.session-item:hover, .session-item.active { background: #17201d; }
.session-item.active { box-shadow: inset 2px 0 #5eead4; }
.session-status { width: 7px; height: 7px; border-radius: 50%; background: #64716b; }
.session-status.success { background:#4ade80 }.session-status.active { background:#2dd4bf; box-shadow:0 0 0 4px rgba(45,212,191,.1) }.session-status.danger { background:#fb7185 }.session-status.warning { background:#fbbf24 }
.session-item > span:nth-child(2) { min-width: 0; display: grid; gap: 4px; }
.session-item strong { color: #dfe7e2; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-item small { color: #718078; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-item em { color: #89968f; font-size: 9px; font-style: normal; white-space: nowrap; }
.empty-list, .workspace-empty { padding: 36px 18px; color: #76847d; text-align: center; }
.empty-list strong, .workspace-empty h2 { color:#ced8d2 }.empty-list p, .workspace-empty p { font-size: 11px; line-height:1.7 }
.workspace { min-width: 0; display: grid; gap: 14px; }
.session-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 22px; }
.session-header h2 { margin: 7px 0 4px; color:#f0f5f2; font-size:22px }.session-header p { max-width:780px; margin:0; color:#8b9992; font-size:12px; line-height:1.65 }
.status-line, .node-meta { display:flex; flex-wrap:wrap; gap:7px; align-items:center; color:#73817a; font-size:9px; }
.status-pill { display:inline-flex; padding:3px 7px; border:1px solid #39433f; border-radius:999px; color:#9eaaa4; background:#1a211f; font-size:9px; }
.status-pill.success { color:#86efac; border-color:#25543a; background:#10241a }.status-pill.active { color:#5eead4; border-color:#245d54; background:#10231f }.status-pill.warning { color:#fcd34d; border-color:#594b1e; background:#2a2410 }.status-pill.danger { color:#fda4af; border-color:#612d36; background:#2b1318 }.status-pill.muted { color:#9ca3af }
.session-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px }
.metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.metric-grid article { min-width:0; display:grid; gap:5px; padding:14px 16px }.metric-grid small { color:#75827b; font-size:9px }.metric-grid strong { color:#e7eee9; font-size:16px }.metric-grid span { overflow:hidden; color:#74827a; font-size:9px; text-overflow:ellipsis; white-space:nowrap }
.experience-grid { display:grid; grid-template-columns: minmax(0,1.15fr) minmax(280px,.85fr); gap:14px; }
.plan-card { padding:20px 22px; }
.legend { display:flex; gap:11px; flex-wrap:wrap; color:#79867f; font-size:9px }.legend span { display:flex; align-items:center; gap:4px }.legend i { width:6px; height:6px; border-radius:50%; background:#68766f }.legend i.success{background:#4ade80}.legend i.active{background:#2dd4bf}.legend i.warning{background:#fbbf24}
.plan-heading-actions { display:flex; align-items:center; justify-content:flex-end; gap:12px; flex-wrap:wrap }
.plan-summary { margin:12px 0 18px; padding:10px 12px; border-left:2px solid #3bbfac; color:#91a098; background:#0e1412; font-size:11px; line-height:1.65 }
.timeline { display:grid; }
.node-card { min-width:0; display:grid; grid-template-columns:32px minmax(0,1fr); gap:8px; }
.node-rail { display:grid; grid-template-rows:25px 1fr; justify-items:center }.node-rail span { width:24px; height:24px; display:grid; place-items:center; border:1px solid #38443f; border-radius:50%; color:#79867f; background:#121816; font-size:9px }.node-card.success .node-rail span { color:#86efac; border-color:#2c6444 }.node-card.active .node-rail span { color:#5eead4; border-color:#2c6f64 }.node-card.danger .node-rail span { color:#fda4af; border-color:#6e303c }.node-rail i { width:1px; min-height:16px; background:#2c3532 }
.node-card:last-child .node-rail i { background:linear-gradient(#2c3532,transparent) }
.node-body { min-width:0; margin-bottom:10px; padding:13px 14px; border:1px solid #29332f; border-radius:8px; background:#0e1412 }
.node-body > header { display:flex; justify-content:space-between; gap:15px }.node-body header > div { min-width:0 }.node-body header small { display:block; margin-bottom:3px; color:#67766e; font-size:8px; text-transform:uppercase }.node-body h4 { display:inline; margin:0 7px 0 0; color:#dfe8e3; font-size:13px }.node-body code { color:#617169; font-size:8px }
.node-meta { margin-top:7px }.progress-message { margin:8px 0 0; color:#a9b6af; font-size:10px }
.io-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:9px }.io-grid > div { min-width:0; display:flex; flex-wrap:wrap; gap:5px; padding:8px; border:1px solid #222c28; border-radius:5px }.io-grid strong { width:100%; color:#718078; font-size:8px }.io-grid span,.io-grid em { padding:2px 5px; color:#9dacA5; border-radius:3px; background:#17201d; font-size:8px; font-style:normal }
.receipt-box { display:grid; gap:4px; margin-top:9px; padding:8px 10px; border:1px solid #35413c; border-radius:5px; background:#151b18 }.receipt-box small { color:#87958e; font-size:8px }.receipt-box strong { color:#cbd5d0; font-size:10px }.receipt-box span { color:#829088; font-size:8px }
.receipt-box.receipt-success { border-color:#25543a; background:#10241a }.receipt-box.receipt-success small { color:#72c890 }.receipt-box.receipt-success strong { color:#9ae6b4 }.receipt-box.receipt-success span { color:#79aa8b }
.receipt-box.receipt-warning { border-color:#594b1e; background:#2a2410 }.receipt-box.receipt-warning small { color:#d6b84d }.receipt-box.receipt-warning strong { color:#fcd34d }.receipt-box.receipt-warning span { color:#bba45d }
.receipt-box.receipt-danger { border-color:#5b3038; background:#251317 }.receipt-box.receipt-danger small { color:#d58b98 }.receipt-box.receipt-danger strong { color:#f2adb8 }.receipt-box.receipt-danger span { color:#b37e86 }
.recovery-box { display:grid; gap:6px; margin-top:9px; padding:10px 12px; border:1px solid #3d5148; border-radius:7px; background:#14201b }
.recovery-box strong { color:#d9f7e8; font-size:11px }
.recovery-box p { margin:0; color:#a8bbb1; font-size:10px; line-height:1.55 }
.recovery-box ol { margin:0; padding-left:18px; color:#8fa69a; font-size:9px; line-height:1.65 }
.recovery-box.recovery-configuration_required { border-color:#806b31; background:#211d11 }
.recovery-box.recovery-configuration_required strong { color:#f6d878 }
.recovery-box.recovery-not_retryable { border-color:#693842; background:#211519 }
.recovery-box.recovery-not_retryable strong { color:#f3b4bf }
.recovery-box.recovery-manual_review { border-color:#48525b; background:#171c20 }
.recovery-box.recovery-manual_review strong { color:#d1d9e3 }
.node-body footer { display:flex; flex-wrap:wrap; gap:4px; margin-top:9px; padding-top:8px; border-top:1px solid #222b28 }
.empty-plan { padding:30px; border:1px dashed #34403b; color:#74817a; text-align:center; font-size:11px }
.audit-grid { display:grid; grid-template-columns:minmax(0,1.5fr) minmax(260px,.7fr); gap:12px }.events-card,.manual-card { padding:18px 20px }.events-card ol { max-height:400px; overflow:auto; margin:13px 0 0; padding:0; list-style:none }.events-card li { display:grid; grid-template-columns:115px minmax(0,1fr) auto; gap:12px; padding:9px 0; border-top:1px solid #222b28 }.events-card time,.events-card em { color:#607068; font-size:8px; font-style:normal }.events-card li > span { min-width:0; display:grid; gap:2px }.events-card strong { color:#c9d4ce; font-size:10px }.events-card small { color:#718078; font-size:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.manual-card h3 { margin:0; color:#dde7e1; font-size:17px }.manual-card > p { color:#7f8d86; font-size:10px; line-height:1.7 }.manual-links { display:grid; gap:6px; margin-top:12px }.manual-links button { display:grid; gap:3px; padding:10px; border:1px solid #2a3531; border-radius:6px; color:inherit; background:#0e1412; text-align:left; cursor:pointer }.manual-links button:hover { border-color:#3f6f64 }.manual-links strong { color:#bfd0c7; font-size:10px }.manual-links span { color:#65746c; font-size:8px }
.workspace-empty { min-height:520px; display:grid; place-items:center; align-content:center; border:1px dashed #303a36; border-radius:12px }.workspace-empty > span { color:#5eead4; font-size:48px }.workspace-empty h2 { margin:6px 0 0; font-size:18px }.workspace-empty p { max-width:560px; margin:0; }.workspace-empty-actions { display:flex; justify-content:center; gap:8px; flex-wrap:wrap; margin-top:12px }.workspace-error { border-color:#58442a; background:linear-gradient(145deg,#171511,#111715) }.workspace-error > span { width:44px; height:44px; display:grid; place-items:center; border:1px solid #8d6e36; border-radius:50%; color:#fcd34d; font-size:22px; font-weight:800 }.workspace-error h2 { color:#f1dfb1 }.workspace-error p { color:#a99a78 }.workspace-loading { min-height:500px; display:grid; place-items:center; color:#809087 }
.technical-json { max-height:60vh; overflow:auto; padding:14px; border-radius:6px; color:#b9c8c0; background:#0b100e; font-size:10px; line-height:1.6; white-space:pre-wrap }.dialog-note { color:#77857e; font-size:11px }.inline-error { padding:10px; color:#fda4af; font-size:10px }.inline-error button { color:#5eead4; border:0; background:none; cursor:pointer }.skeleton-stack { display:grid; gap:8px; padding:10px 0 }.skeleton-stack span { height:52px; border-radius:5px; background:linear-gradient(90deg,#151c19,#202925,#151c19); background-size:200%; animation:shimmer 1.2s infinite }@keyframes shimmer{to{background-position:-200%}}
.plan-editor-list { max-height:55vh; overflow:auto; display:grid; gap:10px; margin-bottom:12px }.plan-editor-node { padding:12px; border:1px solid #dfe5e2; border-radius:8px; background:#fafcfb }.plan-editor-node > header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px }.plan-editor-fields { display:grid; grid-template-columns:1.2fr 1.2fr .8fr .8fr; gap:8px 12px }.plan-editor-fields :deep(.el-form-item) { margin-bottom:4px }.plan-editor-fields .wide-field { grid-column:span 2 }
@media(max-width:1100px){.layout{grid-template-columns:240px minmax(0,1fr)}.metric-grid{grid-template-columns:1fr 1fr}.experience-grid{grid-template-columns:1fr}.audit-grid{grid-template-columns:1fr}.console-header nav{display:none}}
@media(max-width:760px){.console-header{position:static}.brand small{white-space:normal}.hero,.session-header{flex-direction:column}.layout{grid-template-columns:1fr}.sessions-panel{position:static;max-height:320px}.metric-grid{grid-template-columns:1fr}.io-grid{grid-template-columns:1fr}.events-card li{grid-template-columns:82px minmax(0,1fr)}.events-card em{display:none}.session-actions{justify-content:flex-start}.plan-editor-fields{grid-template-columns:1fr}.plan-editor-fields .wide-field{grid-column:auto}.plan-heading-actions{align-items:flex-start}}
@media(max-width:760px){.onboarding-card{flex-direction:column}.onboarding-status{min-width:0; justify-items:start; text-align:left}.onboarding-budget{max-width:none}}
</style>
