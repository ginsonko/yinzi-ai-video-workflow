import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'runtime-launcher.mjs')

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

test('status is read-only when no runtime registry exists', async () => {
  const result = await run(['status', '--json'], { YINZI_WORKFLOW_RUNTIME_DIR: path.join(process.env.TEMP || '/tmp', `yinzi-runtime-status-${process.pid}`) })
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.active, false)
})

test('unknown command fails with actionable JSON', async () => {
  const result = await run(['invalid', '--json'])
  assert.equal(result.code, 2)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /ensure|status|stop/)
})
