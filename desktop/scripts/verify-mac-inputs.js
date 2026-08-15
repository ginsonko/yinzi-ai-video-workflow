'use strict';

const fs = require('fs');
const path = require('path');
const { assertNoSecrets } = require('./mac-build-utils');

const desktopDir = path.join(__dirname, '..');
const required = [
  'main.js',
  'runtime.js',
  'package.json',
  'electron-builder-mac-v012.json',
  'backend-app/src/app.js',
  'frontweb-dist/index.html',
  'build/icon.png',
  'LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
  'release-docs/Mac小白测试说明.md',
  'release-docs/Mac发布说明.md',
];

for (const relative of required) {
  if (!fs.existsSync(path.join(desktopDir, relative))) throw new Error(`Mac 发布输入缺失：desktop/${relative}`);
}
const config = JSON.parse(fs.readFileSync(path.join(desktopDir, 'electron-builder-mac-v012.json'), 'utf8'));
if (config.appId !== 'top.yinziapi.ai-video-workflow') throw new Error('Mac appId 与当前产品不一致');
if (config.productName !== '银子AI视频工作流') throw new Error('Mac 产品名与当前产品不一致');
if (config.directories?.output !== 'release-mac') throw new Error('Mac 构建会污染 Windows release 目录');
if (Object.hasOwn(config.mac || {}, 'identity')) throw new Error('Mac 配置不得永久关闭证书发现');
const targets = Array.isArray(config.mac?.target) ? config.mac.target : [];
if (!targets.includes('dmg') || !targets.includes('zip')) throw new Error('Mac 原生构建必须同时输出 DMG 和 ZIP');
assertNoSecrets([
  path.join(desktopDir, 'backend-app'),
  path.join(desktopDir, 'frontweb-dist'),
  path.join(desktopDir, 'release-docs'),
  path.join(desktopDir, 'main.js'),
  path.join(desktopDir, 'runtime.js'),
], new Set(['.js', '.json', '.yaml', '.yml', '.html', '.css', '.md', '.txt', '.svg']));
console.log('[mac-input] 品牌、输出边界、发布输入与凭据扫描通过。');
