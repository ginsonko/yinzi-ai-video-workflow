<template>
  <section class="experience-panel progress-panel" aria-labelledby="progress-title">
    <header class="experience-heading">
      <div><small>现在进行到哪里</small><h3 id="progress-title">制作进度</h3></div>
      <span v-if="progress.percent !== null" class="progress-number">{{ progress.percent }}%</span>
      <span v-else class="progress-number">阶段制</span>
    </header>
    <el-progress v-if="progress.percent !== null" :percentage="progress.percent" :stroke-width="10" :show-text="false" status="success" />
    <div class="progress-copy" aria-live="polite">
      <strong>{{ currentText }}</strong>
      <span>{{ progress.total ? `已完成 ${progress.done} / ${progress.total} 个步骤` : 'Codex 还在整理制作步骤' }}</span>
    </div>
    <div class="progress-stages">
      <span v-for="stage in stages" :key="stage.key" :class="stage.tone"><i></i>{{ stage.label }}</span>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { progressFromNodes } from '@/utils/orchestrationExperience'

const props = defineProps({ session: { type: Object, default: () => ({}) }, nodes: { type: Array, default: () => [] } })
const progress = computed(() => progressFromNodes(props.nodes))
const currentText = computed(() => {
  if (progress.value.current?.progress?.message) return progress.value.current.progress.message
  if (progress.value.current?.status === 'failed') return '有一个步骤需要处理'
  if (progress.value.current?.status === 'partial') return '有一个步骤只完成了一部分'
  if (progress.value.current?.status === 'running') return '正在执行当前步骤'
  if (props.session.status === 'succeeded') return '制作已完成，正在整理交付物'
  if (props.session.status === 'paused') return '制作已暂停，可以从恢复点继续'
  if (props.session.status === 'waiting_confirmation') return '计划已准备好，等待你确认'
  return 'Codex 正在准备下一步'
})
const stages = computed(() => {
  const names = [['prepare', '准备'], ['create', '创作'], ['review', '检查'], ['deliver', '交付']]
  const status = String(props.session.status || '')
  const current = status === 'succeeded' ? 4 : status === 'running' ? 2 : status === 'partial' ? 3 : status === 'waiting_confirmation' ? 1 : 0
  return names.map(([key, label], index) => ({ key, label, tone: index < current ? 'done' : index === current ? 'current' : '' }))
})
</script>

<style scoped>
.experience-panel{border:1px solid #26312d;border-radius:12px;background:#111715;padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:#62d9c2;font-size:9px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:#e9efec;font-size:15px}.progress-number{color:#86efac;font-size:15px;font-weight:700}.progress-copy{display:grid;gap:4px;margin-top:12px}.progress-copy strong{color:#dfe8e3;font-size:12px}.progress-copy span{color:#829088;font-size:10px}.progress-stages{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:14px;color:#6d7a73;font-size:9px}.progress-stages span{display:flex;align-items:center;gap:5px}.progress-stages i{width:7px;height:7px;border-radius:50%;background:#3a4540}.progress-stages .done{color:#9ae6b4}.progress-stages .done i{background:#4ade80}.progress-stages .current{color:#5eead4}.progress-stages .current i{background:#2dd4bf;box-shadow:0 0 0 3px rgba(45,212,191,.12)}
</style>
