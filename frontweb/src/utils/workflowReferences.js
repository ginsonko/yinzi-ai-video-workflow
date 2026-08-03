export const WORKFLOW_REFERENCE_LIMITS = Object.freeze({ images: 4, videos: 3, audios: 1 })

export function normalizeWorkflowReferences(value) {
  return {
    images: Array.isArray(value?.images) ? value.images : [],
    videos: Array.isArray(value?.videos) ? value.videos : [],
    audios: Array.isArray(value?.audios) ? value.audios : [],
  }
}

export function mergeWorkflowReferences(currentValue, suggestedValue) {
  const current = normalizeWorkflowReferences(currentValue)
  const suggested = normalizeWorkflowReferences(suggestedValue)
  const result = {}
  for (const [type, limit] of Object.entries(WORKFLOW_REFERENCE_LIMITS)) {
    const merged = []
    for (const item of [...current[type], ...suggested[type]]) {
      const path = typeof item === 'string' ? item : item?.path
      if (!path || merged.some((entry) => entry.path === path)) continue
      merged.push(typeof item === 'string'
        ? { path, label: String(path).split(/[\\/]/).pop() || '参考媒体', source: 'upload' }
        : item)
    }
    result[type] = merged.slice(0, limit)
  }
  return result
}
