export function normalizeLocalMediaUrl(value, currentOrigin) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw)) return raw
  try {
    const parsed = new URL(raw)
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase())) return raw
    if (!parsed.pathname.startsWith('/static/')) return raw
    const origin = currentOrigin || (typeof window !== 'undefined' ? window.location.origin : '')
    if (!origin) return raw
    return `${String(origin).replace(/\/$/, '')}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch (_) {
    return raw
  }
}

/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return normalizeLocalMediaUrl(item.image_url || '')
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return normalizeLocalMediaUrl(sb.video_url || '')
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  return '/static/' + p.replace(/^\//, '')
}
