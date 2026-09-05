<template>
  <section class="experience-panel delivery-panel" aria-labelledby="delivery-title">
    <header class="experience-heading"><div><small>最后一步</small><h3 id="delivery-title">交付给你</h3></div><span :class="['delivery-status', deliveryTone(delivery.status)]">{{ deliveryLabel(delivery.status) }}</span></header>
    <p class="delivery-summary">{{ delivery.summary || '所有成果完成检查后，会在这里列出可观看和可下载的成品。' }}</p>
    <div v-if="delivery.items?.length" class="delivery-list"><article v-for="item in delivery.items" :key="item.artifact_id || item.id"><span :class="['delivery-dot', item.verified ? 'verified' : '']"></span><div><strong>{{ item.title || '未命名成果' }}</strong><small>{{ item.verified ? '已核验，可交付' : item.required ? '还需要检查' : '可选成果' }}</small></div><a v-if="item.download_url || item.url" :href="item.download_url || item.url" target="_blank" rel="noreferrer">下载</a></article></div>
    <p v-else class="delivery-empty">交付清单会随着成果检查实时更新。</p>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { deliveryLabel, deliveryTone } from '@/utils/orchestrationExperience'
const props = defineProps({ delivery: { type: Object, default: () => ({}) } })
const delivery = computed(() => props.delivery || {})
</script>

<style scoped>
.experience-panel{border:1px solid #26312d;border-radius:12px;background:#111715;padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:#62d9c2;font-size:9px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:#e9efec;font-size:15px}.delivery-status{padding:4px 8px;border-radius:999px;background:#1a211f;color:#a3b0aa;font-size:9px}.delivery-status.success{color:#86efac;background:#10241a}.delivery-status.warning{color:#fcd34d;background:#2a2410}.delivery-status.danger{color:#fda4af;background:#2b1318}.delivery-summary,.delivery-empty{margin:11px 0;color:#829088;font-size:10px;line-height:1.6}.delivery-list{display:grid;gap:6px}.delivery-list article{display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid #293630;border-radius:6px;background:#0e1412}.delivery-dot{width:7px;height:7px;flex:none;border-radius:50%;background:#fbbf24}.delivery-dot.verified{background:#4ade80}.delivery-list article div{min-width:0;display:grid;gap:3px;flex:1}.delivery-list strong{overflow:hidden;color:#dce6e0;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.delivery-list small{color:#75847c;font-size:9px}.delivery-list a{color:#5eead4;font-size:9px;text-decoration:none}
</style>
