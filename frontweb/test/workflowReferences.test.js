import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkflowReferences, normalizeWorkflowReferences } from '../src/utils/workflowReferences.js'

test('smart fill preserves manually selected references before suggested assets', () => {
  const result = mergeWorkflowReferences(
    { images: [{ path: 'upload.png', label: '用户上传', source: 'upload' }] },
    { images: [
      { path: 'director.png', source: 'director' },
      { path: 'character.png', source: 'character' },
      { path: 'scene.png', source: 'scene' },
      { path: 'storyboard.png', source: 'storyboard' },
    ] }
  )
  assert.deepEqual(result.images.map((item) => item.path), [
    'upload.png', 'director.png', 'character.png', 'scene.png',
  ])
})

test('reference merge deduplicates and enforces the 4/3/1 contract', () => {
  const result = mergeWorkflowReferences(
    { videos: ['motion.webm'], audios: ['voice.wav'] },
    {
      videos: ['motion.webm', 'a.mp4', 'b.mp4', 'c.mp4'],
      audios: ['other.wav'],
      images: ['1.png', '2.png', '3.png', '4.png', '5.png'],
    }
  )
  assert.equal(result.images.length, 4)
  assert.deepEqual(result.videos.map((item) => item.path), ['motion.webm', 'a.mp4', 'b.mp4'])
  assert.deepEqual(result.audios.map((item) => item.path), ['voice.wav'])
  assert.deepEqual(normalizeWorkflowReferences(null), { images: [], videos: [], audios: [] })
})
