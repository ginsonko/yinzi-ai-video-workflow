<template>
  <div class="director-studio">
    <header class="director-header">
      <div class="director-brand">
        <el-button :icon="ArrowLeft" circle title="返回项目" @click="goBack" />
        <div>
          <strong>3D 导演台</strong>
          <span>{{ storyboardLabel }}</span>
        </div>
      </div>
      <div class="director-header-actions">
        <span class="save-state">{{ saveState }}</span>
        <el-button :icon="DocumentChecked" circle title="保存到本机" @click="saveLocal" />
        <el-button :icon="FolderOpened" circle title="导入场景 JSON" @click="fileInputRef?.click()" />
        <el-button :icon="Download" circle title="导出场景 JSON" @click="exportJson" />
        <input ref="fileInputRef" type="file" accept="application/json,.json" hidden @change="importJson" />
      </div>
    </header>

    <div class="director-toolbar">
      <el-dropdown trigger="click" @command="addStageObject">
        <el-button type="primary">
          <el-icon><Plus /></el-icon>
          添加
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="character">代理角色</el-dropdown-item>
            <el-dropdown-item command="box">方盒道具</el-dropdown-item>
            <el-dropdown-item command="sphere">球形道具</el-dropdown-item>
            <el-dropdown-item command="plane">平面</el-dropdown-item>
            <el-dropdown-item command="light">聚光灯</el-dropdown-item>
            <el-dropdown-item command="camera" divided>摄像机</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <div class="toolbar-divider" />
      <el-radio-group v-model="transformMode" size="small" @change="setTransformMode">
        <el-radio-button value="translate" title="移动"><el-icon><Rank /></el-icon></el-radio-button>
        <el-radio-button value="rotate" title="旋转"><el-icon><RefreshRight /></el-icon></el-radio-button>
        <el-radio-button value="scale" title="缩放"><el-icon><FullScreen /></el-icon></el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="transformSpace" size="small" @change="setTransformSpace">
        <el-radio-button value="world">世界</el-radio-button>
        <el-radio-button value="local">局部</el-radio-button>
      </el-radio-group>

      <div class="toolbar-divider" />
      <el-button :icon="RefreshLeft" circle title="撤销" :disabled="historyIndex <= 0" @click="undo" />
      <el-button :icon="RefreshRight" circle title="重做" :disabled="historyIndex >= historyLength - 1" @click="redo" />
      <el-button :icon="Aim" circle title="重置自由视角" @click="resetEditorCamera" />

      <div class="toolbar-divider" />
      <el-radio-group v-model="previewMode" size="small" @change="onPreviewModeChange">
        <el-radio-button value="free">自由视角</el-radio-button>
        <el-radio-button value="shot">镜头预览</el-radio-button>
      </el-radio-group>
      <el-button :icon="Camera" circle title="下载当前画面" @click="downloadScreenshot" />
      <el-button :icon="Crop" circle title="保存为项目参考图" :loading="uploadingFrame" @click="saveFrameToProject" />
      <el-button
        :icon="recording ? VideoPause : VideoCamera"
        circle
        :type="recording ? 'danger' : 'default'"
        :title="recording ? '停止录制' : '录制 WebM 预览'"
        @click="toggleRecording"
      />
    </div>

    <main class="director-main">
      <section ref="viewportRef" class="director-viewport">
        <div v-if="previewMode === 'shot'" class="preview-indicator">
          <span class="record-dot" />
          {{ activeCameraName }}
        </div>
        <div v-if="!webglReady" class="webgl-fallback">正在初始化 3D 场景…</div>
      </section>

      <aside class="director-inspector">
        <div class="panel-title">
          <span>场景对象</span>
          <span>{{ stageItems.length }}</span>
        </div>
        <div class="object-list">
          <button
            v-for="item in stageItems"
            :key="item.id"
            type="button"
            :class="['object-row', { selected: item.id === selectedId }]"
            @click="selectObject(item.id)"
          >
            <span class="object-kind">{{ kindLabel(item.kind) }}</span>
            <span class="object-name">{{ item.name }}</span>
            <span v-if="item.id === activeCameraId" class="active-camera-mark">LIVE</span>
          </button>
        </div>

        <div v-if="selectedId" class="transform-panel">
          <div class="inspector-heading">
            <span>对象属性</span>
            <el-button :icon="Delete" link type="danger" title="删除对象" @click="removeSelected" />
          </div>
          <el-input v-model="selectedForm.name" size="small" maxlength="80" @input="applyInspector()" @change="applyInspector(true)" />

          <label class="field-label">位置</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.px" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.py" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.pz" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>
          <label class="field-label">旋转</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.rx" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.ry" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.rz" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>
          <label class="field-label">缩放</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.sx" :step="0.1" :min="0.01" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.sy" :step="0.1" :min="0.01" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.sz" :step="0.1" :min="0.01" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>

          <template v-if="selectedKind === 'camera'">
            <label class="field-label">镜头</label>
            <div class="camera-row">
              <el-input-number v-model="selectedForm.fov" :min="10" :max="120" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              <el-select v-model="selectedForm.aspect" @change="applyInspector(true)">
                <el-option label="16:9" :value="16 / 9" />
                <el-option label="9:16" :value="9 / 16" />
                <el-option label="4:3" :value="4 / 3" />
                <el-option label="1:1" :value="1" />
                <el-option label="21:9" :value="21 / 9" />
              </el-select>
            </div>
            <el-button class="activate-camera" :type="selectedId === activeCameraId ? 'success' : 'primary'" plain @click="activateSelectedCamera">
              {{ selectedId === activeCameraId ? '当前镜头' : '设为当前镜头' }}
            </el-button>
          </template>
        </div>
        <div v-else class="empty-inspector">选择一个对象</div>
      </aside>
    </main>

    <footer class="director-timeline">
      <el-button :icon="playing ? VideoPause : VideoPlay" circle :title="playing ? '暂停' : '播放'" @click="togglePlayback" />
      <span class="timecode">{{ currentTime.toFixed(2) }}s</span>
      <div class="timeline-track">
        <el-slider v-model="currentTime" :min="0" :max="timelineDuration" :step="0.05" :show-tooltip="false" @input="scrubTimeline" />
        <span
          v-for="mark in visibleKeyframeMarks"
          :key="mark.key"
          class="keyframe-mark"
          :style="{ left: `${mark.percent}%` }"
        />
      </div>
      <span class="timecode">{{ timelineDuration.toFixed(1) }}s</span>
      <el-input-number v-model="timelineDuration" :min="1" :max="60" :step="1" size="small" controls-position="right" @change="changeTimelineDuration" />
      <el-button :icon="Timer" :disabled="!selectedId" title="在当前时间添加关键帧" @click="addKeyframe">关键帧</el-button>
    </footer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Aim,
  ArrowDown,
  ArrowLeft,
  Camera,
  Crop,
  Delete,
  DocumentChecked,
  Download,
  FolderOpened,
  FullScreen,
  Plus,
  Rank,
  RefreshLeft,
  RefreshRight,
  Timer,
  VideoCamera,
  VideoPause,
  VideoPlay,
} from '@element-plus/icons-vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { uploadAPI } from '@/api/upload'
import { storyboardsAPI } from '@/api/storyboards'
import {
  createDefaultDirectorDocument,
  interpolateObjectKeyframes,
  normalizeDirectorDocument,
} from '@/utils/directorScene'

const route = useRoute()
const router = useRouter()
const dramaId = computed(() => Number(route.params.id) || null)
const storyboardId = computed(() => Number(route.query.storyboard) || null)
const storyboardRecord = ref(null)
const viewportRef = ref(null)
const fileInputRef = ref(null)
const webglReady = ref(false)
const stageItems = ref([])
const selectedId = ref(null)
const selectedKind = ref('')
const activeCameraId = ref(null)
const previewMode = ref('free')
const transformMode = ref('translate')
const transformSpace = ref('world')
const saveState = ref('未保存')
const uploadingFrame = ref(false)
const recording = ref(false)
const playing = ref(false)
const currentTime = ref(0)
const timelineDuration = ref(5)
const keyframes = ref([])
const historyIndex = ref(-1)
const historyLength = ref(0)

const selectedForm = reactive({
  name: '', px: 0, py: 0, pz: 0,
  rx: 0, ry: 0, rz: 0,
  sx: 1, sy: 1, sz: 1,
  fov: 42, aspect: 16 / 9,
})

let renderer
let scene
let editorCamera
let orbit
let transform
let transformHelper
let resizeObserver
let animationFrame
let mediaRecorder
let recordChunks = []
let playStartedAt = 0
let isRestoring = false
const objectById = new Map()
const cameraHelpers = new Map()
const history = []
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

const storageKey = computed(() => `local-mini-drama:director:${dramaId.value || 'standalone'}:${storyboardId.value || 'project'}`)
const storyboardLabel = computed(() => {
  if (storyboardRecord.value) {
    return `项目 ${dramaId.value} · 分镜 #${storyboardRecord.value.storyboard_number || storyboardId.value}`
  }
  return dramaId.value ? `项目 ${dramaId.value}` : '独立场景'
})
const activeCameraName = computed(() => stageItems.value.find((item) => item.id === activeCameraId.value)?.name || '未设置镜头')
const visibleKeyframeMarks = computed(() => keyframes.value.map((keyframe, index) => ({
  key: `${keyframe.object_id}-${keyframe.time}-${index}`,
  percent: Math.min(100, Math.max(0, (keyframe.time / timelineDuration.value) * 100)),
})))

function uid(kind) {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function kindLabel(kind) {
  return { character: '角色', box: '方盒', sphere: '球体', plane: '平面', light: '灯光', camera: '镜头' }[kind] || kind
}

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.06, ...options })
}

function createCharacter(record) {
  const group = new THREE.Group()
  const skin = material('#f3b78f')
  const shirt = material(record.props.color || '#1fc7a1')
  const dark = material('#26364a')
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.48, 0.85, 6, 12), shirt)
  body.position.y = 1.42
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 24, 16), skin)
  head.position.y = 2.45
  const legGeometry = new THREE.CapsuleGeometry(0.14, 0.62, 4, 8)
  const leftLeg = new THREE.Mesh(legGeometry, dark)
  const rightLeg = new THREE.Mesh(legGeometry, dark)
  leftLeg.position.set(-0.22, 0.46, 0)
  rightLeg.position.set(0.22, 0.46, 0)
  group.add(body, head, leftLeg, rightLeg)
  return group
}

function createStageObject(record) {
  let object
  if (record.kind === 'character') {
    object = createCharacter(record)
  } else if (record.kind === 'box') {
    object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material(record.props.color || '#e46f51'))
  } else if (record.kind === 'sphere') {
    object = new THREE.Mesh(new THREE.SphereGeometry(0.62, 28, 18), material(record.props.color || '#e8b84e'))
  } else if (record.kind === 'plane') {
    object = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), material(record.props.color || '#8a93a3', { side: THREE.DoubleSide }))
    object.rotation.x = -Math.PI / 2
  } else if (record.kind === 'light') {
    object = new THREE.Group()
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 10), material('#fff1b3', { emissive: '#ffcf55', emissiveIntensity: 1.4 }))
    const light = new THREE.SpotLight('#fff0d0', Number(record.props.intensity) || 60, 25, Math.PI / 5, 0.35, 1.5)
    const target = new THREE.Object3D()
    target.position.set(0, -3, -2)
    light.target = target
    object.add(bulb, light, target)
    object.userData.light = light
  } else if (record.kind === 'camera') {
    object = new THREE.PerspectiveCamera(Number(record.props.fov) || 42, Number(record.props.aspect) || 16 / 9, 0.1, 200)
  } else {
    object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material('#e46f51'))
  }

  object.name = record.name
  object.userData.stageObject = true
  object.userData.kind = record.kind
  object.userData.id = record.id
  object.userData.props = { ...record.props }
  object.position.fromArray(record.position)
  object.rotation.fromArray(record.rotation)
  object.scale.fromArray(record.scale)
  scene.add(object)
  objectById.set(record.id, object)

  if (record.kind === 'camera') {
    object.updateProjectionMatrix()
    const helper = new THREE.CameraHelper(object)
    helper.userData.directorHelper = true
    helper.material?.color?.set('#54b9ff')
    scene.add(helper)
    cameraHelpers.set(record.id, helper)
  }
  return object
}

function defaultRecord(kind) {
  const count = stageItems.value.filter((item) => item.kind === kind).length + 1
  const record = {
    id: uid(kind), kind, name: `${kindLabel(kind)} ${count}`,
    position: [0, kind === 'box' ? 0.5 : kind === 'sphere' ? 0.65 : kind === 'plane' ? 0.01 : kind === 'light' ? 4 : 0, 0],
    rotation: [0, 0, 0], scale: [1, 1, 1], props: {},
  }
  if (kind === 'character') record.position = [0, 0, 0]
  if (kind === 'camera') {
    record.position = editorCamera ? editorCamera.position.toArray() : [6, 4, 8]
    record.rotation = editorCamera ? editorCamera.rotation.toArray().slice(0, 3) : [-0.3, 0.65, 0]
    record.props = { fov: 42, aspect: 16 / 9 }
  }
  if (kind === 'light') record.props = { intensity: 60 }
  return record
}

function addStageObject(kind) {
  const object = createStageObject(defaultRecord(kind))
  syncStageItems()
  selectObject(object.userData.id)
  if (kind === 'camera' && !activeCameraId.value) activeCameraId.value = object.userData.id
  commitHistory()
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose?.()
    if (Array.isArray(child.material)) child.material.forEach((entry) => entry.dispose?.())
    else child.material?.dispose?.()
  })
}

function removeStageObject(id) {
  const object = objectById.get(id)
  if (!object) return
  if (transform?.object === object) transform.detach()
  const helper = cameraHelpers.get(id)
  if (helper) {
    scene.remove(helper)
    helper.dispose?.()
    cameraHelpers.delete(id)
  }
  scene.remove(object)
  disposeObject(object)
  objectById.delete(id)
  keyframes.value = keyframes.value.filter((keyframe) => keyframe.object_id !== id)
  if (activeCameraId.value === id) {
    activeCameraId.value = stageItems.value.find((item) => item.kind === 'camera' && item.id !== id)?.id || null
    if (!activeCameraId.value) previewMode.value = 'free'
  }
  if (selectedId.value === id) {
    selectedId.value = null
    selectedKind.value = ''
  }
  syncStageItems()
}

function removeSelected() {
  if (!selectedId.value) return
  removeStageObject(selectedId.value)
  commitHistory()
}

function objectRecord(object) {
  const props = { ...(object.userData.props || {}) }
  if (object.userData.kind === 'camera') {
    props.fov = object.fov
    props.aspect = object.aspect
  }
  if (object.userData.kind === 'light') props.intensity = object.userData.light?.intensity || 60
  return {
    id: object.userData.id,
    kind: object.userData.kind,
    name: object.name,
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray(),
    props,
  }
}

function serializeDocument() {
  return normalizeDirectorDocument({
    active_camera_id: activeCameraId.value,
    objects: [...objectById.values()].map(objectRecord),
    timeline: { duration: timelineDuration.value, keyframes: keyframes.value },
  })
}

function clearStageObjects() {
  for (const id of [...objectById.keys()]) removeStageObject(id)
  objectById.clear()
  cameraHelpers.clear()
}

function restoreDocument(value, options = {}) {
  const document = normalizeDirectorDocument(value)
  isRestoring = true
  clearStageObjects()
  for (const record of document.objects) createStageObject(record)
  activeCameraId.value = document.active_camera_id
  timelineDuration.value = document.timeline.duration
  keyframes.value = document.timeline.keyframes
  currentTime.value = Math.min(currentTime.value, timelineDuration.value)
  syncStageItems()
  if (document.objects.length) selectObject(document.objects[0].id)
  else selectObject(null)
  isRestoring = false
  if (options.commit) commitHistory()
}

function syncStageItems() {
  stageItems.value = [...objectById.values()].map((object) => ({
    id: object.userData.id,
    kind: object.userData.kind,
    name: object.name,
  }))
}

function syncSelectedForm() {
  const object = objectById.get(selectedId.value)
  if (!object) return
  selectedForm.name = object.name
  selectedForm.px = Number(object.position.x.toFixed(3))
  selectedForm.py = Number(object.position.y.toFixed(3))
  selectedForm.pz = Number(object.position.z.toFixed(3))
  selectedForm.rx = Number(THREE.MathUtils.radToDeg(object.rotation.x).toFixed(2))
  selectedForm.ry = Number(THREE.MathUtils.radToDeg(object.rotation.y).toFixed(2))
  selectedForm.rz = Number(THREE.MathUtils.radToDeg(object.rotation.z).toFixed(2))
  selectedForm.sx = Number(object.scale.x.toFixed(3))
  selectedForm.sy = Number(object.scale.y.toFixed(3))
  selectedForm.sz = Number(object.scale.z.toFixed(3))
  if (object.userData.kind === 'camera') {
    selectedForm.fov = object.fov
    selectedForm.aspect = object.aspect
  }
}

function selectObject(id) {
  const object = id ? objectById.get(id) : null
  selectedId.value = object?.userData.id || null
  selectedKind.value = object?.userData.kind || ''
  if (object && previewMode.value === 'free') transform.attach(object)
  else transform?.detach()
  syncSelectedForm()
}

function applyInspector(shouldCommit = false) {
  const object = objectById.get(selectedId.value)
  if (!object) return
  object.name = String(selectedForm.name || object.name).slice(0, 80)
  object.position.set(Number(selectedForm.px) || 0, Number(selectedForm.py) || 0, Number(selectedForm.pz) || 0)
  object.rotation.set(
    THREE.MathUtils.degToRad(Number(selectedForm.rx) || 0),
    THREE.MathUtils.degToRad(Number(selectedForm.ry) || 0),
    THREE.MathUtils.degToRad(Number(selectedForm.rz) || 0)
  )
  object.scale.set(
    Math.max(0.01, Number(selectedForm.sx) || 1),
    Math.max(0.01, Number(selectedForm.sy) || 1),
    Math.max(0.01, Number(selectedForm.sz) || 1)
  )
  if (object.userData.kind === 'camera') {
    object.fov = Math.min(120, Math.max(10, Number(selectedForm.fov) || 42))
    object.aspect = Math.max(0.2, Number(selectedForm.aspect) || 16 / 9)
    object.updateProjectionMatrix()
  }
  syncStageItems()
  cameraHelpers.get(selectedId.value)?.update()
  if (shouldCommit) commitHistory()
}

function activateSelectedCamera() {
  if (selectedKind.value !== 'camera') return
  activeCameraId.value = selectedId.value
  commitHistory()
}

function setTransformMode(value) {
  transform?.setMode(value)
}

function setTransformSpace(value) {
  transform?.setSpace(value)
}

function onPreviewModeChange(value) {
  if (value === 'shot' && !objectById.get(activeCameraId.value)) {
    previewMode.value = 'free'
    ElMessage.warning('请先添加并启用摄像机')
  }
  orbit.enabled = previewMode.value === 'free'
  if (previewMode.value === 'free' && selectedId.value) transform.attach(objectById.get(selectedId.value))
  else transform.detach()
}

function resetEditorCamera() {
  editorCamera.position.set(7.5, 5.5, 9)
  orbit.target.set(0, 1.1, 0)
  orbit.update()
}

function commitHistory() {
  if (isRestoring) return
  const snapshot = JSON.stringify(serializeDocument())
  if (history[historyIndex.value] === snapshot) return
  history.splice(historyIndex.value + 1)
  history.push(snapshot)
  if (history.length > 60) history.shift()
  historyIndex.value = history.length - 1
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value -= 1
  restoreDocument(JSON.parse(history[historyIndex.value]))
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

function redo() {
  if (historyIndex.value >= history.length - 1) return
  historyIndex.value += 1
  restoreDocument(JSON.parse(history[historyIndex.value]))
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

async function persistStoryboardWorkflow(patch = {}) {
  if (!storyboardId.value) return null
  const updated = await storyboardsAPI.update(storyboardId.value, patch)
  storyboardRecord.value = updated
  return updated
}

async function saveLocal() {
  applyInspector()
  const document = serializeDocument()
  localStorage.setItem(storageKey.value, JSON.stringify(document))
  if (storyboardId.value) {
    await persistStoryboardWorkflow({ director_scene_json: document })
    saveState.value = '已保存到分镜'
  } else {
    saveState.value = '已保存到本机'
  }
}

function exportJson() {
  applyInspector()
  const blob = new Blob([JSON.stringify(serializeDocument(), null, 2)], { type: 'application/json' })
  downloadBlob(blob, `director-scene-${dramaId.value || 'standalone'}.json`)
  saveState.value = '已导出'
}

async function importJson(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const document = normalizeDirectorDocument(JSON.parse(await file.text()))
    restoreDocument(document, { commit: true })
    saveLocal()
    ElMessage.success('场景已导入')
  } catch (error) {
    ElMessage.error('场景 JSON 无效：' + error.message)
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function canvasBlob() {
  renderScene()
  return new Promise((resolve, reject) => {
    renderer.domElement.toBlob((blob) => blob ? resolve(blob) : reject(new Error('截图失败')), 'image/png')
  })
}

async function downloadScreenshot() {
  try {
    downloadBlob(await canvasBlob(), `director-frame-${Date.now()}.png`)
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function saveFrameToProject() {
  uploadingFrame.value = true
  try {
    const blob = await canvasBlob()
    const file = new File([blob], `director-frame-${Date.now()}.png`, { type: 'image/png' })
    const result = await uploadAPI.uploadImage(file, { dramaId: dramaId.value })
    const localPath = result.local_path || result.path
    if (storyboardId.value && localPath) {
      const refs = storyboardRecord.value?.workflow_references || { images: [], videos: [], audios: [] }
      await persistStoryboardWorkflow({
        director_scene_json: serializeDocument(),
        director_frame_path: localPath,
        workflow_references: {
          ...refs,
          images: [...(refs.images || []).filter((item) => item.path !== localPath), {
            path: localPath,
            label: '3D 导演台确认帧',
            source: 'director',
          }].slice(-4),
        },
      })
    }
    ElMessage.success(`参考图已保存：${localPath}`)
  } catch (error) {
    ElMessage.error('保存参考图失败：' + error.message)
  } finally {
    uploadingFrame.value = false
  }
}

function toggleRecording() {
  if (recording.value) {
    mediaRecorder?.stop()
    return
  }
  if (!renderer?.domElement.captureStream || typeof MediaRecorder === 'undefined') {
    ElMessage.error('当前浏览器不支持画布录制')
    return
  }
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type)) || ''
  recordChunks = []
  mediaRecorder = new MediaRecorder(renderer.domElement.captureStream(30), mimeType ? { mimeType } : undefined)
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordChunks.push(event.data) }
  mediaRecorder.onstop = async () => {
    recording.value = false
    if (recordChunks.length) {
      const blob = new Blob(recordChunks, { type: mimeType || 'video/webm' })
      const filename = `director-preview-${Date.now()}.webm`
      downloadBlob(blob, filename)
      if (storyboardId.value) {
        try {
          const uploaded = await uploadAPI.uploadReferenceMedia(new File([blob], filename, { type: blob.type || 'video/webm' }))
          const localPath = uploaded.local_path || uploaded.path
          const refs = storyboardRecord.value?.workflow_references || { images: [], videos: [], audios: [] }
          await persistStoryboardWorkflow({
            director_scene_json: serializeDocument(),
            director_preview_path: localPath,
            workflow_references: {
              ...refs,
              videos: [...(refs.videos || []).filter((item) => item.path !== localPath), {
                path: localPath,
                label: '3D 导演台预演',
                source: 'director',
              }].slice(-3),
            },
          })
          ElMessage.success('预演视频已加入分镜参考')
        } catch (error) {
          ElMessage.error('预演已下载，但加入分镜参考失败：' + error.message)
        }
      }
    }
    recordChunks = []
  }
  mediaRecorder.start(500)
  recording.value = true
}

function addKeyframe() {
  const object = objectById.get(selectedId.value)
  if (!object) return
  const frame = {
    object_id: selectedId.value,
    time: Number(currentTime.value.toFixed(3)),
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray(),
  }
  const existing = keyframes.value.findIndex((item) => item.object_id === frame.object_id && Math.abs(item.time - frame.time) < 0.001)
  if (existing >= 0) keyframes.value.splice(existing, 1, frame)
  else keyframes.value.push(frame)
  keyframes.value.sort((a, b) => a.time - b.time)
  commitHistory()
}

function applyTimeline(time) {
  const tracks = new Map()
  for (const keyframe of keyframes.value) {
    if (!tracks.has(keyframe.object_id)) tracks.set(keyframe.object_id, [])
    tracks.get(keyframe.object_id).push(keyframe)
  }
  for (const [id, track] of tracks) {
    const value = interpolateObjectKeyframes(track, time)
    const object = objectById.get(id)
    if (!value || !object) continue
    object.position.fromArray(value.position)
    object.rotation.set(...value.rotation)
    object.scale.fromArray(value.scale)
    cameraHelpers.get(id)?.update()
  }
  syncSelectedForm()
}

function scrubTimeline(value) {
  playing.value = false
  currentTime.value = Number(value)
  applyTimeline(currentTime.value)
}

function togglePlayback() {
  if (playing.value) {
    playing.value = false
    return
  }
  if (currentTime.value >= timelineDuration.value) currentTime.value = 0
  playStartedAt = performance.now() - currentTime.value * 1000
  playing.value = true
}

function changeTimelineDuration(value) {
  timelineDuration.value = Math.min(60, Math.max(1, Number(value) || 5))
  keyframes.value = keyframes.value.filter((frame) => frame.time <= timelineDuration.value)
  currentTime.value = Math.min(currentTime.value, timelineDuration.value)
  commitHistory()
}

function stageObjectFromIntersection(object) {
  let cursor = object
  while (cursor && !cursor.userData?.stageObject) cursor = cursor.parent
  return cursor?.userData?.stageObject ? cursor : null
}

function onCanvasPointerDown(event) {
  if (previewMode.value !== 'free') return
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, editorCamera)
  const hits = raycaster.intersectObjects([...objectById.values()], true)
  const hit = hits.map((entry) => stageObjectFromIntersection(entry.object)).find(Boolean)
  if (hit) selectObject(hit.userData.id)
}

function onKeyDown(event) {
  const tag = event.target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId.value) removeSelected()
}

function resizeRenderer() {
  const container = viewportRef.value
  if (!container || !renderer) return
  const width = Math.max(1, container.clientWidth)
  const height = Math.max(1, container.clientHeight)
  renderer.setSize(width, height, false)
  editorCamera.aspect = width / height
  editorCamera.updateProjectionMatrix()
}

function renderScene() {
  if (!renderer || !scene) return
  const width = renderer.domElement.width / renderer.getPixelRatio()
  const height = renderer.domElement.height / renderer.getPixelRatio()
  const shotCamera = objectById.get(activeCameraId.value)
  for (const [id, helper] of cameraHelpers) {
    helper.visible = previewMode.value !== 'shot' || id !== activeCameraId.value
    helper.update()
  }
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, width, height)
  renderer.setClearColor('#090c12', 1)
  renderer.clear()
  if (previewMode.value === 'shot' && shotCamera?.isPerspectiveCamera) {
    const targetAspect = shotCamera.aspect || 16 / 9
    let viewWidth = width
    let viewHeight = viewWidth / targetAspect
    if (viewHeight > height) {
      viewHeight = height
      viewWidth = viewHeight * targetAspect
    }
    const x = Math.floor((width - viewWidth) / 2)
    const y = Math.floor((height - viewHeight) / 2)
    renderer.setScissorTest(true)
    renderer.setScissor(x, y, Math.floor(viewWidth), Math.floor(viewHeight))
    renderer.setViewport(x, y, Math.floor(viewWidth), Math.floor(viewHeight))
    renderer.render(scene, shotCamera)
    renderer.setScissorTest(false)
  } else {
    renderer.render(scene, editorCamera)
  }
}

function animate(now) {
  if (playing.value) {
    const next = (now - playStartedAt) / 1000
    if (next >= timelineDuration.value) {
      currentTime.value = timelineDuration.value
      playing.value = false
    } else {
      currentTime.value = next
    }
    applyTimeline(currentTime.value)
  }
  orbit?.update()
  renderScene()
  animationFrame = requestAnimationFrame(animate)
}

function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0d1119')
  scene.fog = new THREE.Fog('#0d1119', 24, 72)
  editorCamera = new THREE.PerspectiveCamera(48, 1, 0.1, 300)
  editorCamera.position.set(7.5, 5.5, 9)

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = true
  renderer.outputColorSpace = THREE.SRGBColorSpace
  viewportRef.value.appendChild(renderer.domElement)
  renderer.domElement.className = 'director-canvas'
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown)

  orbit = new OrbitControls(editorCamera, renderer.domElement)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.target.set(0, 1.1, 0)
  orbit.maxPolarAngle = Math.PI * 0.495
  orbit.minDistance = 2
  orbit.maxDistance = 60

  transform = new TransformControls(editorCamera, renderer.domElement)
  transform.setMode(transformMode.value)
  transform.setSpace(transformSpace.value)
  transform.addEventListener('dragging-changed', (event) => { orbit.enabled = !event.value && previewMode.value === 'free' })
  transform.addEventListener('objectChange', () => {
    syncSelectedForm()
    cameraHelpers.get(selectedId.value)?.update()
  })
  transform.addEventListener('mouseUp', commitHistory)
  transformHelper = transform.getHelper ? transform.getHelper() : transform
  scene.add(transformHelper)

  const grid = new THREE.GridHelper(80, 80, '#257a6c', '#28313f')
  grid.material.opacity = 0.62
  grid.material.transparent = true
  scene.add(grid)
  const ambient = new THREE.HemisphereLight('#c8dcff', '#253327', 2.2)
  scene.add(ambient)
  const key = new THREE.DirectionalLight('#fff0df', 3.2)
  key.position.set(6, 10, 4)
  key.castShadow = true
  scene.add(key)

  resizeObserver = new ResizeObserver(resizeRenderer)
  resizeObserver.observe(viewportRef.value)
  resizeRenderer()

  let initial = storyboardRecord.value?.director_scene_json || createDefaultDirectorDocument()
  const saved = localStorage.getItem(storageKey.value)
  if (saved && !storyboardRecord.value?.director_scene_json) {
    try {
      initial = normalizeDirectorDocument(JSON.parse(saved))
      saveState.value = '已从本机恢复'
    } catch (_) {
      saveState.value = '本机存档损坏，已载入默认场景'
    }
  }
  restoreDocument(initial)
  commitHistory()
  saveState.value = storyboardRecord.value?.director_scene_json
    ? '已从分镜恢复'
    : saved ? '已从本机恢复' : '默认场景'
  webglReady.value = true
  animationFrame = requestAnimationFrame(animate)
}

function goBack() {
  if (dramaId.value && storyboardId.value) {
    router.push({ path: `/workflow/${dramaId.value}`, query: { stage: 'director', storyboard: storyboardId.value } })
  } else {
    router.push(dramaId.value ? `/drama/${dramaId.value}` : '/')
  }
}

onMounted(async () => {
  await nextTick()
  try {
    if (storyboardId.value) storyboardRecord.value = await storyboardsAPI.get(storyboardId.value)
    initScene()
    window.addEventListener('keydown', onKeyDown)
  } catch (error) {
    ElMessage.error('3D 场景初始化失败：' + error.message)
  }
})

onBeforeUnmount(() => {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  renderer?.domElement?.removeEventListener('pointerdown', onCanvasPointerDown)
  transform?.dispose?.()
  orbit?.dispose?.()
  clearStageObjects()
  renderer?.dispose?.()
  renderer?.domElement?.remove()
})
</script>

<style scoped>
.director-studio {
  height: 100vh;
  min-height: 560px;
  display: grid;
  grid-template-rows: 56px 48px minmax(0, 1fr) 76px;
  overflow: hidden;
  background: #090c12;
  color: #eef2f7;
}
.director-header,
.director-toolbar,
.director-timeline {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  border-color: #252c38;
  background: #141923;
}
.director-header {
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid #252c38;
}
.director-brand,
.director-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.director-brand > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.director-brand strong {
  font-size: 15px;
  line-height: 1.2;
  letter-spacing: 0;
}
.director-brand span,
.save-state {
  color: #8f9bae;
  font-size: 11px;
  white-space: nowrap;
}
.director-toolbar {
  gap: 8px;
  padding: 6px 12px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid #252c38;
}
.director-toolbar::-webkit-scrollbar {
  display: none;
}
.toolbar-divider {
  flex: 0 0 1px;
  align-self: stretch;
  background: #2b3442;
  margin: 0 2px;
}
.director-main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
}
.director-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #090c12;
}
.director-viewport :deep(.director-canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}
.preview-indicator {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  background: rgba(11, 14, 20, 0.78);
  color: #e8edf5;
  font-size: 12px;
  backdrop-filter: blur(8px);
}
.record-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f05b68;
  box-shadow: 0 0 0 3px rgba(240, 91, 104, 0.18);
}
.webgl-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8995a8;
  font-size: 13px;
}
.director-inspector {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #252c38;
  background: #171d27;
  overflow: hidden;
}
.panel-title,
.inspector-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.panel-title {
  min-height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid #252c38;
  color: #dfe6ef;
  font-size: 13px;
  font-weight: 600;
}
.panel-title span:last-child {
  color: #8190a3;
  font-size: 11px;
  font-weight: 500;
}
.object-list {
  flex: 0 1 220px;
  min-height: 84px;
  overflow: auto;
  padding: 6px;
  border-bottom: 1px solid #252c38;
}
.object-row {
  width: 100%;
  height: 34px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0 8px;
  background: transparent;
  color: #cbd4df;
  cursor: pointer;
  text-align: left;
}
.object-row:hover {
  background: #202837;
}
.object-row.selected {
  border-color: #2da98f;
  background: #17352f;
  color: #f2fffb;
}
.object-kind {
  color: #8090a5;
  font-size: 11px;
}
.object-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.active-camera-mark {
  color: #ff8f76;
  font-size: 9px;
  font-weight: 700;
}
.transform-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 16px;
}
.inspector-heading {
  height: 30px;
  margin-bottom: 7px;
  color: #aeb9c7;
  font-size: 12px;
  font-weight: 600;
}
.field-label {
  display: block;
  margin: 12px 0 5px;
  color: #8593a6;
  font-size: 11px;
}
.vector-row,
.camera-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}
.camera-row {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.vector-row :deep(.el-input-number),
.camera-row :deep(.el-input-number),
.camera-row :deep(.el-select) {
  width: 100%;
}
.vector-row :deep(.el-input__inner) {
  padding-left: 5px;
  padding-right: 27px;
}
.activate-camera {
  width: 100%;
  margin-top: 10px;
}
.empty-inspector {
  flex: 1;
  display: grid;
  place-items: center;
  color: #657286;
  font-size: 12px;
}
.director-timeline {
  gap: 10px;
  padding: 0 14px;
  border-top: 1px solid #252c38;
}
.timeline-track {
  position: relative;
  flex: 1;
  min-width: 120px;
}
.timecode {
  min-width: 46px;
  color: #9eabba;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11px;
  text-align: center;
}
.keyframe-mark {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  transform: translate(-50%, -50%) rotate(45deg);
  border: 1px solid #171d27;
  background: #f1bd59;
  pointer-events: none;
}
.director-timeline :deep(.el-input-number) {
  width: 88px;
}
.director-studio :deep(.el-button),
.director-studio :deep(.el-radio-button__inner),
.director-studio :deep(.el-input__wrapper),
.director-studio :deep(.el-select__wrapper) {
  --el-fill-color-blank: #1b2230;
  --el-bg-color: #1b2230;
  --el-border-color: #303a4a;
  --el-text-color-regular: #d9e1ea;
  --el-text-color-primary: #eef2f7;
}
.director-studio :deep(.el-input__wrapper),
.director-studio :deep(.el-select__wrapper) {
  background: #1b2230;
  box-shadow: 0 0 0 1px #303a4a inset;
}
.director-studio :deep(.el-input__inner),
.director-studio :deep(.el-select__selected-item) {
  color: #e5ebf2;
}
@media (max-width: 860px) {
  .director-studio {
    min-height: 600px;
    grid-template-rows: 52px 46px minmax(0, 1fr) 70px;
  }
  .director-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(240px, 1fr) 205px;
  }
  .director-inspector {
    border-left: 0;
    border-top: 1px solid #252c38;
    display: grid;
    grid-template-columns: minmax(150px, 0.8fr) minmax(220px, 1.2fr);
    grid-template-rows: 42px minmax(0, 1fr);
  }
  .panel-title {
    grid-column: 1 / -1;
  }
  .object-list {
    min-height: 0;
    border-right: 1px solid #252c38;
    border-bottom: 0;
  }
  .transform-panel,
  .empty-inspector {
    min-height: 0;
  }
  .save-state {
    display: none;
  }
}
@media (max-width: 520px) {
  .director-header {
    padding: 0 8px;
  }
  .director-brand span {
    display: none;
  }
  .director-header-actions {
    gap: 5px;
  }
  .director-toolbar {
    padding-inline: 8px;
  }
  .director-inspector {
    grid-template-columns: 126px minmax(210px, 1fr);
  }
  .transform-panel {
    overflow-x: hidden;
  }
  .vector-row :deep(.el-input-number__increase),
  .vector-row :deep(.el-input-number__decrease) {
    display: none;
  }
  .vector-row :deep(.el-input__wrapper) {
    padding-inline: 6px;
  }
  .director-timeline {
    gap: 6px;
    padding: 0 8px;
  }
  .director-timeline > .timecode:last-of-type,
  .director-timeline :deep(.el-input-number) {
    display: none;
  }
}
</style>
