'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { copyVerifiedExecutable } = require('../runtime');

const repoRoot = path.join(__dirname, '..', '..');
const targetDir = path.join(repoRoot, 'backend-node', 'tools', 'ffmpeg');
const targetFfmpeg = path.join(targetDir, 'ffmpeg.exe');
const targetFfprobe = path.join(targetDir, 'ffprobe.exe');

function run(file, args, label) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} 失败：${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function resolveSource(name) {
  const explicit = process.env[name === 'ffmpeg.exe' ? 'YINZI_FFMPEG_SOURCE' : 'YINZI_FFPROBE_SOURCE'];
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join('C:\\Program Files', 'ffmpeg-2025-03-20-git-76f09ab647-essentials_build', 'bin', name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function copyAtomic(source, destination) {
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const destinationHash = fs.existsSync(destination)
    ? crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
    : '';
  return copyVerifiedExecutable({
    source,
    destination,
    args: ['-version'],
    replaceExisting: sourceHash !== destinationHash,
  });
}

function verifyCapabilities() {
  const version = run(targetFfmpeg, ['-hide_banner', '-version'], 'FFmpeg 版本探针');
  const filters = run(targetFfmpeg, ['-hide_banner', '-filters'], 'FFmpeg 滤镜探针');
  const encoders = run(targetFfmpeg, ['-hide_banner', '-encoders'], 'FFmpeg 编码器探针');
  run(targetFfprobe, ['-hide_banner', '-version'], 'FFprobe 版本探针');

  if (!/--enable-gpl/i.test(version)) throw new Error('FFmpeg 必须启用 GPL，以提供 libx264');
  for (const filter of ['subtitles', 'drawtext', 'amix', 'atempo']) {
    if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw new Error(`FFmpeg 缺少 ${filter} 滤镜`);
  }
  for (const encoder of ['libx264', 'aac', 'libmp3lame']) {
    if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`FFmpeg 缺少 ${encoder} 编码器`);
  }
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('本发布脚本仅支持 Windows x64');
}

const sourceFfmpeg = resolveSource('ffmpeg.exe');
const sourceFfprobe = resolveSource('ffprobe.exe');
if (!sourceFfmpeg || !sourceFfprobe) {
  throw new Error('未找到发布用 FFmpeg/FFprobe。请设置 YINZI_FFMPEG_SOURCE 与 YINZI_FFPROBE_SOURCE。');
}

copyAtomic(sourceFfmpeg, targetFfmpeg);
copyAtomic(sourceFfprobe, targetFfprobe);

const sourceRoot = path.resolve(path.dirname(sourceFfmpeg), '..');
for (const [sourceName, targetName] of [
  ['LICENSE', 'LICENSE-FFMPEG-GPLv3.txt'],
  ['README.txt', 'README-FFMPEG-BUILD.txt'],
]) {
  const source = path.join(sourceRoot, sourceName);
  if (!fs.existsSync(source)) throw new Error(`FFmpeg 分发缺少 ${sourceName}`);
  fs.copyFileSync(source, path.join(targetDir, targetName));
}

verifyCapabilities();
console.log('[media] FFmpeg/FFprobe 已复制并通过版本、编码、字幕与混音能力探针。');
