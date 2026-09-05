<template>
  <section class="experience-panel artifact-panel" aria-labelledby="artifact-title">
    <header class="experience-heading"><div><small>已经做出了什么</small><h3 id="artifact-title">成果预览</h3></div><span class="artifact-count">{{ items.length }} 项</span></header>
    <p v-if="error" class="artifact-note error">暂时无法刷新成果，仍保留上一次成功显示。</p>
    <p v-else-if="!items.length && !loading" class="artifact-note">成果会在每一步完成后第一时间出现在这里。</p>
    <div v-if="loading" class="artifact-loading">正在读取最新成果…</div>
    <div v-else class="artifact-grid">
      <article v-for="item in items" :key="item.id" class="artifact-card">
        <div class="artifact-media">
          <img v-if="item.type === 'image' && item.url" :src="item.url" :alt="item.title" loading="lazy" />
          <video v-else-if="item.type === 'video' && item.url" :src="item.url" controls preload="metadata" :aria-label="item.title" />
          <audio v-else-if="item.type === 'audio' && item.url" :src="item.url" controls preload="metadata" />
          <GlbPreview v-else-if="['model','glb','scene'].includes(item.type)" :src="item.url || ''" />
          <div v-else class="artifact-placeholder"><strong>{{ item.status === 'failed' ? '生成失败' : '等待文件' }}</strong><span>{{ item.status === 'failed' ? (item.error_message || '请查看步骤详情') : '后端还未提供可播放地址' }}</span></div>
        </div>
        <footer><div><strong>{{ item.title }}</strong><span>{{ mediaTypeLabel(item.type) }} · {{ item.status === 'validated' ? '已检查' : item.status === 'failed' ? '失败' : '可查看' }}</span></div><a v-if="item.download_url" :href="item.download_url" target="_blank" rel="noreferrer">下载</a></footer>
      </article>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import GlbPreview from './GlbPreview.vue'
import { mediaTypeLabel, normalizeArtifacts } from '@/utils/orchestrationExperience'
const props = defineProps({ items: { type: Array, default: () => [] }, loading: Boolean, error: { type: String, default: '' } })
const items = computed(() => normalizeArtifacts(props.items))
</script>

<style scoped>
.experience-panel{border:1px solid #26312d;border-radius:12px;background:#111715;padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:#62d9c2;font-size:9px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:#e9efec;font-size:15px}.artifact-count{color:#829088;font-size:10px}.artifact-note{margin:12px 0 0;color:#829088;font-size:10px;line-height:1.6}.artifact-note.error{color:#f5b6c0}.artifact-loading{padding:28px 0;color:#829088;font-size:10px}.artifact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:14px}.artifact-card{min-width:0;overflow:hidden;border:1px solid #293630;border-radius:8px;background:#0e1412}.artifact-media{aspect-ratio:16/10;min-height:150px;background:#0a100e}.artifact-media img,.artifact-media video{display:block;width:100%;height:100%;object-fit:cover}.artifact-media audio{width:calc(100% - 18px);margin:64px 9px}.artifact-placeholder{height:100%;display:grid;place-content:center;gap:5px;padding:18px;color:#78877f;text-align:center;font-size:9px}.artifact-placeholder strong{color:#d3ddd7;font-size:11px}.artifact-card footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px}.artifact-card footer div{min-width:0;display:grid;gap:3px}.artifact-card footer strong{overflow:hidden;color:#dce6e0;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.artifact-card footer span{color:#75847c;font-size:9px}.artifact-card footer a{flex:none;color:#5eead4;font-size:9px;text-decoration:none}.artifact-card footer a:hover{text-decoration:underline}
@media(max-width:600px){.artifact-grid{grid-template-columns:1fr 1fr}.artifact-media{min-height:120px}}
</style>
