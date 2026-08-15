const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

  it('pins a supported Windows native toolchain and stops before tests when install fails', () => {
    const workflowPath = path.join(repositoryDir, '.github', 'workflows', 'release.yml');
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));
    const job = workflow.jobs['build-windows'];
    const stepNames = job.steps.map((step) => step.name);

    assert.equal(job['runs-on'], 'windows-2022');
    assert.equal(job.env?.npm_config_msvs_version, '2022');
    const setupPython = job.steps.find((step) => step.uses === 'actions/setup-python@v5');
    assert.equal(setupPython?.with?.['python-version'], '3.12');

    for (const component of ['backend', 'frontend', 'desktop']) {
      const installName = `Install ${component} dependencies`;
      const testName = `Test ${component}`;
      const install = job.steps.find((step) => step.name === installName);
      const test = job.steps.find((step) => step.name === testName);
      assert.equal(install?.run, 'npm ci', `${installName} must contain only npm ci`);
      assert.ok(test, `${testName} is missing`);
      assert.ok(stepNames.indexOf(installName) < stepNames.indexOf(testName));
    }
  });

  it('prepares matching macOS media tools before backend tests and reuses desktop dependencies', () => {
    const workflowPath = path.join(repositoryDir, '.github', 'workflows', 'release.yml');
    const workflowText = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(workflowText);
    const job = workflow.jobs['build-macos'];
    const stepNames = job.steps.map((step) => step.name);
    const desktopInstalls = job.steps.filter((step) => (
      step['working-directory'] === 'desktop' && step.run === 'npm ci'
    ));
    const prepare = job.steps.find((step) => step.name === 'Prepare native media tools');
    const desktopTest = job.steps.find((step) => step.name === 'Test desktop');

    assert.equal(desktopInstalls.length, 1);
    assert.ok(stepNames.indexOf('Install desktop dependencies') < stepNames.indexOf('Prepare native media tools'));
    assert.ok(stepNames.indexOf('Prepare native media tools') < stepNames.indexOf('Test backend'));
    assert.equal(desktopTest?.run, 'npm test');
    assert.match(prepare?.run || '', /prepare-mac-resources\.js "\$\{\{ matrix\.arch \}\}"/);
    assert.match(prepare?.run || '', /GITHUB_PATH/);
    assert.match(prepare?.run || '', /FFMPEG_PATH=/);
    assert.match(prepare?.run || '', /FFPROBE_PATH=/);
    assert.match(workflowText, /mac-resources\/\$\{\{ matrix\.arch \}\}\/ffmpeg/);
  });

  it('ships the LGPL license required by a fresh arm64 runner outside ignored caches', () => {
    const licensePath = path.join(desktopDir, 'licenses', 'LICENSE-LGPL-2.1.txt');
    const script = fs.readFileSync(path.join(desktopDir, 'scripts', 'prepare-mac-resources.js'), 'utf8');
    const licenseText = fs.readFileSync(licensePath, 'utf8').replace(/\r\n/g, '\n');
    const hash = crypto.createHash('sha256').update(licenseText, 'utf8').digest('hex');

    assert.equal(hash, '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95');
    assert.match(script, /path\.join\(desktopDir, 'licenses', 'LICENSE-LGPL-2\.1\.txt'\)/);
    assert.doesNotMatch(script, /path\.join\(cacheDir, 'LICENSE-LGPL-2\.1\.txt'\)/);
  });

  it('checks out required LFS media on every platform build', () => {
    const workflowPath = path.join(repositoryDir, '.github', 'workflows', 'release.yml');
    const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf8'));

    for (const jobName of ['build-windows', 'build-macos']) {
      const checkout = workflow.jobs[jobName].steps.find((step) => step.uses === 'actions/checkout@v4');
      assert.ok(checkout, `${jobName} is missing actions/checkout`);
      assert.equal(checkout.with?.lfs, true, `${jobName} must materialize Git LFS media`);
    }
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
