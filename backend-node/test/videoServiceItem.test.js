const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _rowToItem } = require('../src/services/videoService');

describe('videoService API item mapping', () => {
  it('returns generation settings and provider task identity for reconciliation', () => {
    const item = _rowToItem({
      id: 9,
      duration: 4,
      aspect_ratio: '16:9',
      resolution: '480p',
      seed: 42,
      camera_fixed: 0,
      watermark: 1,
      first_frame_url: 'images/first.png',
      last_frame_url: 'images/last.png',
      reference_image_urls: '["images/ref.png"]',
      reference_video_urls: '["videos/ref.mp4"]',
      reference_audio_urls: '["audio/ref.mp3"]',
      provider_task_id: 'provider-task-9',
    });

    assert.equal(item.duration, 4);
    assert.equal(item.aspect_ratio, '16:9');
    assert.equal(item.resolution, '480p');
    assert.equal(item.seed, 42);
    assert.equal(item.camera_fixed, false);
    assert.equal(item.watermark, true);
    assert.equal(item.first_frame_url, 'images/first.png');
    assert.equal(item.last_frame_url, 'images/last.png');
    assert.equal(item.reference_image_urls, '["images/ref.png"]');
    assert.equal(item.reference_video_urls, '["videos/ref.mp4"]');
    assert.equal(item.reference_audio_urls, '["audio/ref.mp3"]');
    assert.equal(item.provider_task_id, 'provider-task-9');
  });
});
