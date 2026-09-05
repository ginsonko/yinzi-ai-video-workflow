<template>
  <div class="glb-preview" :class="{ loading: loading }">
    <canvas ref="canvas" aria-label="3D模型预览"></canvas>
    <div v-if="loading" class="glb-overlay">正在准备 3D 预览…</div>
    <div v-else-if="error" class="glb-overlay glb-error"><strong>模型预览不可用</strong><span>{{ error }}</span></div>
    <div v-else-if="!hasAsset" class="glb-overlay"><strong>等待 3D 成果</strong><span>模型生成后会在这里显示</span></div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const props = defineProps({ src: { type: String, default: '' } })
const canvas = ref(null); const loading = ref(false); const error = ref(''); const hasAsset = ref(false)
let renderer; let scene; let camera; let frame; let model; let resizeObserver

function addFallback() {
  model = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.2, 1.3), new THREE.MeshStandardMaterial({ color: 0x3a8275, roughness: .55, metalness: .12 }))
  model.position.y = .1; scene.add(model); hasAsset.value = true
}
function setup() {
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b1210)
  camera = new THREE.PerspectiveCamera(35, 1, .1, 100); camera.position.set(2.8, 1.9, 3.2); camera.lookAt(0, .2, 0)
  scene.add(new THREE.HemisphereLight(0xd5fff0, 0x1b2924, 2.4)); const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 4, 2); scene.add(key)
  renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true, alpha: false }); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  resizeObserver = new ResizeObserver(() => { const { clientWidth: w, clientHeight: h } = canvas.value.parentElement; renderer.setSize(Math.max(w, 180), Math.max(h, 150), false); camera.aspect = Math.max(w, 180) / Math.max(h, 150); camera.updateProjectionMatrix() }); resizeObserver.observe(canvas.value.parentElement)
  addFallback()
  const tick = () => { frame = requestAnimationFrame(tick); if (model) model.rotation.y += .004; renderer.render(scene, camera) }; tick()
}
async function loadAsset(src) {
  error.value = ''; loading.value = Boolean(src); if (!src) return
  try {
    const gltf = await new GLTFLoader().loadAsync(src)
    if (model) scene.remove(model); model = gltf.scene; model.position.y = -.5; scene.add(model); hasAsset.value = true
  } catch (e) { error.value = '请检查文件权限或贴图是否齐全'; hasAsset.value = true }
  finally { loading.value = false }
}
onMounted(() => { setup(); loadAsset(props.src) })
watch(() => props.src, (src) => loadAsset(src))
onBeforeUnmount(() => { if (frame) cancelAnimationFrame(frame); resizeObserver?.disconnect(); renderer?.dispose() })
</script>

<style scoped>
.glb-preview{position:relative;min-height:210px;height:100%;overflow:hidden;border:1px solid #263932;border-radius:8px;background:#0b1210}.glb-preview canvas{display:block;width:100%;height:100%;min-height:210px}.glb-overlay{position:absolute;inset:0;display:grid;place-content:center;gap:5px;padding:20px;color:#8fa69a;background:rgba(8,16,13,.45);text-align:center;font-size:10px}.glb-overlay strong{color:#d9f7e8;font-size:12px}.glb-error{background:rgba(43,19,24,.84)}.glb-error strong{color:#fda4af}
</style>
