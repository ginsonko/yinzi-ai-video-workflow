const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { npmExecutable } = require('../scripts/mac-build-utils');

const desktopDir = path.join(__dirname, '..');
const repositoryDir = path.join(desktopDir, '..');

describe('release packaging contract', () => {
  it('uses the native npm launcher on macOS and the command shim on Windows', () => {
    assert.equal(npmExecutable('darwin'), 'npm');
    assert.equal(npmExecutable('linux'), 'npm');
    assert.equal(npmExecutable('win32'), 'npm.cmd');
  });

  it('uses native matching-architecture macOS runners for DMG and ZIP builds', () => {
    const workflowPath = path.join(repositoryDir, '.github', 'workflows', 'release.yml');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(workflowText);
    const macJob = workflow.jobs['build-macos'];
    const matrix = macJob.strategy.matrix.include;

    assert.deepEqual(matrix, [
      { arch: 'x64', runner: 'macos-15-intel' },
      { arch: 'arm64', runner: 'macos-15' },
    ]);
    assert.equal(macJob['runs-on'], '${{ matrix.runner }}');
    assert.match(workflowText, /npm run dist:mac:\$\{\{ matrix\.arch \}\}/);
    assert.match(workflowText, /darwin-\$\{\{ matrix\.arch \}\}\.node/);
    assert.match(workflowText, /-name 'better_sqlite3\.node'/);
  });

  it('keeps Windows and native macOS outputs isolated', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    const macConfig = JSON.parse(fs.readFileSync(
      path.join(desktopDir, 'electron-builder-mac-v012.json'),
      'utf8'
    ));

    assert.equal(packageJson.version, '0.1.2-beta.1');
    assert.equal(packageJson.build.directories.output, 'release');
    assert.deepEqual(packageJson.build.nsis.preCompressedFileExtensions, []);
    assert.equal(macConfig.directories.output, 'release-mac');
    assert.equal(Object.hasOwn(macConfig.mac, 'identity'), false);
    assert.deepEqual(macConfig.mac.target, ['dmg', 'zip']);
    assert.equal(packageJson.scripts['dist:mac:x64'], 'node scripts/dist-mac.js x64');
    assert.equal(packageJson.scripts['dist:mac:arm64'], 'node scripts/dist-mac.js arm64');
  });

  it('requires the guided demo videos in the Windows release inputs', () => {
    const demoDir = path.join(desktopDir, 'frontweb-dist', 'demo');
    for (const name of [
      'director-preview.mp4',
      'test-shot-1.mp4',
      'test-shot-2.mp4',
      'test-shot-3.mp4',
      'test-final-film.mp4',
    ]) {
      const file = path.join(demoDir, name);
      assert.equal(fs.existsSync(file), true, `${name} is missing from desktop/frontweb-dist`);
      assert.ok(fs.statSync(file).size > 1024, `${name} is unexpectedly empty`);
    }
  });
});
