export const DIRECTOR_DOCUMENT_VERSION = 1

const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function vec3(value, fallback) {
  const input = Array.isArray(value) ? value : []
  return [0, 1, 2].map((index) => finiteNumber(input[index], fallback[index]))
}

export function normalizeDirectorObject(value, index = 0) {
  const object = value && typeof value === 'object' ? value : {}
  const kind = ['character', 'box', 'sphere', 'plane', 'light', 'camera'].includes(object.kind)
    ? object.kind
    : 'box'
  return {
    id: String(object.id || `object-${index + 1}`),
    kind,
    name: String(object.name || `${kind}-${index + 1}`).slice(0, 80),
    position: vec3(object.position, DEFAULT_TRANSFORM.position),
    rotation: vec3(object.rotation, DEFAULT_TRANSFORM.rotation),
    scale: vec3(object.scale, DEFAULT_TRANSFORM.scale).map((number) => Math.max(0.01, number)),
    props: object.props && typeof object.props === 'object' ? { ...object.props } : {},
  }
}

function normalizeKeyframe(value) {
  const keyframe = value && typeof value === 'object' ? value : {}
  return {
    object_id: String(keyframe.object_id || ''),
    time: Math.max(0, finiteNumber(keyframe.time, 0)),
    position: vec3(keyframe.position, DEFAULT_TRANSFORM.position),
    rotation: vec3(keyframe.rotation, DEFAULT_TRANSFORM.rotation),
    scale: vec3(keyframe.scale, DEFAULT_TRANSFORM.scale).map((number) => Math.max(0.01, number)),
  }
}

export function normalizeDirectorDocument(value) {
  const input = value && typeof value === 'object' ? value : {}
  const objects = Array.isArray(input.objects)
    ? input.objects.slice(0, 200).map(normalizeDirectorObject)
    : []
  const ids = new Set(objects.map((object) => object.id))
  const duration = Math.min(60, Math.max(1, finiteNumber(input.timeline?.duration, 5)))
  const keyframes = Array.isArray(input.timeline?.keyframes)
    ? input.timeline.keyframes
      .slice(0, 2000)
      .map(normalizeKeyframe)
      .filter((keyframe) => ids.has(keyframe.object_id) && keyframe.time <= duration)
      .sort((a, b) => a.time - b.time)
    : []
  return {
    version: DIRECTOR_DOCUMENT_VERSION,
    active_camera_id: ids.has(String(input.active_camera_id || '')) ? String(input.active_camera_id) : null,
    objects,
    timeline: { duration, keyframes },
  }
}

export function createDefaultDirectorDocument() {
  return normalizeDirectorDocument({
    active_camera_id: 'camera-1',
    objects: [
      { id: 'character-1', kind: 'character', name: '角色 1', position: [0, 0, 0], props: { color: '#1fc7a1' } },
      { id: 'box-1', kind: 'box', name: '道具箱', position: [2.2, 0.5, -0.8], scale: [1.2, 1, 1.2], props: { color: '#e46f51' } },
      { id: 'camera-1', kind: 'camera', name: '镜头 1', position: [6.5, 4.2, 8], rotation: [-0.28, 0.58, 0], props: { fov: 42, aspect: 1.7777777778 } },
    ],
    timeline: { duration: 5, keyframes: [] },
  })
}

function lerp(a, b, amount) {
  return a + (b - a) * amount
}

function interpolateVec3(a, b, amount) {
  return [0, 1, 2].map((index) => lerp(a[index], b[index], amount))
}

export function interpolateObjectKeyframes(keyframes, time) {
  const track = (Array.isArray(keyframes) ? keyframes : [])
    .map(normalizeKeyframe)
    .sort((a, b) => a.time - b.time)
  if (!track.length) return null
  const current = Math.max(0, finiteNumber(time, 0))
  if (current <= track[0].time) return { ...track[0] }
  if (current >= track[track.length - 1].time) return { ...track[track.length - 1] }
  let left = track[0]
  let right = track[track.length - 1]
  for (let index = 1; index < track.length; index += 1) {
    if (track[index].time >= current) {
      left = track[index - 1]
      right = track[index]
      break
    }
  }
  const span = Math.max(0.000001, right.time - left.time)
  const amount = Math.min(1, Math.max(0, (current - left.time) / span))
  return {
    object_id: left.object_id,
    time: current,
    position: interpolateVec3(left.position, right.position, amount),
    rotation: interpolateVec3(left.rotation, right.rotation, amount),
    scale: interpolateVec3(left.scale, right.scale, amount),
  }
}
