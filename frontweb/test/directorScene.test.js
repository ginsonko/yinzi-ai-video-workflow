import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDefaultDirectorDocument,
  interpolateObjectKeyframes,
  normalizeDirectorDocument,
} from '../src/utils/directorScene.js'

test('normalizes director documents and rejects dangling keyframes', () => {
  const doc = normalizeDirectorDocument({
    active_camera_id: 'missing',
    objects: [{ id: 'actor', kind: 'character', scale: [0, 1, 1] }],
    timeline: {
      duration: 5,
      keyframes: [
        { object_id: 'actor', time: 2, position: [1, 2, 3] },
        { object_id: 'missing', time: 3 },
      ],
    },
  })
  assert.equal(doc.active_camera_id, null)
  assert.equal(doc.objects[0].scale[0], 0.01)
  assert.equal(doc.timeline.keyframes.length, 1)
})

test('interpolates transforms between adjacent keyframes', () => {
  const value = interpolateObjectKeyframes([
    { object_id: 'actor', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { object_id: 'actor', time: 4, position: [8, 4, 0], rotation: [0, 2, 0], scale: [2, 2, 2] },
  ], 1)
  assert.deepEqual(value.position, [2, 1, 0])
  assert.deepEqual(value.rotation, [0, 0.5, 0])
  assert.deepEqual(value.scale, [1.25, 1.25, 1.25])
})

test('default director document contains a camera and visible stage objects', () => {
  const doc = createDefaultDirectorDocument()
  assert.ok(doc.objects.some((object) => object.kind === 'camera'))
  assert.ok(doc.objects.some((object) => object.kind === 'character'))
  assert.ok(doc.active_camera_id)
})
