#!/usr/bin/env node

/*
 * Portable local-runtime bridge for the Codex plugin.
 * It never calls a paid provider. It only starts/reuses the local API and
 * returns a small JSON record that MCP can use to open the real UI.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, '..')
const DEFAULT_REPOSITORY = 'https://github.com/ginsonko/yinzi-ai-video-workflow.git'
const CANDIDATE_PORTS = [5683, 5679, 5680, 5682]
const args = process.argv.slice(2)
const command = args[0] || 'status'

function option(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function hasFlag(name) { return args.includes(name) }

function fail(message, code = 1) {
  const payload = { ok: false, error: message, code }
  process.exitCode = code
  return payload
}

function emit(payload) {
  if (hasFlag('--json')) process.stdout.write(`${JSON.stringify(payload)}\n`)
  else if (payload?.ok === false) process.stderr.write(`${payload.error || '操作失败'}\n`)
  else process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
}

function stateRoot() {
  const explicit = String(process.env.YINZI_WORKFLOW_RUNTIME_DIR || option('--runtime-dir') || '').trim()
  if (explicit) return path.resolve(explicit)
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Yinzi', 'CodexVideoWorkflow')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Yinzi', 'CodexVideoWorkflow')
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'yinzi-codex-video-workflow')
}

function registryPath() { return path.join(stateRoot(), 'runtime.json') }

async function readRegistry() {
  try { return JSON.parse(await fsp.readFile(registryPath(), 'utf8')) } catch { return null }
}

async function writeRegistry(record) {
  const file = registryPath()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temp, file)
}

function findProjectRoot(start = process.cwd()) {
  const explicit = String(process.env.YINZI_WORKFLOW_PROJECT_ROOT || option('--project-root') || '').trim()
  if (explicit) return path.resolve(explicit)
  let current = path.resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, 'backend-node', 'src', 'server.js')) && fs.existsSync(path.join(current, 'frontweb'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function httpJson(url, timeoutMs = 1600) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then(async response => ({ response, payload: await response.json().catch(() => ({})) }))
}

async function probe(origin) {
  try {
    const [health, identity] = await Promise.all([httpJson(`${origin}/health`), httpJson(`${origin}/api/v1/runtime-identity`)]);
    const data = identity.payload?.data ?? identity.payload
    if (!health.response.ok || health.payload?.status !== 'ok' || !identity.response.ok || data?.orchestration_router !== true) return null
    return { health: health.payload, identity: data }
  } catch { return null }
}

async function findPort(preferred) {
  const values = []
  if (preferred) values.push(Number(preferred))
  values.push(...CANDIDATE_PORTS)
  for (const port of [...new Set(values)].filter(value => Number.isInteger(value) && value > 0 && value < 65536)) {
    const free = await new Promise(resolve => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function prepareRuntime(sourceRoot, port) {
  const root = path.join(stateRoot(), 'runtimes', 'default')
  const configDir = path.join(root, 'configs')
  await fsp.mkdir(path.join(root, 'data', 'storage'), { recursive: true })
  await fsp.mkdir(path.join(root, 'logs'), { recursive: true })
  await fsp.mkdir(configDir, { recursive: true })
  const sourceConfig = path.join(sourceRoot, 'backend-node', 'configs', 'config.yaml')
  const targetConfig = path.join(configDir, 'config.yaml')
  let content = await fsp.readFile(sourceConfig, 'utf8')
  content = content.replace(/(^\s*port:\s*)\d+\s*$/m, (_, prefix) => `${prefix}${port}`)
    .replace(/(^\s*host:\s*).+$/m, (_, prefix) => `${prefix}127.0.0.1`)
    .replace(/(^\s*path:\s*)\.\/data\/drama_generator\.db\s*$/m, '$1./data/drama_generator.db')
    .replace(/(^\s*local_path:\s*)\.\/data\/storage\s*$/m, '$1./data/storage')
  await fsp.writeFile(targetConfig, content, 'utf8')
  return root
}

function spawnBackend(sourceRoot, runtimeRoot, port) {
  const sourceBackend = path.join(sourceRoot, 'backend-node')
  const output = path.join(runtimeRoot, 'logs', `backend-${Date.now()}.log`)
  const stream = fs.createWriteStream(output, { flags: 'a' })
  const child = spawn(process.execPath, [path.join(sourceBackend, 'src', 'server.js')], {
    cwd: runtimeRoot,
    env: { ...process.env, PORT: String(port), WEB_DIST_PATH: path.join(sourceRoot, 'frontweb', 'dist'), YINZI_WORKFLOW_CANONICAL: '1', PRODUCTION_AUTONOMY_DISABLED: process.env.PRODUCTION_AUTONOMY_DISABLED || '0', LOG_FILE: output },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  child.unref()
  return { pid: child.pid, log: output }
}

async function waitForHealth(origin, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const result = await probe(origin)
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return null
}

async function buildFrontend(sourceRoot) {
  const dist = path.join(sourceRoot, 'frontweb', 'dist')
  if (fs.existsSync(path.join(dist, 'index.html'))) return { status: 'present', path: dist }
  if (!hasFlag('--build')) return { status: 'missing', path: dist, hint: '请先在 frontweb 安装依赖并构建，或使用 --build' }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await new Promise((resolve, reject) => {
    const child = spawn(npm, ['run', 'build'], { cwd: path.join(sourceRoot, 'frontweb'), env: process.env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`前端构建失败（退出码 ${code}）`)))
  })
  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('前端构建结束但没有生成 dist/index.html')
  return { status: 'built', path: dist }
}

async function ensure() {
  const existing = await readRegistry()
  if (existing?.api_base) {
    const live = await probe(existing.api_base)
    const identityMatches = live && (!existing.runtime_id || (
      existing.runtime_id === live.identity.runtime_id
      && (!existing.source_revision || existing.source_revision === live.identity.source_revision)
      && (!existing.database_fingerprint || existing.database_fingerprint === live.identity.database?.fingerprint)
    ))
    if (identityMatches) return { ...existing, reused: true, frontend_url: existing.frontend_url || `${existing.api_base}/`, identity: live.identity }
    if (live && existing.runtime_id) return fail('登记的工作流运行时身份已变化，已停止自动接入以避免连接错误数据库。请检查运行时登记或设置新的 YINZI_WORKFLOW_RUNTIME_DIR。', 2)
  }
  // A desktop package or a launcher from an earlier install may be healthy
  // without our registry. Reuse only a runtime that proves the orchestration
  // identity; never start a second database merely because a port is busy.
  const hinted = String(process.env.YINZI_WORKFLOW_URL || option('--api-base') || '').trim().replace(/\/+$/, '')
  const candidates = hinted ? [hinted] : CANDIDATE_PORTS.map(port => `http://127.0.0.1:${port}`)
  for (const origin of candidates) {
    const live = await probe(origin)
    if (!live) continue
    const record = {
      schema: 'yinzi.codex-runtime/v1', source_root: null, runtime_root: null,
      api_base: origin, frontend_url: `${origin}/`, pid: null,
      started_at: null, runtime_id: live.identity.runtime_id || null,
      source_revision: live.identity.source_revision || null,
      database_fingerprint: live.identity.database?.fingerprint || null,
      app_version: live.identity.app_version || live.health?.version || null,
      paid_calls_started: null, adopted_existing: true,
    }
    await writeRegistry(record)
    return { ...record, reused: true, identity: live.identity }
  }
  const source = findProjectRoot()
  if (!source) return fail('未找到工作流源码或桌面运行时。请安装银子工作流桌面包，或设置 YINZI_WORKFLOW_PROJECT_ROOT 指向包含 backend-node/frontweb 的项目。', 2)
  const frontend = await buildFrontend(source)
  if (frontend.status === 'missing') return fail(frontend.hint, 2)
  const port = await findPort(option('--backend-port'))
  const runtimeRoot = await prepareRuntime(source, port)
  const origin = `http://127.0.0.1:${port}`
  const processInfo = spawnBackend(source, runtimeRoot, port)
  const live = await waitForHealth(origin)
  if (!live) return fail(`工作流后端启动失败。日志：${processInfo.log}`, 3)
  const record = {
    schema: 'yinzi.codex-runtime/v1',
    source_root: source,
    runtime_root: runtimeRoot,
    api_base: origin,
    frontend_url: `${origin}/`,
    pid: processInfo.pid,
    started_at: new Date().toISOString(),
    runtime_id: live.identity.runtime_id || null,
    source_revision: live.identity.source_revision || null,
    database_fingerprint: live.identity.database?.fingerprint || null,
    app_version: live.identity.app_version || live.health?.version || null,
    paid_calls_started: false,
  }
  await writeRegistry(record)
  return { ...record, reused: false, identity: live.identity }
}

async function status() {
  const record = await readRegistry()
  if (!record) return { ok: true, active: false, registry: registryPath() }
  const live = record.api_base ? await probe(record.api_base) : null
  return { ok: true, active: Boolean(live), registry: registryPath(), runtime: live ? { ...record, identity: live.identity } : record }
}

async function stop() {
  const record = await readRegistry()
  if (!record?.pid || !record.api_base) return { ok: true, stopped: false, reason: '没有登记的运行时' }
  const live = await probe(record.api_base)
  if (!live || (record.runtime_id && live.identity.runtime_id !== record.runtime_id)) return fail('登记的运行时身份已变化，未停止未知进程。', 2)
  try { process.kill(record.pid) } catch (error) { if (error.code !== 'ESRCH') return fail(`停止运行时失败：${error.message}`, 2) }
  await fsp.rm(registryPath(), { force: true })
  return { ok: true, stopped: true, api_base: record.api_base }
}

async function main() {
  let result
  if (command === 'ensure') result = await ensure()
  else if (command === 'status') result = await status()
  else if (command === 'stop') result = await stop()
  else result = fail(`未知命令：${command}。可用命令：ensure、status、stop`, 2)
  emit(result)
}

main().catch(error => emit(fail(error?.message || String(error), 3)))
