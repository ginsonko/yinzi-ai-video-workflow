<template>
  <div class="workflow-page" v-loading="loading">
    <header class="workflow-header">
      <div class="header-main">
        <el-button :icon="ArrowLeft" circle title="返回项目" @click="router.push('/')" />
        <div class="project-title">
          <strong>{{ drama?.title || 'AI 视频制作' }}</strong>
          <span>{{ currentEpisode?.title || '选择一集' }}</span>
        </div>
        <el-select v-if="episodes.length > 1" v-model="episodeId" class="episode-select" @change="loadEpisode">
          <el-option v-for="episode in episodes" :key="episode.id" :label="episode.title || `第 ${episode.episode_number} 集`" :value="episode.id" />
        </el-select>
      </div>
      <div class="header-actions">
        <el-button :icon="Setting" @click="router.push('/ai-config')">模型配置</el-button>
        <el-button :icon="Tools" @click="router.push(`/film/${dramaId}`)">高级模式</el-button>
      </div>
    </header>

    <nav class="workflow-steps" aria-label="制作进度">
      <button
        v-for="(step, index) in steps"
        :key="step.key"
        type="button"
        :class="['step-button', { active: activeStep === index, done: step.done }]"
        @click="goStep(index)"
      >
        <span class="step-index"><el-icon v-if="step.done"><Check /></el-icon><template v-else>{{ index + 1 }}</template></span>
        <span>{{ step.label }}</span>
      </button>
    </nav>

    <main class="workflow-main">
      <div v-if="preparing || preparationStatus || preparationErrors.length" class="preparation-panel" role="status" aria-live="polite">
        <div>
          <el-icon v-if="preparing" class="is-loading"><Loading /></el-icon>
          <el-icon v-else-if="preparationErrors.length" class="prep-error"><Close /></el-icon>
          <el-icon v-else><Check /></el-icon>
          <span>{{ preparationStatus || '准备流程已结束' }}</span>
        </div>
        <el-button v-if="preparing" size="small" @click="preparationAbortRequested = true">停止后续步骤</el-button>
        <el-button v-else-if="preparationErrors.length" size="small" @click="preparationErrors = []">收起错误</el-button>
        <ul v-if="preparationErrors.length">
          <li v-for="item in preparationErrors" :key="`${item.step}-${item.message}`"><strong>{{ item.step }}</strong>{{ item.message }}</li>
        </ul>
      </div>

      <section v-if="activeStep === 0" class="stage-band">
        <div class="stage-heading">
          <div><span class="stage-kicker">01</span><h1>剧本</h1></div>
          <el-tag :type="scriptReady ? 'success' : 'warning'">{{ scriptReady ? '已就绪' : '待补充' }}</el-tag>
        </div>
        <div class="script-layout">
          <el-input v-model="scriptDraft" type="textarea" :rows="16" :disabled="preparing" placeholder="粘贴剧本，或导入 .txt / .md 文件" />
          <aside class="stage-summary">
            <div><span>字数</span><strong>{{ scriptLength }}</strong></div>
            <div><span>角色</span><strong>{{ characters.length }}</strong></div>
            <div><span>场景</span><strong>{{ scenes.length }}</strong></div>
            <div><span>分镜</span><strong>{{ storyboards.length }}</strong></div>
          </aside>
        </div>
        <div class="stage-actions">
          <el-button :icon="Upload" :disabled="preparing" @click="pickScriptFile">导入文本</el-button>
          <el-button :icon="Edit" :loading="savingScript" :disabled="!scriptReady || preparing" @click="saveScriptDraft">保存剧本</el-button>
          <el-button type="primary" :icon="MagicStick" :loading="preparing" :disabled="!scriptReady" @click="runGuidedPreparation">一键准备到分镜选择</el-button>
        </div>
      </section>

      <section v-else-if="activeStep === 1" class="stage-band">
        <div class="stage-heading">
          <div><span class="stage-kicker">02</span><h1>角色与场景资产</h1></div>
          <el-tag :type="assetsReady ? 'success' : 'warning'">{{ assetsReady ? '可进入分镜' : `${missingAssetCount} 项待补图` }}</el-tag>
        </div>
        <div class="asset-section" v-for="group in assetGroups" :key="group.key">
          <div class="asset-section-title"><h2>{{ group.label }}</h2><span>{{ group.items.length }}</span></div>
          <div v-if="group.items.length" class="asset-strip">
            <article v-for="item in group.items" :key="`${group.key}-${item.id}`" class="asset-tile">
              <img v-if="assetImageUrl(item)" :src="assetImageUrl(item)" alt="" />
              <div v-else class="asset-empty"><el-icon><Picture /></el-icon></div>
              <div><strong>{{ assetName(group.key, item) }}</strong><span :class="{ missing: !assetImageUrl(item) }">{{ assetImageUrl(item) ? '已确认' : '缺少参考图' }}</span></div>
            </article>
          </div>
          <div v-else class="empty-line">暂无{{ group.label }}</div>
        </div>
        <div class="stage-actions">
          <el-button :icon="Tools" @click="router.push(`/film/${dramaId}`)">管理资产</el-button>
          <el-button :icon="MagicStick" :loading="preparing" :disabled="!characters.length && !scenes.length && !props.length" @click="generateMissingAssetImages(true)">补齐缺失参考图</el-button>
          <el-button type="primary" :disabled="!characters.length && !scenes.length" @click="goStep(2)">进入分镜选择<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
        </div>
      </section>

      <section v-else-if="activeStep === 2" class="stage-band">
        <div class="stage-heading">
          <div><span class="stage-kicker">03</span><h1>选择分镜</h1></div>
          <span class="selection-count">已选 {{ selectedBoards.length }}/{{ storyboards.length }}</span>
        </div>
        <div class="shot-list">
          <article v-for="board in storyboards" :key="board.id" :class="['shot-row', { selected: board.workflow_selected }]">
            <el-checkbox :model-value="board.workflow_selected" size="large" @change="(value) => setSelected(board, value)" />
            <div class="shot-number">#{{ board.storyboard_number }}</div>
            <img v-if="storyboardImageUrl(board)" :src="storyboardImageUrl(board)" alt="" />
            <div v-else class="shot-image-empty"><el-icon><Film /></el-icon></div>
            <div class="shot-copy">
              <div class="shot-title-row">
                <strong>{{ board.title || board.description || '未命名分镜' }}</strong>
                <el-button
                  size="small"
                  :icon="RefreshRight"
                  :loading="regeneratingBoardId === board.id"
                  :disabled="preparing && regeneratingBoardId !== board.id"
                  @click="regenerateStoryboardImage(board)"
                >重新生成</el-button>
              </div>
              <p>{{ board.action || board.video_prompt || board.description || '暂无动作描述' }}</p>
              <div class="shot-meta"><span>{{ board.shot_type || '镜头' }}</span><span>{{ board.movement || '固定' }}</span><span>{{ normalizedDuration(board) }} 秒</span></div>
            </div>
          </article>
          <div v-if="!storyboards.length" class="empty-line">尚未生成分镜，可返回剧本页一键准备。</div>
        </div>
        <div class="stage-actions">
          <el-button @click="setAllSelected(true)">全选</el-button>
          <el-button @click="setAllSelected(false)">清空</el-button>
          <el-button :icon="Picture" :loading="preparing" :disabled="selectedBoards.length === 0" @click="generateMissingStoryboardImages(true)">补齐所选分镜图</el-button>
          <el-button type="primary" :disabled="selectedBoards.length === 0" @click="goStep(3)">确认所选分镜<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
        </div>
      </section>

      <section v-else-if="activeStep === 3" class="stage-band">
        <div class="stage-heading">
          <div><span class="stage-kicker">04</span><h1>3D 预演与参考资产</h1></div>
          <span class="selection-count">{{ approvedCount }}/{{ selectedBoards.length }} 已确认</span>
        </div>
        <div class="reference-list">
          <article v-for="board in selectedBoards" :key="board.id" class="reference-shot" :id="`workflow-shot-${board.id}`">
            <div class="reference-shot-head">
              <div><span>#{{ board.storyboard_number }}</span><strong>{{ board.title || board.description || '未命名分镜' }}</strong></div>
              <div class="shot-head-actions">
                <el-tag v-if="board.workflow_approved_at" type="success">已确认</el-tag>
                <el-button :icon="Camera" @click="openDirector(board)">3D 导演台</el-button>
                <el-button :icon="MagicStick" @click="autoFillReferences(board)">智能配齐</el-button>
              </div>
            </div>
            <div class="reference-grid">
              <div v-for="bucket in referenceBuckets(board)" :key="bucket.type" class="reference-bucket">
                <div class="bucket-head"><span>{{ bucket.label }} {{ bucket.items.length }}/{{ bucket.limit }}</span><el-button :icon="Plus" circle size="small" :disabled="bucket.items.length >= bucket.limit" :title="`添加${bucket.label}`" @click="pickReference(board, bucket.type)" /></div>
                <div class="reference-items">
                  <div v-for="item in bucket.items" :key="item.path" class="reference-item">
                    <a v-if="bucket.type === 'images'" :href="mediaPath(item.path)" target="_blank" title="查看原图"><img :src="mediaPath(item.path)" alt="" /></a>
                    <el-icon v-else><VideoCamera v-if="bucket.type === 'videos'" /><Headset v-else /></el-icon>
                    <span :title="item.label || item.path"><strong>{{ item.label || fileLabel(item.path) }}</strong><small>{{ sourceLabel(item.source) }}</small></span>
                    <a v-if="bucket.type !== 'images'" :href="mediaPath(item.path)" target="_blank" title="预览或下载"><el-icon><Download /></el-icon></a>
                    <el-button :icon="Close" link title="移除" @click="removeReference(board, bucket.type, item.path)" />
                  </div>
                  <span v-if="!bucket.items.length" class="bucket-empty">未添加</span>
                </div>
              </div>
            </div>
            <div class="reference-shot-foot">
              <span>{{ referenceTotal(board) }} 个参考媒体</span>
              <el-button type="primary" plain :disabled="referenceTotal(board) === 0" @click="approveBoard(board)">{{ board.workflow_approved_at ? '重新确认' : '确认此分镜' }}</el-button>
            </div>
          </article>
        </div>
        <div class="stage-actions">
          <el-button @click="autoFillAll">全部智能配齐</el-button>
          <el-button type="primary" :disabled="!allSelectedApproved" @click="goStep(4)">进入生成确认<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
        </div>
      </section>

      <section v-else class="stage-band">
        <div class="stage-heading">
          <div><span class="stage-kicker">05</span><h1>生成与下载</h1></div>
          <el-tag :type="completedCount === selectedBoards.length && selectedBoards.length ? 'success' : 'info'">{{ completedCount }}/{{ selectedBoards.length }} 已完成</el-tag>
        </div>
        <div class="generation-toolbar">
          <div><label>视频模型</label><el-select v-model="videoModel"><el-option v-for="model in supportedVideoModels" :key="model.model" :label="model.model" :value="model.model" /></el-select></div>
          <div class="capability-line"><span>4 图</span><span>3 视频</span><span>1 音频</span><span>5-15 秒</span><span>480p</span></div>
          <el-button type="primary" size="large" :icon="VideoPlay" :loading="generating" :disabled="!allSelectedApproved || generating" @click="confirmAndGenerate">生成所选分镜</el-button>
        </div>
        <div class="output-list">
          <article v-for="board in selectedBoards" :key="board.id" class="output-row">
            <div class="output-shot"><span>#{{ board.storyboard_number }}</span><strong>{{ board.title || board.description || '未命名分镜' }}</strong></div>
            <div v-if="latestVideo(board.id)?.status === 'completed' && playableVideoUrl(latestVideo(board.id))" class="output-media">
              <video :src="playableVideoUrl(latestVideo(board.id))" controls preload="metadata" />
              <div class="download-actions">
                <a :href="playableVideoUrl(latestVideo(board.id))" :download="`shot-${board.storyboard_number}.mp4`"><el-icon><Download /></el-icon>下载成片</a>
                <el-button link :icon="CopyDocument" @click="copyAssetAddress(latestVideo(board.id))">复制下载地址</el-button>
              </div>
            </div>
            <div v-else class="output-state">
              <el-icon v-if="shotStates[board.id]?.status === 'processing'" class="is-loading"><Loading /></el-icon>
              <span>{{ outputStatusText(board) }}</span>
              <small v-if="shotStates[board.id]?.error">{{ shotStates[board.id].error }}</small>
            </div>
          </article>
        </div>
        <section v-if="unboundCompletedVideos.length" class="asset-library">
          <div class="asset-library-head"><div><span>项目资产库</span><strong>可复用的历史成片</strong></div><small>这些视频未绑定到当前分镜，仍可下载或作为参考视频使用。</small></div>
          <div class="asset-library-list">
            <article v-for="item in unboundCompletedVideos" :key="item.id">
              <video :src="playableVideoUrl(item)" controls preload="metadata" />
              <div><strong>{{ item.prompt || `视频资产 #${item.id}` }}</strong><span>{{ item.duration || 5 }} 秒 · {{ item.resolution || '480p' }}</span></div>
              <div class="download-actions"><a :href="playableVideoUrl(item)" :download="`project-video-${item.id}.mp4`"><el-icon><Download /></el-icon>下载</a><el-button link :icon="CopyDocument" @click="copyAssetAddress(item)">复制地址</el-button></div>
            </article>
          </div>
        </section>
      </section>
    </main>

    <el-dialog v-model="referencePicker.visible" :title="`为分镜 #${referencePicker.board?.storyboard_number || ''} 添加${referenceTypeLabel(referencePicker.type)}`" width="min(760px, 92vw)" destroy-on-close>
      <div class="picker-toolbar">
        <span>从当前项目选择，或上传自己的文件。已添加的资产会保留，智能配齐只补空位。</span>
        <el-button type="primary" :icon="Upload" @click="uploadReferenceFromPicker">上传文件</el-button>
      </div>
      <div v-if="referenceCandidates.length" class="candidate-grid">
        <button v-for="item in referenceCandidates" :key="`${referencePicker.type}-${item.path}`" type="button" :disabled="candidateAlreadySelected(item)" @click="selectReferenceCandidate(item)">
          <img v-if="referencePicker.type === 'images'" :src="mediaPath(item.path)" alt="" />
          <video v-else-if="referencePicker.type === 'videos'" :src="mediaPath(item.path)" muted preload="metadata" />
          <el-icon v-else><Headset /></el-icon>
          <span><strong>{{ item.label }}</strong><small>{{ candidateAlreadySelected(item) ? '已添加' : sourceLabel(item.source) }}</small></span>
        </button>
      </div>
      <el-empty v-else description="当前项目还没有这类资产，可直接上传" :image-size="72" />
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft, ArrowRight, Camera, Check, Close, CopyDocument, Download, Edit, Film, Headset,
  Loading, MagicStick, Picture, Plus, RefreshRight, Setting, Tools, Upload, VideoCamera, VideoPlay,
} from '@element-plus/icons-vue'
import { dramaAPI } from '@/api/drama'
import { generationAPI } from '@/api/generation'
import { characterAPI } from '@/api/characters'
import { propAPI } from '@/api/props'
import { sceneAPI } from '@/api/scenes'
import { imagesAPI } from '@/api/images'
import { storyboardsAPI } from '@/api/storyboards'
import { uploadAPI } from '@/api/upload'
import { videosAPI } from '@/api/videos'
import { taskAPI } from '@/api/task'
import { aiAPI } from '@/api/ai'
import { mergeWorkflowReferences, normalizeWorkflowReferences } from '@/utils/workflowReferences'
import { hasStoryboardVisual } from '@/utils/workflowAssets'

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)
const loading = ref(true)
const drama = ref(null)
const episodeId = ref(null)
const storyboards = ref([])
const videosByStoryboard = reactive({})
const projectVideos = ref([])
const shotStates = reactive({})
const activeStep = ref(0)
const videoModel = ref('mg-seedance2.0 -480p mini')
const videoCatalog = ref([])
const generating = ref(false)
const scriptDraft = ref('')
const savingScript = ref(false)
const preparing = ref(false)
const regeneratingBoardId = ref(null)
const preparationStatus = ref('')
const preparationErrors = ref([])
const preparationAbortRequested = ref(false)
const referencePicker = reactive({ visible: false, board: null, type: 'images' })

const episodes = computed(() => drama.value?.episodes || [])
const currentEpisode = computed(() => episodes.value.find((item) => Number(item.id) === Number(episodeId.value)) || null)
const characters = computed(() => drama.value?.characters || [])
const scenes = computed(() => drama.value?.scenes || [])
const props = computed(() => drama.value?.props || [])
const scriptLength = computed(() => scriptDraft.value.trim().length)
const scriptReady = computed(() => scriptLength.value > 0)
const missingAssetCount = computed(() => [...characters.value, ...scenes.value, ...props.value].filter((item) => !assetImageUrl(item)).length)
const assetsReady = computed(() => (characters.value.length + scenes.value.length > 0) && missingAssetCount.value === 0)
const selectedBoards = computed(() => storyboards.value.filter((item) => item.workflow_selected !== false))
const approvedCount = computed(() => selectedBoards.value.filter((item) => item.workflow_approved_at).length)
const allSelectedApproved = computed(() => selectedBoards.value.length > 0 && approvedCount.value === selectedBoards.value.length)
const completedCount = computed(() => selectedBoards.value.filter((board) => latestVideo(board.id)?.status === 'completed').length)
const unboundCompletedVideos = computed(() => projectVideos.value.filter((item) => item.status === 'completed' && !item.storyboard_id && playableVideoUrl(item)))
const referenceCandidates = computed(() => collectReferenceCandidates(referencePicker.board, referencePicker.type))
const supportedVideoModels = computed(() => videoCatalog.value.filter((item) => item.capabilities?.max_videos === 3 && item.capabilities?.max_images === 4))
const steps = computed(() => [
  { key: 'script', label: '剧本', done: scriptReady.value },
  { key: 'assets', label: '资产', done: assetsReady.value },
  { key: 'storyboards', label: '分镜', done: selectedBoards.value.length > 0 },
  { key: 'director', label: '预演与参考', done: allSelectedApproved.value },
  { key: 'generate', label: '生成与下载', done: completedCount.value > 0 && completedCount.value === selectedBoards.value.length },
])
const assetGroups = computed(() => [
  { key: 'characters', label: '角色', items: characters.value },
  { key: 'scenes', label: '场景', items: scenes.value },
  { key: 'props', label: '道具', items: props.value },
])

function stageIndex(value) {
  const index = steps.value.findIndex((step) => step.key === value)
  return index >= 0 ? index : 0
}
function goStep(index) {
  activeStep.value = Math.max(0, Math.min(4, Number(index) || 0))
  router.replace({ query: { ...route.query, stage: steps.value[activeStep.value].key } })
}
function mediaPath(path) {
  if (!path) return ''
  if (/^(https?:|data:|blob:)/i.test(path)) return path
  return `/static/${String(path).replace(/^\//, '')}`
}
function assetImageUrl(item) {
  return mediaPath(item?.four_view_image_url || item?.local_path || item?.image_url || '')
}
function storyboardImageUrl(board) {
  return mediaPath(board.director_frame_path || board.local_path || board.image_url || board.background?.local_path || board.background?.image_url || '')
}
function assetName(type, item) {
  if (type === 'scenes') return item.location || item.name || '未命名场景'
  return item.name || item.title || '未命名资产'
}
function normalizedDuration(board) {
  return Math.max(5, Math.min(15, Math.round(Number(board.duration) || 5)))
}
function normalizeReferences(value) {
  return normalizeWorkflowReferences(value)
}
function referenceBuckets(board) {
  const refs = normalizeReferences(board.workflow_references)
  return [
    { type: 'images', label: '参考图', limit: 4, items: refs.images },
    { type: 'videos', label: '参考视频', limit: 3, items: refs.videos },
    { type: 'audios', label: '参考音频', limit: 1, items: refs.audios },
  ]
}
function referenceTotal(board) {
  return referenceBuckets(board).reduce((sum, bucket) => sum + bucket.items.length, 0)
}
function fileLabel(path) {
  return String(path || '').split(/[\\/]/).pop() || '参考媒体'
}
function sourceLabel(source) {
  return ({ upload: '手动上传', director: '3D 预演', storyboard: '分镜资产', character: '角色定妆', scene: '场景资产', prop: '道具资产', output: '历史成片' })[source] || '项目资产'
}
function referenceTypeLabel(type) {
  return ({ images: '参考图', videos: '参考视频', audios: '参考音频' })[type] || '参考资产'
}
function hasAssetImage(item) {
  return Boolean(item?.four_view_image_url || item?.local_path || item?.image_url)
}
function ensurePreparationContinues() {
  if (preparationAbortRequested.value) throw new Error('已停止后续准备步骤；当前已完成的内容会保留。')
}
function preparationTaskId(result) {
  return result?.task_id || result?.image_generation?.task_id || null
}
function preparationTaskError(task) {
  return task?.error || task?.error_message || task?.message || '任务执行失败'
}
async function waitForAsyncTask(taskId) {
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    ensurePreparationContinues()
    const task = await taskAPI.get(taskId)
    if (task.status === 'completed') return task
    if (task.status === 'failed' || task.status === 'cancelled') throw new Error(preparationTaskError(task))
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`任务 ${taskId} 仍在处理中；任务已保存，请稍后刷新，勿重复提交。`)
}
async function reloadProject({ syncDraft = false } = {}) {
  const wantedEpisodeId = Number(episodeId.value) || null
  drama.value = await dramaAPI.get(dramaId)
  episodeId.value = episodes.value.some((item) => Number(item.id) === wantedEpisodeId)
    ? wantedEpisodeId
    : (episodes.value[0]?.id || null)
  if (syncDraft) scriptDraft.value = currentEpisode.value?.script_content || ''
  await loadEpisode({ syncDraft })
}
async function saveScriptDraft({ quiet = false } = {}) {
  if (!scriptDraft.value.trim()) throw new Error('请先粘贴或导入剧本。')
  savingScript.value = true
  try {
    const currentId = Number(episodeId.value) || null
    const payload = episodes.value.map((episode, index) => ({
      episode_number: Number(episode.episode_number) || index + 1,
      title: episode.title || `第 ${index + 1} 集`,
      script_content: Number(episode.id) === currentId ? scriptDraft.value.trim() : (episode.script_content || ''),
      description: episode.description || null,
      duration: Number(episode.duration) || 0,
    }))
    if (!payload.length) {
      payload.push({ episode_number: 1, title: '第 1 集', script_content: scriptDraft.value.trim(), description: null, duration: 0 })
    }
    await dramaAPI.saveEpisodes(dramaId, payload)
    await reloadProject({ syncDraft: true })
    if (!quiet) ElMessage.success('剧本已保存')
    return currentEpisode.value
  } finally {
    savingScript.value = false
  }
}
function pickScriptFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.txt,.md,text/plain,text/markdown'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) return ElMessage.error('剧本文件不能超过 2 MB')
    scriptDraft.value = await file.text()
    ElMessage.success(`已导入 ${file.name}`)
  }
  input.click()
}
async function submitPreparationStep(label, submit) {
  ensurePreparationContinues()
  preparationStatus.value = label
  const result = await submit()
  const taskId = preparationTaskId(result)
  if (taskId) await waitForAsyncTask(taskId)
  await reloadProject()
  ensurePreparationContinues()
  return result
}
function recordPreparationError(step, error) {
  preparationErrors.value.push({ step, message: String(error?.message || error).slice(0, 300) })
}
async function prepareTextStructure() {
  await saveScriptDraft({ quiet: true })
  ensurePreparationContinues()
  if (!characters.value.length) {
    await submitPreparationStep('正在从剧本提取角色设定', () => generationAPI.generateCharacters(dramaId, {
      episode_id: episodeId.value,
      outline: scriptDraft.value.trim(),
    }))
  }
  if (!scenes.value.length) {
    await submitPreparationStep('正在提取场景设定', () => dramaAPI.extractBackgrounds(episodeId.value, {
      style: drama.value?.style,
      language: 'zh',
    }))
  }
  if (!props.value.length) {
    try {
      await submitPreparationStep('正在提取关键道具', () => propAPI.extractFromScript(episodeId.value))
    } catch (error) {
      recordPreparationError('道具提取', error)
      await reloadProject()
    }
  }
  if (!storyboards.value.length) {
    const storyboardCount = Math.max(3, Math.min(8, Math.ceil(scriptLength.value / 180)))
    await submitPreparationStep('正在生成可选择的分镜方案', () => dramaAPI.generateStoryboard(episodeId.value, {
      style: drama.value?.style,
      aspect_ratio: drama.value?.metadata?.aspect_ratio || '16:9',
      storyboard_count: storyboardCount,
      video_duration: storyboardCount * 5,
      include_narration: true,
      universal_omni_storyboard: true,
    }))
  }
}
async function generateMissingAssetImages(askForConfirmation = true) {
  if (askForConfirmation) {
    await ElMessageBox.confirm('将调用生图接口补齐缺失的角色四视图、场景参考图和道具图，不会生成视频。已有图片会跳过。', '补齐资产参考图', {
      confirmButtonText: '开始补图', cancelButtonText: '暂不生成', type: 'warning',
    })
    preparing.value = true
    preparationAbortRequested.value = false
    preparationErrors.value = []
  }
  try {
    const jobs = [
      ...characters.value.filter((item) => !hasAssetImage(item)).map((item) => ({
        label: `角色四视图：${assetName('characters', item)}`,
        submit: () => characterAPI.generateImage(item.id, undefined, drama.value?.style),
      })),
      ...scenes.value.filter((item) => !hasAssetImage(item)).map((item) => ({
        label: `场景参考图：${assetName('scenes', item)}`,
        submit: () => sceneAPI.generateImage({ scene_id: item.id, style: drama.value?.style, use_quad_grid: true }),
      })),
      ...props.value.filter((item) => !hasAssetImage(item)).map((item) => ({
        label: `道具参考图：${assetName('props', item)}`,
        submit: () => propAPI.generateImage(item.id, undefined, drama.value?.style),
      })),
    ]
    for (const job of jobs) {
      try {
        await submitPreparationStep(`正在生成${job.label}`, job.submit)
      } catch (error) {
        if (preparationAbortRequested.value) throw error
        recordPreparationError(job.label, error)
      }
    }
    await reloadProject()
  } finally {
    if (askForConfirmation) {
      preparing.value = false
      preparationStatus.value = preparationErrors.value.length ? '资产补图完成，但有项目需要检查' : '资产参考图已补齐'
    }
  }
}
async function generateMissingStoryboardImages(askForConfirmation = true) {
  if (askForConfirmation) {
    await ElMessageBox.confirm('将为已选且缺图的分镜生成参考图，不会生成视频。已有分镜图会跳过。', '补齐分镜图', {
      confirmButtonText: '开始生成', cancelButtonText: '暂不生成', type: 'warning',
    })
    preparing.value = true
    preparationAbortRequested.value = false
    preparationErrors.value = []
  }
  try {
    const boards = selectedBoards.value.filter((board) => !hasStoryboardVisual(board))
    for (const board of boards) {
      try {
        await submitStoryboardImage(board)
      } catch (error) {
        if (preparationAbortRequested.value) throw error
        recordPreparationError(`分镜 #${board.storyboard_number}`, error)
      }
    }
    await reloadProject()
  } finally {
    if (askForConfirmation) {
      preparing.value = false
      preparationStatus.value = preparationErrors.value.length ? '分镜图生成完成，但有项目需要检查' : '所选分镜图已补齐'
    }
  }
}
async function submitStoryboardImage(board) {
  return submitPreparationStep(`正在生成分镜 #${board.storyboard_number} 参考图`, () => imagesAPI.create({
    storyboard_id: board.id,
    drama_id: dramaId,
    prompt: board.polished_prompt || board.image_prompt || board.description || board.action,
    style: drama.value?.style,
    aspect_ratio: drama.value?.metadata?.aspect_ratio || '16:9',
  }))
}
async function regenerateStoryboardImage(board) {
  await ElMessageBox.confirm(
    `将重新生成分镜 #${board.storyboard_number} 的参考图。当前图片会保留在历史记录中，本次只调用生图额度，不会生成视频。`,
    '重新生成分镜图',
    { confirmButtonText: '确认重新生成', cancelButtonText: '返回审核', type: 'warning' },
  )
  preparing.value = true
  regeneratingBoardId.value = board.id
  preparationAbortRequested.value = false
  preparationErrors.value = []
  try {
    await submitStoryboardImage(board)
    preparationStatus.value = `分镜 #${board.storyboard_number} 已重新生成，请审核角色与场景一致性`
    ElMessage.success(`分镜 #${board.storyboard_number} 已重新生成`)
  } catch (error) {
    recordPreparationError(`分镜 #${board.storyboard_number}`, error)
    preparationStatus.value = `分镜 #${board.storyboard_number} 重新生成失败，旧图仍已保留`
    ElMessage.error(preparationStatus.value)
  } finally {
    preparing.value = false
    regeneratingBoardId.value = null
  }
}
async function runGuidedPreparation() {
  await ElMessageBox.confirm('将保存剧本，并调用文字与生图接口自动准备角色四视图、场景、道具和分镜参考图。流程会停在人工审核，不会提交任何视频任务。', '一键准备制作方案', {
    confirmButtonText: '开始准备', cancelButtonText: '返回修改剧本', type: 'warning',
  })
  preparing.value = true
  preparationAbortRequested.value = false
  preparationErrors.value = []
  try {
    await prepareTextStructure()
    await generateMissingAssetImages(false)
    await generateMissingStoryboardImages(false)
    await reloadProject({ syncDraft: true })
    preparationStatus.value = preparationErrors.value.length ? '准备完成，但有项目需要检查或重试' : '制作方案已准备好，请先审核角色和场景资产'
    goStep(1)
    ElMessage.success('已准备到人工审核节点，不会自动生成视频')
  } catch (error) {
    recordPreparationError('准备流程', error)
    preparationStatus.value = '准备流程已停止，已完成的内容会保留'
    ElMessage.error(error.message || '准备流程已停止')
  } finally {
    preparing.value = false
  }
}
async function refreshBoard(boardId) {
  const updated = await storyboardsAPI.get(boardId)
  const index = storyboards.value.findIndex((item) => item.id === boardId)
  if (index >= 0) storyboards.value.splice(index, 1, updated)
  return updated
}
async function setSelected(board, value) {
  await storyboardsAPI.update(board.id, { workflow_selected: Boolean(value), workflow_approved_at: null })
  await refreshBoard(board.id)
}
async function setAllSelected(value) {
  await Promise.all(storyboards.value.map((board) => storyboardsAPI.update(board.id, { workflow_selected: Boolean(value), workflow_approved_at: null })))
  await loadEpisode()
}
function collectAutoReferences(board) {
  const images = []
  const pushImage = (path, label, source) => {
    if (path && !images.some((item) => item.path === path) && images.length < 4) images.push({ path, label, source })
  }
  pushImage(board.director_frame_path, '3D 导演台确认帧', 'director')
  for (const charId of board.characters || []) {
    const char = characters.value.find((item) => Number(item.id) === Number(typeof charId === 'object' ? charId.id : charId))
    pushImage(char?.four_view_image_url || char?.local_path || char?.image_url, `角色：${char?.name || ''}`, 'character')
  }
  const scene = scenes.value.find((item) => Number(item.id) === Number(board.scene_id)) || board.background
  pushImage(scene?.local_path || scene?.image_url, '场景资产', 'scene')
  pushImage(board.local_path || board.image_url, '分镜参考图', 'storyboard')
  const videos = board.director_preview_path ? [{ path: board.director_preview_path, label: '3D 导演台预演', source: 'director' }] : []
  const audioPath = board.audio_local_path || board.narration_audio_local_path
  const audios = audioPath ? [{ path: audioPath, label: '分镜对白/旁白', source: 'storyboard' }] : []
  return { images, videos, audios }
}
async function autoFillReferences(board) {
  const refs = mergeWorkflowReferences(board.workflow_references, collectAutoReferences(board))
  if (!refs.images.length && !refs.videos.length && !refs.audios.length) return ElMessage.warning('此分镜暂时没有可用资产')
  await storyboardsAPI.update(board.id, { workflow_references: refs, workflow_approved_at: null })
  await refreshBoard(board.id)
  ElMessage.success(`分镜 #${board.storyboard_number} 已配齐可用参考`)
}
async function autoFillAll() {
  for (const board of selectedBoards.value) await autoFillReferences(board)
}
function pickReference(board, type) {
  referencePicker.board = board
  referencePicker.type = type
  referencePicker.visible = true
}
function collectReferenceCandidates(board, type) {
  if (!board) return []
  const candidates = []
  const add = (path, label, source) => {
    if (path && !candidates.some((item) => item.path === path)) candidates.push({ path, label, source })
  }
  if (type === 'images') {
    add(board.director_frame_path, `分镜 #${board.storyboard_number} 导演确认帧`, 'director')
    for (const item of characters.value) add(item.four_view_image_url || item.local_path || item.image_url, `角色：${item.name || '未命名'}`, 'character')
    for (const item of scenes.value) add(item.local_path || item.image_url, `场景：${item.location || item.name || '未命名'}`, 'scene')
    for (const item of props.value) add(item.local_path || item.image_url, `道具：${item.name || item.title || '未命名'}`, 'prop')
    for (const item of storyboards.value) {
      add(item.director_frame_path, `分镜 #${item.storyboard_number} 导演确认帧`, 'director')
      add(item.local_path || item.image_url, `分镜 #${item.storyboard_number} 参考图`, 'storyboard')
    }
  } else if (type === 'videos') {
    for (const item of storyboards.value) add(item.director_preview_path, `分镜 #${item.storyboard_number} 3D 预演`, 'director')
    for (const item of projectVideos.value.filter((video) => video.status === 'completed')) add(item.local_path || item.video_url, `历史成片 #${item.id}`, 'output')
  } else {
    for (const item of storyboards.value) {
      add(item.audio_local_path, `分镜 #${item.storyboard_number} 对白`, 'storyboard')
      add(item.narration_audio_local_path, `分镜 #${item.storyboard_number} 旁白`, 'storyboard')
    }
  }
  return candidates
}
function candidateAlreadySelected(item) {
  const board = referencePicker.board
  return Boolean(board && normalizeReferences(board.workflow_references)[referencePicker.type].some((entry) => entry.path === item.path))
}
async function addReference(board, type, item) {
  const refs = mergeWorkflowReferences(board.workflow_references, { [type]: [item] })
  await storyboardsAPI.update(board.id, { workflow_references: refs, workflow_approved_at: null })
  referencePicker.board = await refreshBoard(board.id)
}
async function selectReferenceCandidate(item) {
  if (!referencePicker.board || candidateAlreadySelected(item)) return
  await addReference(referencePicker.board, referencePicker.type, item)
  ElMessage.success(`${item.label} 已加入参考`)
}
function uploadReferenceFromPicker() {
  const board = referencePicker.board
  const type = referencePicker.type
  if (!board) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = type === 'images' ? 'image/*' : type === 'videos' ? 'video/*' : 'audio/*'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const uploaded = await uploadAPI.uploadReferenceMedia(file)
    await addReference(board, type, { path: uploaded.local_path, label: file.name, source: 'upload' })
    ElMessage.success(`${file.name} 已上传并加入参考`)
  }
  input.click()
}
async function removeReference(board, type, path) {
  const refs = normalizeReferences(board.workflow_references)
  refs[type] = refs[type].filter((item) => item.path !== path)
  await storyboardsAPI.update(board.id, { workflow_references: refs, workflow_approved_at: null })
  await refreshBoard(board.id)
}
async function approveBoard(board) {
  if (!referenceTotal(board)) return
  await storyboardsAPI.update(board.id, { workflow_approved_at: new Date().toISOString() })
  await refreshBoard(board.id)
}
function openDirector(board) {
  router.push({ path: `/director/${dramaId}`, query: { storyboard: board.id } })
}
async function loadVideoForBoard(boardId) {
  const result = await videosAPI.list({ storyboard_id: boardId, page: 1, page_size: 30 })
  videosByStoryboard[boardId] = result?.items || []
}
function latestVideo(boardId) {
  return (videosByStoryboard[boardId] || []).slice().sort((a, b) => Number(b.id) - Number(a.id))[0] || null
}
function playableVideoUrl(item) {
  if (!item) return ''
  return mediaPath(item.local_path || item.video_url || '')
}
async function copyAssetAddress(item) {
  const value = playableVideoUrl(item)
  if (!value) return
  const address = new URL(value, window.location.origin).href
  await navigator.clipboard.writeText(address)
  ElMessage.success('下载地址已复制')
}
function outputStatusText(board) {
  const state = shotStates[board.id]
  if (state?.status === 'processing') return '正在生成并下载到本地'
  if (state?.status === 'failed') return '生成失败，可保留资产后调整'
  const item = latestVideo(board.id)
  if (item?.status === 'failed') return item.error_msg || '上一次生成失败'
  return '等待生成'
}
async function pollVideoTask(taskId, boardId) {
  const deadline = Date.now() + 20 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const task = await taskAPI.get(taskId)
    if (task.status === 'completed') {
      await loadVideoForBoard(boardId)
      await loadProjectVideos()
      return { ok: true }
    }
    if (task.status === 'failed') return { ok: false, error: task.error || task.message || '生成失败' }
  }
  return { ok: false, error: '轮询超时；任务 ID 已保留，请勿重复提交' }
}
async function confirmAndGenerate() {
  const count = selectedBoards.value.length
  await ElMessageBox.confirm(`将按顺序提交 ${count} 个已确认分镜。每个分镜都是独立付费任务，遇到失败将停止后续提交。`, '确认付费生成', { confirmButtonText: '确认生成', cancelButtonText: '返回检查', type: 'warning' })
  generating.value = true
  try {
    for (const board of selectedBoards.value) {
      shotStates[board.id] = { status: 'processing', error: '' }
      const refs = normalizeReferences(board.workflow_references)
      let created
      try {
        created = await videosAPI.create({
          drama_id: dramaId,
          storyboard_id: board.id,
          prompt: board.video_prompt || board.universal_segment_text || board.action || board.description,
          model: videoModel.value,
          duration: normalizedDuration(board),
          aspect_ratio: drama.value?.metadata?.aspect_ratio || '16:9',
          resolution: '480p',
          watermark: false,
          reference_image_urls: refs.images.map((item) => item.path),
          reference_video_urls: refs.videos.map((item) => item.path),
          reference_audio_urls: refs.audios.map((item) => item.path),
        })
      } catch (error) {
        shotStates[board.id] = { status: 'failed', error: `提交结果不明确：${error.message}` }
        ElMessage.error('提交中断；不会自动重试或继续后续分镜')
        break
      }
      if (!created?.task_id) {
        shotStates[board.id] = { status: 'failed', error: '未返回本地任务 ID' }
        break
      }
      const settled = await pollVideoTask(created.task_id, board.id)
      if (!settled.ok) {
        shotStates[board.id] = { status: 'failed', error: settled.error }
        ElMessage.error(`分镜 #${board.storyboard_number} 失败，已停止后续提交`)
        break
      }
      shotStates[board.id] = { status: 'completed', error: '' }
    }
  } finally {
    generating.value = false
  }
}
async function loadEpisode({ syncDraft = true } = {}) {
  if (!episodeId.value) {
    storyboards.value = []
    if (syncDraft) scriptDraft.value = ''
    return
  }
  if (syncDraft) scriptDraft.value = currentEpisode.value?.script_content || ''
  const result = await dramaAPI.getStoryboards(episodeId.value)
  storyboards.value = Array.isArray(result)
    ? result
    : (Array.isArray(result?.storyboards) ? result.storyboards : (Array.isArray(result?.items) ? result.items : []))
  await Promise.all(storyboards.value.map((board) => loadVideoForBoard(board.id)))
}
async function loadProjectVideos() {
  const result = await videosAPI.list({ drama_id: dramaId, page: 1, page_size: 100 })
  projectVideos.value = result?.items || []
}
async function loadAll() {
  loading.value = true
  try {
    drama.value = await dramaAPI.get(dramaId)
    episodeId.value = Number(route.query.episode) || episodes.value[0]?.id || null
    await Promise.all([loadEpisode({ syncDraft: true }), loadProjectVideos()])
    try {
      const catalog = await aiAPI.getYinziCatalog()
      videoCatalog.value = catalog?.video || []
      if (supportedVideoModels.value.length && !supportedVideoModels.value.some((item) => item.model === videoModel.value)) videoModel.value = supportedVideoModels.value[0].model
    } catch (_) {}
    activeStep.value = stageIndex(route.query.stage)
    if (route.query.storyboard) requestAnimationFrame(() => document.getElementById(`workflow-shot-${route.query.storyboard}`)?.scrollIntoView({ block: 'center' }))
  } finally {
    loading.value = false
  }
}

onMounted(loadAll)
</script>

<style scoped>
.workflow-page { min-height: 100vh; background: #f4f6f8; color: #1e2832; }
.workflow-header { height: 68px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; background: #fff; border-bottom: 1px solid #dfe4e8; position: sticky; top: 0; z-index: 20; }
.header-main, .header-actions, .project-title, .stage-heading, .stage-actions, .reference-shot-head, .shot-head-actions, .reference-shot-foot { display: flex; align-items: center; }
.header-main { gap: 14px; min-width: 0; }.project-title { align-items: flex-start; flex-direction: column; min-width: 180px; }.project-title strong { font-size: 17px; }.project-title span { color: #7a858f; font-size: 12px; }.episode-select { width: 180px; }.header-actions { gap: 8px; }
.workflow-steps { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); max-width: 1120px; margin: 24px auto 0; padding: 0 24px; }
.step-button { min-height: 54px; border: 0; border-bottom: 2px solid #ccd4da; background: transparent; display: flex; align-items: center; justify-content: center; gap: 9px; color: #7a858f; cursor: pointer; font-size: 14px; }.step-button.active { border-color: #21796f; color: #174f49; font-weight: 700; }.step-button.done { color: #21796f; }.step-index { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: #e6eaed; font-size: 12px; }.active .step-index, .done .step-index { background: #21796f; color: #fff; }
.workflow-main { max-width: 1120px; margin: 0 auto; padding: 28px 24px 64px; }.stage-band { background: #fff; border: 1px solid #dfe4e8; border-radius: 6px; padding: 28px; }.stage-heading { justify-content: space-between; margin-bottom: 24px; }.stage-heading > div { display: flex; align-items: baseline; gap: 12px; }.stage-heading h1 { margin: 0; font-size: 24px; letter-spacing: 0; }.stage-kicker { color: #21796f; font-size: 12px; font-weight: 800; }.selection-count { color: #61707c; font-size: 14px; }
.preparation-panel { margin-bottom: 14px; padding: 12px 14px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid #c9ddd8; background: #f2f8f6; color: #285f57; font-size: 13px; }.preparation-panel > div { display: flex; align-items: center; gap: 8px; min-width: 0; }.preparation-panel ul { flex-basis: 100%; margin: 0; padding: 8px 0 0 24px; color: #9c4d43; }.preparation-panel li + li { margin-top: 4px; }.preparation-panel li strong { margin-right: 8px; }.prep-error { color: #bd5a4c; }
.script-layout { display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 20px; }.stage-summary { border-left: 1px solid #e5e9ec; padding-left: 20px; display: grid; align-content: start; gap: 15px; }.stage-summary div { display: flex; justify-content: space-between; align-items: baseline; }.stage-summary span { color: #7b8790; font-size: 13px; }.stage-summary strong { font-size: 22px; }.stage-actions { justify-content: flex-end; gap: 10px; border-top: 1px solid #e5e9ec; margin-top: 24px; padding-top: 20px; }
.asset-section + .asset-section { margin-top: 26px; }.asset-section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }.asset-section-title h2 { margin: 0; font-size: 15px; }.asset-section-title span { color: #82909a; }.asset-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }.asset-tile { min-width: 0; border: 1px solid #e1e6e9; border-radius: 5px; overflow: hidden; background: #fafbfb; }.asset-tile img, .asset-empty { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }.asset-empty { display: grid; place-items: center; color: #a9b2b9; background: #eef1f2; font-size: 28px; }.asset-tile > div:last-child { padding: 10px; display: flex; justify-content: space-between; gap: 8px; }.asset-tile strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.asset-tile span { color: #2d806f; font-size: 12px; white-space: nowrap; }.asset-tile span.missing { color: #bd6b31; }.empty-line { padding: 18px; color: #87939c; background: #f7f8f9; }
.shot-list, .reference-list, .output-list { display: grid; gap: 12px; }.shot-row { display: grid; grid-template-columns: 32px 48px 150px minmax(0, 1fr); align-items: center; gap: 14px; border: 1px solid #e0e5e8; border-radius: 5px; padding: 12px; opacity: .62; }.shot-row.selected { opacity: 1; border-color: #9bc9c1; background: #f8fcfb; }.shot-number { font-weight: 800; color: #21796f; }.shot-row img, .shot-image-empty { width: 150px; aspect-ratio: 16 / 9; object-fit: cover; background: #edf0f2; border-radius: 3px; }.shot-image-empty { display: grid; place-items: center; color: #9da8af; font-size: 28px; }.shot-copy { min-width: 0; }.shot-title-row { display: flex; align-items: center; gap: 12px; min-width: 0; }.shot-title-row strong { flex: 1; min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.shot-title-row .el-button { flex: 0 0 auto; }.shot-copy p { color: #66747f; font-size: 13px; line-height: 1.55; margin: 7px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }.shot-meta { display: flex; gap: 12px; color: #87939c; font-size: 12px; }
.reference-shot, .output-row { border: 1px solid #dfe5e8; border-radius: 5px; padding: 16px; }.reference-shot-head, .reference-shot-foot { justify-content: space-between; gap: 12px; }.reference-shot-head > div:first-child, .output-shot { display: flex; align-items: center; gap: 10px; min-width: 0; }.reference-shot-head span, .output-shot span { color: #21796f; font-weight: 800; }.shot-head-actions { gap: 8px; }.reference-grid { display: grid; grid-template-columns: 1.25fr 1fr .8fr; gap: 12px; margin: 16px 0; }.reference-bucket { min-width: 0; border-top: 1px solid #e6eaed; padding-top: 10px; }.bucket-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; color: #63727d; font-size: 12px; }.reference-items { display: grid; gap: 6px; }.reference-item { height: 42px; display: grid; grid-template-columns: 36px minmax(0, 1fr) 28px; align-items: center; gap: 7px; background: #f3f6f6; border-radius: 4px; padding: 3px 3px 3px 6px; }.reference-item img { width: 36px; height: 36px; object-fit: cover; border-radius: 3px; }.reference-item > .el-icon { font-size: 20px; color: #347d74; }.reference-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.bucket-empty { color: #a0a9b0; font-size: 12px; padding: 10px 0; }.reference-shot-foot { color: #7c8992; font-size: 12px; }
.generation-toolbar { display: grid; grid-template-columns: minmax(260px, 1fr) auto auto; align-items: end; gap: 18px; padding: 18px; background: #f3f7f6; border: 1px solid #d7e5e1; margin-bottom: 18px; }.generation-toolbar label { display: block; color: #60717b; font-size: 12px; margin-bottom: 6px; }.generation-toolbar .el-select { width: 100%; }.capability-line { display: flex; gap: 7px; flex-wrap: wrap; }.capability-line span { padding: 5px 8px; background: #fff; border: 1px solid #d5dfdd; border-radius: 3px; font-size: 12px; }.output-row { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 18px; align-items: center; }.output-shot { align-items: flex-start; flex-direction: column; gap: 4px; }.output-media { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }.output-media video { width: 100%; max-height: 260px; background: #111; }.output-media a { color: #21796f; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; white-space: nowrap; }.output-state { color: #6f7c86; display: flex; align-items: center; gap: 8px; }.output-state small { color: #c45656; }
.reference-item { min-height: 46px; height: auto; grid-template-columns: 36px minmax(0, 1fr) 28px 28px; padding: 4px 3px 4px 6px; }.reference-item > a { color: #347d74; display: grid; place-items: center; text-decoration: none; }.reference-item span { min-width: 0; display: flex; flex-direction: column; }.reference-item span strong, .reference-item span small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.reference-item span strong { font-size: 12px; font-weight: 600; }.reference-item span small { color: #819098; font-size: 10px; margin-top: 2px; }.download-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }.download-actions > a { color: #21796f; display: inline-flex; align-items: center; gap: 6px; text-decoration: none; white-space: nowrap; }
.asset-library { margin-top: 28px; border-top: 1px solid #dfe5e8; padding-top: 22px; }.asset-library-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 12px; }.asset-library-head > div { display: flex; flex-direction: column; gap: 3px; }.asset-library-head span, .asset-library-head small { color: #7d8992; font-size: 12px; }.asset-library-list { display: grid; gap: 10px; }.asset-library-list article { display: grid; grid-template-columns: 180px minmax(0, 1fr) auto; align-items: center; gap: 14px; border: 1px solid #e0e5e8; padding: 10px; }.asset-library-list video { width: 180px; aspect-ratio: 16 / 9; object-fit: cover; background: #111; }.asset-library-list article > div:nth-child(2) { min-width: 0; display: flex; flex-direction: column; gap: 5px; }.asset-library-list article > div:nth-child(2) strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.asset-library-list article > div:nth-child(2) span { color: #7d8992; font-size: 12px; }
.picker-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; color: #65747e; font-size: 13px; }.candidate-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; max-height: 52vh; overflow-y: auto; }.candidate-grid button { min-width: 0; padding: 0; border: 1px solid #dce3e6; background: #fff; text-align: left; cursor: pointer; }.candidate-grid button:hover:not(:disabled) { border-color: #4f9b90; box-shadow: 0 0 0 1px #4f9b90; }.candidate-grid button:disabled { cursor: default; opacity: .55; }.candidate-grid img, .candidate-grid video { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #edf1f2; display: block; }.candidate-grid button > .el-icon { width: 100%; aspect-ratio: 16 / 10; display: grid; place-items: center; background: #edf1f2; color: #397d73; font-size: 34px; }.candidate-grid button > span { display: flex; flex-direction: column; gap: 3px; padding: 9px; }.candidate-grid strong, .candidate-grid small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.candidate-grid small { color: #7c8992; }
@media (max-width: 760px) { .workflow-header { height: auto; min-height: 64px; padding: 10px 14px; }.header-actions .el-button span { display: none; }.episode-select { width: 130px; }.workflow-steps { overflow-x: auto; grid-template-columns: repeat(5, 118px); padding: 0 14px; }.workflow-main { padding: 18px 12px 48px; }.preparation-panel { align-items: flex-start; flex-wrap: wrap; }.stage-band { padding: 18px 14px; }.script-layout, .reference-grid, .generation-toolbar, .output-row, .asset-library-list article { grid-template-columns: 1fr; }.stage-summary { border-left: 0; border-top: 1px solid #e5e9ec; padding: 14px 0 0; grid-template-columns: repeat(4, 1fr); }.stage-summary div { flex-direction: column; }.shot-row { grid-template-columns: 30px 38px 88px minmax(0, 1fr); gap: 8px; padding: 8px; }.shot-row img, .shot-image-empty { width: 88px; }.shot-title-row { align-items: flex-start; }.shot-title-row .el-button span { display: none; }.shot-copy p { -webkit-line-clamp: 1; }.shot-head-actions { flex-wrap: wrap; justify-content: flex-end; }.output-media { grid-template-columns: 1fr; }.stage-actions, .picker-toolbar, .asset-library-head { align-items: flex-start; flex-wrap: wrap; }.asset-library-list video { width: 100%; }.download-actions { flex-direction: row; } }
</style>
