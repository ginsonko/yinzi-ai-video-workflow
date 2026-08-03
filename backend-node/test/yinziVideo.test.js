const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildYinziVideoRequest,
  buildYinziReferences,
  extractYinziVideoUrl,
  buildYinziPollUrl,
  buildYinziContentUrl,
  callYinziVideoApi,
  pollVideoTask,
  formatVideoPostBodyForLog,
} = require('../src/services/videoClient');

const log = { info() {}, warn() {}, error() {} };

describe('YinziAPI video request mapping', () => {
  it('preserves opaque model names and reference role order', () => {
    const references = buildYinziReferences(
      { reference_urls: ['a', 'b'] },
      { references: ['https://cdn/a.png', 'https://cdn/b.png'] }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini',
      prompt: 'A slow dolly in',
      duration: 5,
      aspect_ratio: '9:16',
      references,
    });
    assert.equal(body.model, 'mg-seedance2.0 -480p mini');
    assert.equal(body.duration, 5);
    assert.equal(body.seconds, 5);
    assert.deepEqual(body.references.map((ref) => ref.role), ['reference', 'reference']);
  });

  it('maps a single first frame to a generic reference and clamps AIZZZ Seedance to five seconds', () => {
    const refs = buildYinziReferences(
      { model: 'mg-seedance2.0 -480p mini', first_frame_url: 'first' },
      { first: 'https://cdn/first.png' }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini', prompt: 'move', duration: 4, references: refs,
    });
    assert.deepEqual(refs, [{ type: 'image', role: 'reference', url: 'https://cdn/first.png' }]);
    assert.equal(body.seconds, 5);
    assert.equal(body.duration, 5);
  });

  it('maps classic first and last frames without mixing generic references', () => {
    const refs = buildYinziReferences(
      { first_frame_url: 'first', last_frame_url: 'last' },
      { first: 'https://cdn/first.png', last: 'https://cdn/last.png' }
    );
    assert.deepEqual(refs, [
      { type: 'image', role: 'first_frame', url: 'https://cdn/first.png' },
      { type: 'image', role: 'last_frame', url: 'https://cdn/last.png' },
    ]);
  });

  it('preserves typed file references and clamps the target duration to fifteen seconds', () => {
    const refs = buildYinziReferences(
      {
        model: 'mg-seedance2.0 -480p mini',
        reference_urls: ['image'],
        reference_video_urls: ['video'],
        reference_audio_urls: ['audio'],
      },
      {
        images: [{ file_id: 'file-image' }],
        videos: [{ file_id: 'file-video' }],
        audios: [{ file_id: 'file-audio' }],
      }
    );
    const body = buildYinziVideoRequest({
      model: 'mg-seedance2.0 -480p mini', prompt: 'move', duration: 99, references: refs,
    });
    assert.equal(body.seconds, 15);
    assert.deepEqual(body.references, [
      { type: 'image', role: 'reference', file_id: 'file-image' },
      { type: 'video', role: 'reference', file_id: 'file-video' },
      { type: 'audio', role: 'reference', file_id: 'file-audio' },
    ]);
  });

  it('redacts base64 reference bytes in request logs', () => {
    const formatted = formatVideoPostBodyForLog({
      references: [{ type: 'image', role: 'first_frame', url: 'data:image/png;base64,' + 'A'.repeat(100) }],
    });
    assert.match(formatted.references[0].url, /^\(base64, \d+ chars\)$/);
    const typed = formatVideoPostBodyForLog({
      references: [{ type: 'image', role: 'reference', data_url: 'data:image/png;base64,' + 'B'.repeat(80), file_id: 'private-id' }],
    });
    assert.match(typed.references[0].data_url, /^\(base64, \d+ chars\)$/);
    assert.equal(typed.references[0].file_id, '(site file reference)');
  });
});

describe('YinziAPI asynchronous lifecycle', () => {
  it('builds polling and authenticated content fallback URLs', () => {
    const config = { base_url: 'https://api.yinziapi.top/v1' };
    assert.equal(buildYinziPollUrl(config, 'task 123'), 'https://api.yinziapi.top/v1/videos/task%20123');
    assert.equal(buildYinziContentUrl(config, 'task 123'), 'https://api.yinziapi.top/v1/videos/task%20123/content');
  });

  it('prefers the signed Yinzi asset URL over a protected upstream video URL', () => {
    const signed = 'https://api.yinziapi.top/v1/assets/asset-1/content?signature=test';
    assert.equal(extractYinziVideoUrl({
      status: 'completed',
      content_url: signed,
      video_url: 'https://api.aizzz.xyz/v1/videos/upstream-task/content',
      artifacts: [{ type: 'video', download_url: signed }],
    }), signed);
  });

  it('never retries an ambiguous POST failure', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('socket closed');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9', video_gen_id: 1,
      });
      assert.equal(calls, 1);
      assert.equal(result.ambiguous_submission, true);
      assert.match(result.error, /不会自动重试/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects unsupported AIZZZ first/last semantics before submitting', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      throw new Error('must not submit');
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        aspect_ratio: '16:9', first_frame_url: 'first.png', last_frame_url: 'last.png', video_gen_id: 2,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /未创建上游任务/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('submits the full 4 image, 3 video, 1 audio contract with reference roles', async () => {
    const originalFetch = global.fetch;
    let submittedBody;
    global.fetch = async (_url, init) => {
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-multimedia', status: 'queued' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5, aspect_ratio: '16:9',
        reference_urls: Array.from({ length: 4 }, (_, i) => `https://media.test/image-${i}.png`),
        reference_video_urls: Array.from({ length: 3 }, (_, i) => `https://media.test/video-${i}.mp4`),
        reference_audio_urls: ['https://media.test/audio.mp3'],
        video_gen_id: 3,
      });
      assert.equal(result.task_id, 'task-multimedia');
      assert.equal(submittedBody.references.length, 8);
      assert.deepEqual(submittedBody.references.map((ref) => ref.type), [
        'image', 'image', 'image', 'image', 'video', 'video', 'video', 'audio',
      ]);
      assert.ok(submittedBody.references.every((ref) => ref.role === 'reference'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects media over the 4/3/1 limits before any POST', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('must not submit'); };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        reference_urls: Array.from({ length: 5 }, (_, i) => `https://media.test/image-${i}.png`),
        video_gen_id: 4,
      });
      assert.equal(calls, 0);
      assert.match(result.error, /最多支持 4 个参考图片/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('uploads local reference media to Yinzi files and submits file_id sources', async () => {
    const originalFetch = global.fetch;
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-reference-test-'));
    fs.writeFileSync(path.join(storage, 'frame.png'), Buffer.from('image'));
    fs.writeFileSync(path.join(storage, 'motion.mp4'), Buffer.from('video'));
    fs.writeFileSync(path.join(storage, 'voice.mp3'), Buffer.from('audio'));
    let uploadCount = 0;
    let submittedBody;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/files')) {
        uploadCount += 1;
        assert.ok(init.body instanceof FormData);
        return new Response(JSON.stringify({ id: `file-${uploadCount}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      submittedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'task-local-files' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await callYinziVideoApi(null, {
        base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key', endpoint: '/videos',
      }, log, {
        model: 'mg-seedance2.0 -480p mini', prompt: 'test', duration: 5,
        reference_urls: ['frame.png'],
        reference_video_urls: ['motion.mp4'],
        reference_audio_urls: ['voice.mp3'],
        storage_local_path: storage,
        video_gen_id: 5,
      });
      assert.equal(result.task_id, 'task-local-files');
      assert.equal(uploadCount, 3);
      assert.deepEqual(submittedBody.references.map((ref) => ref.file_id), ['file-1', 'file-2', 'file-3']);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });

  it('returns the authenticated content endpoint when a completed task has no public URL', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: 'task-1', status: 'completed', progress: 100 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    try {
      const result = await pollVideoTask(null, log, 1, 'task-1', {
        provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key',
      }, 1, 0);
      assert.equal(calls, 1);
      assert.equal(result.content_url, 'https://api.yinziapi.top/v1/videos/task-1/content');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a queued task recoverable when the local polling window ends', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({
      id: 'task-queued', status: 'queued', progress: 20,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    try {
      const result = await pollVideoTask(null, log, 1, 'task-queued', {
        provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://api.yinziapi.top/v1', api_key: 'not-a-real-key',
      }, 1, 0);
      assert.deepEqual(result, { pending: true, status: 'queued', progress: 20 });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
