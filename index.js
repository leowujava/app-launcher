/**
 * Host half of the App launcher bundle.
 *
 * Reads VS Code `launch.json` files (JSONC: comments and trailing commas are
 * accepted) and manages the declared applications:
 *
 *  - java  -> `mvn spring-boot:run` in the Maven module that owns `mainClass`
 *  - node  -> `runtimeExecutable` + `runtimeArgs` / `program` (npm, pnpm, node, ...)
 *  - shell -> a command string run through the platform shell
 *
 * The sidebar panel, the `/launch` command and the `launcher` agent tool all
 * call the same Host operations, so the UI and the agent see one state.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'workingDirectory']

export const Config = z.object({
  mvnPath: z.string().default('mvn').description('Maven executable used for java configurations (a local mvnw wins when present).'),
  startTimeoutMs: z.number().default(180000).description('Maximum time to wait for a java application to report readiness; after this the process keeps running and the row shows the reason.'),
  nodeReadyTimeoutMs: z.number().default(20000).description('Maximum time to wait for a node/shell application readiness log before treating a live process as running.'),
  maxLogBytes: z.number().default(65536).description('Per-instance log tail retained for the logs action.'),
  mavenOpts: z.string().default('').description('Extra JVM options appended to MAVEN_OPTS for every Maven run.'),
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const JANSI_NOISE = /^(Failed to load native library|java\.lang\.UnsatisfiedLinkError|osinfo:).*$/m
const PORT_POLL_MS = 500
const STOP_GRACE_MS = 10_000
const NODE_ALIVE_GRACE_MS = 3_000
const RESULT_HEAD_CHARS = 3_000
const RESULT_TAIL_CHARS = 4_000
const MAX_TRACKED = 30
const MODULE_SCAN_MAX_DIRS = 4_000
const SKIP_DIRS = new Set([
  'node_modules', 'target', '.git', '.svn', '.hg', '.idea', '.vscode',
  'dist', 'build', 'out', 'coverage', '.gradle', '.next', '.nuxt', 'vendor',
])

const SUPPORTED_TYPES = new Set(['java', 'node', 'pwa-node', 'shell', 'bash'])

const READY_PATTERNS = {
  java: [
    /Started .+ in [\d.]+ seconds/,
    /Tomcat started on port/,
    /Netty started on port/,
    /Jetty started on port/,
    /Undertow started on port/,
    /LiveReload server is running/,
  ],
  node: [
    /Local:\s+https?:\/\//i,
    /listening on/i,
    /ready in [\d.]+/i,
    /compiled successfully/i,
    /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i,
  ],
  shell: [
    /listening on/i,
    /ready/i,
    /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i,
  ],
}

function isWin() {
  return process.platform === 'win32'
}

/** Quote-aware whitespace split, so `-Dflag="--a --b"` stays one token. */
function tokenize(input) {
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal !== undefined && signal.aborted) { resolve(); return }
    const timer = setTimeout(resolve, ms)
    if (signal !== undefined) {
      const onAbort = () => { clearTimeout(timer); resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function killTree(proc, signal, asGroup = false) {
  if (proc === undefined || proc === null || proc.pid === undefined) return
  if (isWin()) {
    const args = ['/pid', String(proc.pid)]
    if (asGroup) args.push('/t')
    args.push('/f')
    try { spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }) } catch { /* already gone */ }
    return
  }
  try {
    if (asGroup) process.kill(-proc.pid, signal)
    else process.kill(proc.pid, signal)
  } catch {
    if (asGroup) {
      try { process.kill(proc.pid, signal) } catch { /* already gone */ }
    }
  }
}

function processExited(proc) {
  return proc !== undefined && proc !== null && (proc.exitCode !== null || proc.exitSignal !== undefined)
}

/** Merge MAVEN_OPTS, keeping jansi's native library on a writable, executable partition. */
function mavenEnv(extra) {
  const env = { ...process.env }
  const parts = []
  if (env.MAVEN_OPTS) parts.push(env.MAVEN_OPTS)
  const jansiDir = path.join(process.env.DSH_HOME ?? os.homedir(), '.jansi')
  try {
    fs.mkdirSync(jansiDir, { recursive: true })
    parts.push(`-Djansi.tmpdir=${jansiDir}`)
  } catch { /* not writable: keep jansi's default and filter its noise below */ }
  if (extra) parts.push(extra)
  env.MAVEN_OPTS = parts.join(' ').trim()
  return env
}

/** Bound a possibly large captured stream for a model-facing result. */
function boundText(text) {
  const clean = String(text ?? '').replace(JANSI_NOISE, '').trimEnd()
  if (clean.length <= RESULT_HEAD_CHARS + RESULT_TAIL_CHARS) return clean
  const head = clean.slice(0, RESULT_HEAD_CHARS)
  const tail = clean.slice(-RESULT_TAIL_CHARS)
  const omitted = clean.length - RESULT_HEAD_CHARS - RESULT_TAIL_CHARS
  return `${head}\n[... ${omitted} characters omitted ...]\n${tail}`
}

/** Rolling log that retains the most recent maxBytes characters. */
function makeRing(maxBytes) {
  let text = ''
  let droppedBytes = 0
  return {
    append(chunk) {
      text += String(chunk)
      if (text.length > maxBytes) {
        const over = text.length - maxBytes
        droppedBytes += over
        text = text.slice(over)
      }
    },
    get dropped() { return droppedBytes },
    text() { return text },
    tailLines(lines) {
      const ls = text.split('\n')
      return ls.slice(-Math.max(1, lines)).join('\n')
    },
    tail(chars) {
      return text.length > chars ? `…\n${text.slice(-chars)}` : text
    },
  }
}

/** Best-effort: server.port from a Maven module's Spring Boot config files. */
function detectSpringPort(moduleRoot, vmArgsText) {
  const res = path.join(moduleRoot, 'src', 'main', 'resources')
  let entries
  try { entries = fs.readdirSync(res) } catch { return undefined }
  const inRange = (m) => {
    const n = Number(m)
    return n >= 1 && n <= 65535 ? n : undefined
  }
  const profileMatch = /-Dspring\.profiles\.active=([A-Za-z0-9_,\-]+)/.exec(vmArgsText ?? '')
  const profile = profileMatch !== null ? profileMatch[1].split(',')[0].trim() : ''
  const candidates = []
  if (profile.length > 0) {
    candidates.push(`application-${profile}.yml`, `application-${profile}.yaml`, `application-${profile}.properties`)
  }
  candidates.push('application.yml', 'application.yaml', 'application.properties')
  for (const name of candidates) {
    if (!entries.includes(name)) continue
    let text
    try { text = fs.readFileSync(path.join(res, name), 'utf8') } catch { continue }
    if (name.endsWith('.properties')) {
      const m = /^\s*server\.port\s*=\s*(\d{1,5})/m.exec(text)
      if (m !== null) { const n = inRange(m[1]); if (n !== undefined) return n }
    } else {
      const m = /^server:\s*\r?\n\s*port:\s*(\d{1,5})/m.exec(text)
      if (m !== null) { const n = inRange(m[1]); if (n !== undefined) return n }
    }
  }
  return undefined
}

/** Map every process's cwd to its pids (Linux; single /proc pass). */
function scanProcCwds() {
  const map = new Map()
  if (isWin()) return map
  let pids
  try { pids = fs.readdirSync('/proc') } catch { return map }
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue
    let cwd
    try { cwd = fs.readlinkSync(`/proc/${entry}/cwd`) } catch { continue }
    const list = map.get(cwd)
    if (list === undefined) map.set(cwd, [Number(entry)])
    else list.push(Number(entry))
  }
  return map
}

/** Best-effort: pid holding a TCP port (Linux, /proc/net/tcp + fd scan). */
function findPortPid(port) {
  if (isWin() || typeof port !== 'number' || port < 1) return undefined
  try {
    const inodes = new Set()
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      for (const line of text.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 10 || c[3] !== '0A') continue
        if (parseInt(c[1].split(':')[1], 16) === port) inodes.add(c[9])
      }
    }
    if (inodes.size === 0) return undefined
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      let fds
      try { fds = fs.readdirSync(`/proc/${entry}/fd`) } catch { continue }
      for (const fd of fds) {
        let link
        try { link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`) } catch { continue }
        const m = /^socket:\[(\d+)\]$/.exec(link)
        if (m !== null && inodes.has(m[1])) return Number(entry)
      }
    }
  } catch { /* best effort */ }
  return undefined
}

/** Find a still-live app process for an instance whose wrapper just exited.
 * A forked app (spring-boot:run JVM, npm dev child) can outlive the tracked
 * wrapper; adopting it keeps the panel in sync with reality. */
function findSurvivor(inst) {
  if (isWin()) return undefined
  if (typeof inst.port === 'number' && inst.port >= 1) {
    const holder = findPortPid(inst.port)
    if (holder !== undefined && holder !== inst.pid) {
      try { process.kill(holder, 0); return holder } catch { /* not alive */ }
    }
  }
  const map = scanProcCwds()
  for (const pid of map.get(path.resolve(inst.cwd)) ?? []) {
    if (pid === inst.pid) continue
    try { process.kill(pid, 0) } catch { continue }
    if (!looksLikeApp(inst, pid)) continue
    return pid
  }
  return undefined
}

/** Heuristic: does this pid look like the application (not an editor/terminal)? */
function looksLikeApp(inst, pid) {
  let cmd
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return false }
  if (cmd.length === 0) return false
  if (inst.mainClass !== undefined && inst.mainClass.length > 0) {
    return cmd.includes(inst.mainClass) || cmd.includes(`${inst.cwd}/target`)
  }
  return cmd.includes(inst.cwd)
}

/** Resolve a bare command on PATH (used when a pinned absolute executable is absent). */
function findOnPath(command) {
  if (command.length === 0 || command.includes('/') || command.includes('\\')) return null
  const dirs = String(process.env.PATH ?? '').split(path.delimiter)
  const exts = isWin() ? ['', '.cmd', '.exe', '.bat'] : ['']
  for (const dir of dirs) {
    if (dir.length === 0) continue
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext)
      try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* next entry */ }
    }
  }
  return null
}

function checkPort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/** Strip // and block comments plus trailing commas, leaving string contents intact. */
function stripJsonc(text) {
  let out = ''
  let i = 0
  const n = text.length
  let inStr = false
  let esc = false
  while (i < n) {
    const c = text[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(n, i + 2)
      out += ' '
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') { i++; continue }
    }
    out += c
    i++
  }
  return out
}

function makeVars(root) {
  return {
    workspaceFolder: root,
    workspaceRoot: root,
    workspaceFolderBasename: path.basename(root),
    userHome: os.homedir(),
    cwd: root,
    pathSeparator: path.sep,
    '/': path.sep,
  }
}

function expandValue(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (whole, expr) => {
      if (expr.startsWith('env:')) return process.env[expr.slice(4)] ?? ''
      if (Object.prototype.hasOwnProperty.call(vars, expr)) return vars[expr]
      return whole
    })
  }
  if (Array.isArray(value)) return value.map((v) => expandValue(v, vars))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandValue(v, vars)
    return out
  }
  return value
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asArgList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.length > 0)
  if (typeof value === 'string' && value.trim().length > 0) return tokenize(value)
  return []
}

function readEnvFile(file) {
  const out = {}
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value
  }
  return out
}

/** Expanded launch-config env plus an optional envFile, resolved against cwd. */
function configEnv(raw, vars, cwd) {
  const extra = {}
  const expanded = expandValue(raw?.env ?? {}, vars)
  for (const [k, v] of Object.entries(expanded)) {
    if (typeof v === 'string') extra[k] = v
  }
  const envFile = asString(raw?.envFile)
  if (envFile.length > 0) {
    const envPath = path.isAbsolute(envFile) ? envFile : path.resolve(cwd, envFile)
    Object.assign(extra, readEnvFile(envPath))
  }
  return extra
}

/** Extract a likely server port from an explicit field or the usual CLI conventions. */
function detectPort(raw, textParts, env) {
  if (raw?.port !== undefined && raw?.port !== null && raw?.port !== '') {
    const n = Math.trunc(Number(raw.port))
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return n
  }
  const text = textParts.filter((p) => typeof p === 'string' && p.length > 0).join(' ')
  const patterns = [
    /--server\.port[= ](\d{1,5})/,
    /-Dserver\.port=(\d{1,5})/,
    /--port[= ](\d{1,5})/,
    /(?:^|\s)-p\s*(\d{1,5})(?:\s|$)/,
    /(?:^|\s)PORT=(\d{1,5})(?:\s|$)/,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m !== null) {
      const n = Number(m[1])
      if (n >= 1 && n <= 65535) return n
    }
  }
  const envPort = env?.PORT
  if (typeof envPort === 'string' && /^\d{1,5}$/.test(envPort.trim())) {
    const n = Number(envPort)
    if (n >= 1 && n <= 65535) return n
  }
  return undefined
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const mvnPath = String(config.mvnPath ?? 'mvn')
  const startTimeoutMs = clampInt(config.startTimeoutMs, 180_000, 5_000, 1_800_000)
  const nodeReadyTimeoutMs = clampInt(config.nodeReadyTimeoutMs, 20_000, 2_000, 600_000)
  const maxLogBytes = clampInt(config.maxLogBytes, 65_536, 4_096, 1_048_576)
  const mavenOpts = String(config.mavenOpts ?? '')

  let nextInstanceId = 1
  const instances = new Map() // config key -> latest instance
  const moduleCache = new Map()

  // Serialize operations on the same instance: the panel, the /launch command
  // and the launcher tool may act concurrently (restart = stop + start), and
  // interleaving them could leave an app in an inconsistent state.
  const opChains = new Map()
  function withOpLock(key, fn) {
    const prev = opChains.get(key) ?? Promise.resolve()
    const run = prev.then(() => fn())
    opChains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  // A lightweight monitor keeps "starting" instances current even after the
  // request that spawned them returned. It only reads local logs and probes
  // the configured port, so it does not touch the session log.
  const readinessTimer = setInterval(() => {
    for (const inst of instances.values()) {
      if (inst.status !== 'starting' || inst.checking) continue
      inst.checking = true
      void checkReadiness(inst).catch(() => {}).finally(() => { inst.checking = false })
    }
  }, 1_000)
  readinessTimer.unref?.()
  ctx.effect(() => () => clearInterval(readinessTimer), 'app-launcher: stop readiness monitor')

  const STATE_FILE = process.env.APP_LAUNCHER_STATE
    ?? path.join(process.env.DSH_HOME ?? os.homedir(), 'app-launcher', 'state.json')
  let state = { v: 1, files: {} }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (raw !== null && typeof raw === 'object' && raw.files !== null && typeof raw.files === 'object') {
      state = { v: 1, files: { ...raw.files } }
    }
  } catch { /* no state yet */ }

  function saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
      const tmp = `${STATE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, STATE_FILE)
    } catch { /* best effort: the launch.json remains the source of truth */ }
  }

  // Kill every tracked instance when this plugin unloads so nothing is left orphaned.
  ctx.effect(() => () => {
    for (const inst of instances.values()) {
      if (inst.status === 'starting' || inst.status === 'running') {
        inst.stopping = true
        killTree(inst.process, 'SIGTERM', true)
        setTimeout(() => killTree(inst.process, 'SIGKILL', true), 2_000).unref?.()
      }
    }
  }, 'app-launcher: terminate tracked instances on unload')

  /** Resolve the session workspace directory. */
  async function resolveWorkspace(exec) {
    if (exec !== undefined && typeof exec.workspace === 'string' && exec.workspace.length > 0) {
      return path.resolve(exec.workspace)
    }
    let base
    try {
      const wd = ctx.workingDirectory ?? ctx.get('workingDirectory')
      if (wd !== undefined && exec !== undefined && exec.agent !== undefined) {
        base = await wd.ensure(exec.agent, exec.signal)
        if (typeof base !== 'string' || base.length === 0) base = undefined
      }
    } catch { /* fall through */ }
    base ??= process.cwd()
    return path.resolve(base)
  }

  function defaultFile(root) {
    for (const rel of ['.vscode/launch.json', '.vscode/launch.jsonc', 'launch.json']) {
      const candidate = path.join(root, rel)
      if (fs.existsSync(candidate)) return candidate
    }
    return path.join(root, '.vscode', 'launch.json')
  }

  function resolveFileArg(arg, root) {
    const vars = makeVars(root)
    const expanded = expandValue(String(arg ?? '').trim(), vars)
    if (expanded.length === 0) return defaultFile(root)
    const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded)
    try {
      if (fs.statSync(resolved).isDirectory()) {
        for (const rel of ['.vscode/launch.json', '.vscode/launch.jsonc', 'launch.json']) {
          const candidate = path.join(resolved, rel)
          if (fs.existsSync(candidate)) return candidate
        }
        return path.join(resolved, '.vscode', 'launch.json')
      }
    } catch { /* not a directory: treat as a file path */ }
    return resolved
  }

  // -------------------------------------------------------- launch parsing -

  function normalizeConfig(raw, index, file, seenNames) {
    const name = asString(raw?.name) || `configuration ${index + 1}`
    const type = asString(raw?.type).toLowerCase()
    const request = asString(raw?.request) || 'launch'
    let error = null
    if (seenNames.has(name)) error = `duplicate configuration name "${name}"`
    seenNames.add(name)
    if (error === null && request !== 'launch') {
      error = `request "${request}" is not supported (only "launch")`
    }
    if (error === null && !SUPPORTED_TYPES.has(type)) {
      error = type.length === 0 ? 'missing "type"' : `type "${type}" is not supported (java, node, shell)`
    }
    return {
      raw: raw !== null && typeof raw === 'object' ? raw : {},
      index,
      name,
      type: type === 'pwa-node' ? 'node' : type,
      request,
      key: `${file}::${name}`,
      error,
    }
  }

  /** Parse one launch file; never throws for a bad file, reports through `error`. */
  function parseLaunchFile(file) {
    const dir = path.dirname(file)
    const root = path.basename(dir) === '.vscode' ? path.dirname(dir) : dir
    const result = {
      file, root, dir, exists: false, error: null, errorCode: null, version: null, configs: [], vars: makeVars(root),
    }
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      result.exists = true
    } catch (error) {
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
      result.exists = code !== 'ENOENT'
      result.errorCode = code === 'ENOENT' ? 'missing' : 'read'
      result.error = `cannot read launch file ${file}: ${error instanceof Error ? error.message : String(error)}`
      return result
    }
    let data
    try {
      data = JSON.parse(stripJsonc(raw))
    } catch (error) {
      result.exists = true
      result.errorCode = 'parse'
      result.error = `invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`
      return result
    }
    if (data === null || typeof data !== 'object' || !Array.isArray(data.configurations)) {
      result.exists = true
      result.errorCode = 'format'
      result.error = `${file} has no "configurations" array`
      return result
    }
    result.version = data.version ?? null
    const seen = new Set()
    result.configs = data.configurations.map((c, i) => normalizeConfig(c, i, file, seen))
    return result
  }

  function readPackageScripts(cwd) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
      return pkg !== null && typeof pkg === 'object' && pkg.scripts !== null && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    } catch {
      return {}
    }
  }

  /** Find the Maven module that owns the main class by looking for its source file. */
  function findMainModule(root, mainClass) {
    const cacheKey = `${root}\u0000${mainClass}`
    if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey)
    const rel = `${mainClass.replace(/\./g, '/')}.java`
    let found = null
    let visited = 0
    const queue = [{ dir: root, depth: 0 }]
    while (queue.length > 0 && visited < MODULE_SCAN_MAX_DIRS) {
      const current = queue.shift()
      visited++
      const candidate = path.join(current.dir, 'src', 'main', 'java', rel)
      if (fs.existsSync(candidate)) { found = current.dir; break }
      if (current.depth >= 8) continue
      let entries
      try { entries = fs.readdirSync(current.dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
      }
    }
    if (found !== null) moduleCache.set(cacheKey, found)
    return found
  }

  function resolveCwd(rawCwd, root, vars) {
    const value = asString(rawCwd)
    const target = value.length > 0 ? value : '${workspaceFolder}'
    const expanded = expandValue(target, vars)
    const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded)
    let stat
    try { stat = fs.statSync(resolved) } catch { throw new Error(`working directory does not exist: ${resolved}`) }
    if (!stat.isDirectory()) throw new Error(`working directory is not a directory: ${resolved}`)
    return resolved
  }

  function findExecutableInModule(moduleRoot) {
    if (isWin()) {
      const cmd = path.join(moduleRoot, 'mvnw.cmd')
      if (fs.existsSync(cmd)) return cmd
    }
    const mvnw = path.join(moduleRoot, 'mvnw')
    if (fs.existsSync(mvnw)) return mvnw
    return null
  }

  /** Turn one normalized configuration into a display description plus spawn plan. */
  function prepareConfig(conf) {
    const desc = {
      name: conf.name,
      key: conf.key,
      type: conf.type,
      request: conf.request,
      supported: conf.error === null,
      error: conf.error,
      cwd: '',
      port: null,
      mainClass: '',
      module: '',
      command: '',
      file: conf.file ?? '',
    }
    if (conf.error !== null) return { desc, plan: null }
    const raw = conf.raw
    const fileRoot = conf.fileRoot ?? process.cwd()
    const fileVars = makeVars(fileRoot)
    try {
      const cwd = resolveCwd(raw.cwd, fileRoot, fileVars)
      desc.cwd = cwd
      if (conf.type === 'java') {
        const mainClass = asString(raw.mainClass)
        if (mainClass.length === 0) throw new Error('java configuration requires "mainClass"')
        desc.mainClass = mainClass
        let moduleRoot
        const explicitModule = asString(expandValue(raw.module ?? '', fileVars))
        if (explicitModule.length > 0) {
          moduleRoot = path.isAbsolute(explicitModule) ? explicitModule : path.resolve(fileRoot, explicitModule)
        } else if (asString(raw.cwd).length > 0) {
          moduleRoot = cwd
        } else {
          moduleRoot = findMainModule(fileRoot, mainClass)
        }
        if (moduleRoot === null || moduleRoot === undefined) {
          if (fs.existsSync(path.join(cwd, 'pom.xml'))) moduleRoot = cwd
          else {
            throw new Error(
              `cannot locate ${mainClass}: no module with src/main/java/${mainClass.replace(/\./g, '/')}.java under ${fileRoot}; `
              + 'set "cwd" to the module directory or "module" to its path',
            )
          }
        }
        desc.module = moduleRoot
        desc.cwd = moduleRoot
        if (!fs.existsSync(path.join(moduleRoot, 'pom.xml'))) {
          throw new Error(`Maven module ${moduleRoot} has no pom.xml`)
        }
        const vmArgs = asString(raw.vmArgs)
        let programArgs = asArgList(raw.args).map((t) => (t.includes(' ') ? `"${t}"` : t)).join(' ')
        let detected = detectPort(raw, [programArgs, vmArgs], configEnv(raw, fileVars, moduleRoot))
        let portFromConfig = false
        if (detected === undefined) {
          const fromSpring = detectSpringPort(moduleRoot, vmArgs)
          if (fromSpring !== undefined) { detected = fromSpring; portFromConfig = true }
        }
        if (detected !== undefined) desc.port = detected
        if (detected !== undefined && !portFromConfig && !/server\.port/.test(`${programArgs} ${vmArgs}`)) {
          programArgs = [programArgs, `--server.port=${detected}`].filter(Boolean).join(' ')
        }
        const argv = ['-B', 'spring-boot:run', `-Dspring-boot.run.main-class=${mainClass}`]
        if (vmArgs.length > 0) argv.push(`-Dspring-boot.run.jvmArguments=${vmArgs}`)
        if (programArgs.length > 0 && !/spring-boot\.run\.arguments/.test(vmArgs)) {
          argv.push(`-Dspring-boot.run.arguments=${programArgs}`)
        }
        const mvnw = findExecutableInModule(moduleRoot)
        const exe = mvnw ?? mvnPath
        const env = mavenEnv(mavenOpts)
        Object.assign(env, configEnv(raw, fileVars, moduleRoot))
        desc.command = `${path.basename(exe)} ${argv.join(' ')}`
        return {
          desc,
          plan: {
            exe, argv, cwd: moduleRoot, env, port: detected ?? null,
            readiness: detected !== undefined ? 'port' : 'log', kind: 'java',
          },
        }
      }

      if (conf.type === 'node') {
        const runtimeExecutable = asString(expandValue(raw.runtimeExecutable ?? '', fileVars))
        const program = asString(expandValue(raw.program ?? '', fileVars))
        const runtimeArgs = asArgList(expandValue(raw.runtimeArgs ?? [], fileVars))
        const programArgs = asArgList(expandValue(raw.args ?? [], fileVars))
        const extraEnv = configEnv(raw, fileVars, cwd)
        const env = { ...process.env }
        for (const [k, v] of Object.entries(extraEnv)) {
          if (typeof v === 'string') env[k] = v
        }
        let exe
        let argv
        let executableNote = ''
        if (runtimeExecutable.length === 0) {
          if (program.length > 0) {
            exe = 'node'
            argv = [program, ...programArgs]
          } else {
            const scripts = readPackageScripts(cwd)
            if (typeof scripts.dev !== 'string') {
              throw new Error(`no runtimeExecutable and no "dev" script in ${path.join(cwd, 'package.json')}`)
            }
            exe = 'npm'
            argv = ['run', 'dev', ...programArgs]
          }
        } else {
          exe = runtimeExecutable
          if (!path.isAbsolute(exe) && (exe.startsWith('.') || exe.includes('/') || exe.includes('\\'))) {
            exe = path.resolve(cwd, exe)
          }
          executableNote = ''
          if (path.isAbsolute(exe) && !fs.existsSync(exe)) {
            const fallback = findOnPath(path.basename(exe))
            if (fallback === null) {
              throw new Error(`runtimeExecutable not found: ${exe} (and "${path.basename(exe)}" is not on PATH)`)
            }
            executableNote = `configured runtimeExecutable not found (${exe}); using ${fallback} from PATH`
            exe = fallback
          }
          argv = [...runtimeArgs]
          if (program.length > 0) argv.push(program)
          argv.push(...programArgs)
          const base = path.basename(exe).toLowerCase()
          if ((base === 'npm' || base === 'npm.cmd' || base === 'pnpm' || base === 'yarn') && runtimeArgs.length === 0 && program.length === 0) {
            argv = ['run', 'dev', ...argv]
          }
        }
        const detected = detectPort(raw, [programArgs.join(' '), runtimeArgs.join(' '), program], extraEnv)
        if (detected !== undefined) desc.port = detected
        desc.command = `${path.basename(exe)} ${argv.join(' ')}`.trim()
        return {
          desc,
          plan: {
            exe, argv, cwd, env, port: detected ?? null,
            readiness: detected !== undefined ? 'port' : 'log-or-alive', kind: 'node',
            ...(executableNote.length > 0 ? { note: executableNote } : {}),
          },
        }
      }

      // shell / bash
      const command = asString(expandValue(raw.command ?? raw.runtimeExecutable ?? '', fileVars))
      if (command.length === 0) throw new Error('shell configuration requires "command"')
      const extraEnv = configEnv(raw, fileVars, cwd)
      const env = { ...process.env }
      for (const [k, v] of Object.entries(extraEnv)) if (typeof v === 'string') env[k] = v
      const detected = detectPort(raw, [command, ...asArgList(raw.args).map((a) => a)], extraEnv)
      if (detected !== undefined) desc.port = detected
      desc.command = command
      const argv = isWin() ? ['/d', '/s', '/c', command] : ['-lc', command]
      const exe = isWin() ? 'cmd.exe' : '/bin/bash'
      return {
        desc,
        plan: {
          exe, argv, cwd, env, port: detected ?? null,
          readiness: detected !== undefined ? 'port' : 'log-or-alive', kind: 'shell',
        },
      }
    } catch (error) {
      desc.supported = false
      desc.error = error instanceof Error ? error.message : String(error)
      return { desc, plan: null }
    }
  }

  /** Parse a launch file and prepare every configuration for display and running. */
  function describeFile(file) {
    const parsed = parseLaunchFile(file)
    const prepared = parsed.configs.map((conf) => {
      conf.file = parsed.file
      conf.fileRoot = parsed.root
      return prepareConfig(conf)
    })
    const configs = prepared.map((p) => p.desc)
    const planByKey = new Map(prepared.filter((p) => p.plan !== null).map((p) => [p.desc.key, p.plan]))
    return { ...parsed, configs, planByKey }
  }

  function findConfig(fileState, name) {
    const exact = fileState.configs.find((c) => c.name === name)
    if (exact !== undefined) return exact
    const lower = name.toLowerCase()
    const matches = fileState.configs.filter((c) => c.name.toLowerCase() === lower)
    if (matches.length === 1) return matches[0]
    const available = fileState.configs.map((c) => c.name).join(', ') || 'none'
    if (matches.length > 1) throw new Error(`configuration name "${name}" is ambiguous; available: ${available}`)
    throw new Error(`no configuration named "${name}" in ${fileState.file}; available: ${available}`)
  }

  // ------------------------------------------------------------- instances -

  /** Read /proc for one live pid: CPU% (delta between calls) and RSS. */
  const CLK_TCK = 100
  let procChildrenCache = { at: 0, children: null }
  function getProcChildren() {
    if (Date.now() - procChildrenCache.at > 2_000) {
      const children = new Map()
      let names
      try { names = fs.readdirSync('/proc') } catch { return procChildrenCache.children }
      for (const d of names) {
        if (!/^\d+$/.test(d)) continue
        try {
          const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
          const f = st.slice(st.lastIndexOf(')') + 2).trim().split(/\s+/)
          const ppid = parseInt(f[1], 10)
          if (!children.has(ppid)) children.set(ppid, [])
          children.get(ppid).push(parseInt(d, 10))
        } catch { /* process gone */ }
      }
      procChildrenCache = { at: Date.now(), children }
    }
    return procChildrenCache.children
  }
  /** All descendants of a pid (inclusive), via /proc ppid links. */
  function treePids(rootPid) {
    const children = getProcChildren()
    if (children === null) return [rootPid]
    const out = [rootPid]
    const queue = [rootPid]
    while (queue.length > 0) {
      const kids = children.get(queue.shift()) ?? []
      for (const k of kids) { out.push(k); queue.push(k) }
    }
    return out
  }
  function readTicks(pid) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = st.slice(st.lastIndexOf(')') + 2).trim().split(/\s+/)
      return (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0)
    } catch { return null }
  }
  function readRssKb(pid) {
    try {
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))
      return m ? parseInt(m[1], 10) : 0
    } catch { return 0 }
  }
  /** Sample CPU% (summed over the instance process tree, delta between calls) and RSS. */
  function sampleProcUsage(inst) {
    if (inst.pid === null || inst.pid === undefined) return
    // A new root pid (restart or re-adoption) invalidates the previous baseline.
    if (inst.lastCpuRoot !== inst.pid) {
      inst.lastCpuRoot = inst.pid
      inst.lastCpuMap = new Map()
      delete inst.cpuPct
    }
    const pids = treePids(inst.pid)
    const ticks = new Map()
    let rss = 0
    for (const p of pids) {
      const t = readTicks(p)
      if (t !== null) ticks.set(p, t)
      rss += readRssKb(p)
    }
    if (ticks.size === 0) return
    inst.memKb = rss > 0 ? rss : (inst.memKb ?? null)
    const now = Date.now()
    const prevMap = inst.lastCpuMap
    let pct = 0
    let haveBaseline = false
    for (const [p, t] of ticks) {
      const prev = prevMap === null || prevMap === undefined ? undefined : prevMap.get(p)
      if (prev !== undefined && now - prev.at >= 500 && t >= prev.ticks) {
        pct += ((t - prev.ticks) / CLK_TCK) / ((now - prev.at) / 1000) * 100
        haveBaseline = true
      }
    }
    if (haveBaseline) inst.cpuPct = Math.min(1000, pct)
    const next = new Map()
    for (const [p, t] of ticks) next.set(p, { ticks: t, at: now })
    inst.lastCpuMap = next
  }

  function view(inst) {
    const v = {
      id: inst.id,
      key: inst.key,
      name: inst.name,
      file: inst.file,
      type: inst.type,
      status: inst.status,
      readiness: inst.readiness,
      cwd: inst.cwd,
      startedAt: inst.startedAt,
    }
    if (inst.port !== null) v.port = inst.port
    if (inst.pid !== null) v.pid = inst.pid
    if (inst.status === 'running' || inst.status === 'starting') {
      v.uptimeMs = Date.now() - inst.startedAt
      sampleProcUsage(inst)
      if (typeof inst.cpuPct === 'number') v.cpuPct = Math.round(inst.cpuPct * 10) / 10
      if (typeof inst.memKb === 'number' && inst.memKb > 0) v.memMb = Math.round(inst.memKb / 1024)
    }
    if (inst.exitCode !== null) v.exitCode = inst.exitCode
    if (inst.failReason !== null) v.failReason = inst.failReason
    return v
  }

  function active(inst) {
    return inst.status === 'starting' || inst.status === 'running'
  }

  function matchesReadyLog(kind, text) {
    const patterns = READY_PATTERNS[kind] ?? READY_PATTERNS.shell
    return patterns.some((re) => re.test(text))
  }

  /** Update one starting instance from its port or log; never spawns or kills. */
  async function checkReadiness(inst) {
    if (inst.status !== 'starting' || processExited(inst.process)) return
    const plan = inst.plan
    if (plan === undefined) return
    if (plan.port !== null) {
      const open = await checkPort(plan.port)
      if (inst.status !== 'starting' || processExited(inst.process)) return
      if (open) {
        inst.status = 'running'
        inst.readiness = 'port'
        inst.failReason = null
        return
      }
    }
    if (matchesReadyLog(plan.kind, inst.log.text())) {
      inst.status = 'running'
      inst.readiness = 'log'
      inst.failReason = null
      return
    }
    if (plan.port === null && plan.readiness === 'log-or-alive'
      && Date.now() - inst.startedAt >= NODE_ALIVE_GRACE_MS) {
      inst.status = 'running'
      inst.readiness = 'alive'
      inst.failReason = null
      return
    }
    const timeout = plan.kind === 'java' ? startTimeoutMs : nodeReadyTimeoutMs
    if (Date.now() - inst.startedAt >= timeout && inst.failReason === null) {
      inst.failReason = `did not report readiness within ${Math.round(timeout / 1000)}s; the process keeps running — check the logs or set "port"`
    }
  }

  function createInstance(desc, plan) {
    const id = `app-${nextInstanceId++}`
    const inst = {
      id,
      key: desc.key,
      name: desc.name,
      file: desc.file,
      type: desc.type,
      cwd: plan.cwd,
      port: plan.port,
      pid: null,
      process: null,
      status: 'starting',
      readiness: null,
      startedAt: Date.now(),
      exitCode: null,
      failReason: null,
      stopping: false,
      checking: false,
      plan,
      ...(desc.mainClass !== undefined ? { mainClass: desc.mainClass } : {}),
      log: makeRing(maxLogBytes),
    }
    inst.log.append(`[launcher] $ ${desc.command}\n[launcher] cwd ${plan.cwd}\n`)
    if (typeof plan.note === 'string' && plan.note.length > 0) inst.log.append(`[launcher] ${plan.note}\n`)
    inst.log.append('\n')
    let proc
    try {
      proc = spawn(plan.exe, plan.argv, {
        cwd: plan.cwd,
        env: plan.env,
        detached: !isWin(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      inst.status = 'failed'
      inst.failReason = `spawn failed: ${error instanceof Error ? error.message : String(error)}`
      instances.set(inst.key, inst)
      return inst
    }
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', (d) => inst.log.append(d))
    proc.stderr.on('data', (d) => inst.log.append(d))
    proc.once('error', (error) => {
      if (inst.status === 'starting' || inst.status === 'running') {
        inst.status = 'failed'
        inst.failReason = `process error: ${error.message}`
        inst.log.append(`\n[launcher] ${error.message}\n`)
      }
    })
    proc.once('exit', (code, signalName) => {
      inst.exitCode = code
      if (inst.stopping) {
        inst.status = 'stopped'
        inst.log.append(`\n[launcher] process stopped (code=${code} signal=${signalName ?? 'none'})\n`)
        return
      }
      if (inst.status === 'starting' || inst.status === 'running') {
        const survivor = findSurvivor(inst)
        if (survivor !== undefined) {
          inst.status = 'running'
          inst.readiness = 'adopted'
          inst.pid = survivor
          inst.failReason = null
          inst.log.append(`\n[launcher] wrapper exited (code=${code}); application still alive as pid ${survivor} — re-adopted\n`)
          return
        }
        if (code === 0) {
          inst.status = 'stopped'
          inst.log.append('\n[launcher] process exited normally\n')
        } else {
          inst.status = 'failed'
          inst.failReason = `process exited with code ${code}${signalName ? ` (signal ${signalName})` : ''}`
          inst.log.append(`\n[launcher] process exited code=${code} signal=${signalName ?? 'none'}\n`)
        }
      }
    })
    inst.pid = proc.pid ?? null
    inst.process = proc
    instances.set(inst.key, inst)
    // Bound the tracker: evict the oldest instance that is no longer live.
    if (instances.size > MAX_TRACKED) {
      for (const [oldKey, old] of instances) {
        if (active(old)) continue
        instances.delete(oldKey)
        break
      }
    }
    return inst
  }

  async function stopInstance(inst) {
    return withOpLock(inst.key, () => stopInstanceInner(inst))
  }

  async function stopInstanceInner(inst) {
    if (!active(inst)) {
      return { stopped: true, method: 'none', tookMs: 0, message: `"${inst.name}" is already ${inst.status}` }
    }
    const before = Date.now()
    inst.stopping = true
    killTree(inst.process, 'SIGTERM', true)
    let waited = 0
    while (!processExited(inst.process) && waited < STOP_GRACE_MS) {
      await sleep(200)
      waited += 200
    }
    let method = 'SIGTERM'
    if (!processExited(inst.process)) {
      method = 'SIGKILL'
      killTree(inst.process, 'SIGKILL', true)
      await sleep(500)
    }
    inst.status = 'stopped'
    // The wrapper can exit before its child releases the port; callers use
    // stop() as a barrier, so wait briefly for the port to close.
    if (inst.port !== null) {
      const portDeadline = Date.now() + 4_000
      while (Date.now() < portDeadline && await checkPort(inst.port, 300)) {
        await sleep(200)
      }
    }
    // A forked app process can outlive the wrapper (e.g. the JVM behind
    // "mvn spring-boot:run"). Make sure nothing app-like is left in the
    // working directory or holding the port.
    const leftovers = []
    const seen = new Set()
    for (const pid of scanProcCwds().get(path.resolve(inst.cwd)) ?? []) {
      if (pid === inst.pid || seen.has(pid)) continue
      seen.add(pid)
      try { process.kill(pid, 0) } catch { continue }
      if (!looksLikeApp(inst, pid)) continue
      leftovers.push(pid)
    }
    if (inst.port !== null && (await checkPort(inst.port, 300))) {
      const holder = findPortPid(inst.port)
      if (holder !== undefined && !seen.has(holder)) leftovers.push(holder)
    }
    if (leftovers.length > 0) {
      for (const pid of leftovers) {
        try { process.kill(-pid, 'SIGTERM') } catch {
          try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
        }
      }
      let waited = 0
      while (leftovers.some((pid) => { try { process.kill(pid, 0); return true } catch { return false } }) && waited < 3_000) {
        await sleep(200)
        waited += 200
      }
      for (const pid of leftovers) {
        try { process.kill(pid, 0) } catch { continue }
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
        }
      }
      method += ' (+leftover)'
      inst.log.append(`\n[launcher] stopped leftover process(es): ${leftovers.join(', ')}\n`)
    }
    return { stopped: true, method, tookMs: Date.now() - before, message: `"${inst.name}" stopped` }
  }

  /** Start one prepared configuration; wait for readiness unless opts.wait is false. */
  async function startPrepared(desc, plan, exec, opts = {}) {
    return withOpLock(desc.key, () => startPreparedInner(desc, plan, exec, opts))
  }

  async function startPreparedInner(desc, plan, exec, opts = {}) {
    const existing = instances.get(desc.key)
    if (existing !== undefined && active(existing)) {
      return {
        action: 'start',
        ok: true,
        instance: view(existing),
        message: `"${desc.name}" is already ${existing.status}`,
      }
    }
    if (plan.port !== null) {
      for (const other of instances.values()) {
        if (other.key !== desc.key && active(other) && other.port === plan.port) {
          throw new Error(`port ${plan.port} is already used by "${other.name}"; stop it first or choose another port`)
        }
      }
    }
    if (plan.port !== null && await checkPort(plan.port)) {
      const holder = findPortPid(plan.port)
      throw new Error(`port ${plan.port} is already in use${holder !== undefined ? ` (pid ${holder})` : ''}; stop the process using it or change "port"`)
    }
    const inst = createInstance(desc, plan)
    if (inst.status === 'failed') {
      return { action: 'start', ok: false, instance: view(inst), logs: inst.log.tail(4000), message: inst.failReason ?? 'start failed' }
    }
    // The panel asks for a non-blocking start and then polls overview; the
    // monitor above marks the instance running when readiness arrives.
    if (opts.wait === false) {
      return {
        action: 'start',
        ok: true,
        instance: view(inst),
        logs: inst.log.tail(4000),
        message: `"${desc.name}" is starting (pid ${inst.pid})`,
      }
    }
    const timeout = plan.kind === 'java' ? startTimeoutMs : nodeReadyTimeoutMs
    const deadline = Date.now() + timeout
    let aborted = false
    while (Date.now() < deadline) {
      if (inst.status === 'failed' || inst.status === 'stopped') break
      if (processExited(inst.process)) break
      if (plan.port !== null && await checkPort(plan.port)) {
        inst.status = 'running'
        inst.readiness = 'port'
        inst.failReason = null
        break
      }
      if (matchesReadyLog(plan.kind, inst.log.text())) {
        inst.status = 'running'
        inst.readiness = 'log'
        inst.failReason = null
        break
      }
      if (plan.port === null && plan.readiness === 'log-or-alive'
        && Date.now() - inst.startedAt >= NODE_ALIVE_GRACE_MS) {
        inst.status = 'running'
        inst.readiness = 'alive'
        inst.failReason = null
        break
      }
      if (exec?.signal?.aborted) { aborted = true; break }
      await sleep(PORT_POLL_MS, exec?.signal)
      if (exec?.signal?.aborted) { aborted = true; break }
    }
    if (inst.status === 'running') {
      const where = plan.port !== null ? ` on port ${plan.port}` : ''
      return {
        action: 'start',
        ok: true,
        instance: view(inst),
        logs: inst.log.tail(4000),
        message: `"${desc.name}" is running${where} (pid ${inst.pid})`,
      }
    }
    if (aborted) {
      return {
        action: 'start',
        ok: false,
        instance: view(inst),
        logs: inst.log.tail(4000),
        message: `start wait aborted after ${Math.round((Date.now() - inst.startedAt) / 1000)}s; "${desc.name}" keeps running — use action=logs or action=stop`,
      }
    }
    if (inst.status === 'failed' || inst.status === 'stopped') {
      return {
        action: 'start',
        ok: false,
        instance: view(inst),
        logs: inst.log.tail(4000),
        message: inst.failReason ?? `"${desc.name}" exited before it became ready`,
      }
    }
    inst.failReason = `did not report readiness within ${Math.round(timeout / 1000)}s; the process keeps running — check the logs, or set "port"`
    return {
      action: 'start',
      ok: false,
      instance: view(inst),
      logs: inst.log.tail(4000),
      message: `"${desc.name}" ${inst.failReason}`,
    }
  }

  // --------------------------------------------------------------- overview -

  async function overview(args, exec) {
    const workspace = await resolveWorkspace(exec)
    const requested = asString(args?.file)
    const selected = requested.length > 0
      ? resolveFileArg(requested, workspace)
      : (typeof state.files[workspace] === 'string' ? state.files[workspace] : defaultFile(workspace))
    const file = resolveFileArg(selected, workspace)
    const described = describeFile(file)
    const configs = described.configs.map((c) => ({ ...c }))
    {
      // Surface processes that were started outside the panel (or survived a
      // host restart): they own the configuration's working directory, so the
      // row can report and stop them.
      const cwdPids = scanProcCwds()
      if (cwdPids.size > 0) {
        for (const c of configs) {
          if (!c.supported || typeof c.cwd !== 'string' || c.cwd.length === 0) continue
          const tracked = instances.get(c.key)
          if (tracked !== undefined && active(tracked)) continue
          const pids = cwdPids.get(path.resolve(c.cwd))
          if (pids === undefined || pids.length === 0) continue
          c.external = { pids: pids.slice(0, 8) }
        }
      }
    }
    return {
      workspace,
      file: described.file,
      root: described.root,
      exists: described.exists,
      error: described.error,
      errorCode: described.errorCode,
      version: described.version,
      configs,
      instances: [...instances.values()].filter((i) => i.file === described.file).map(view),
    }
  }

  /** The launch file selected for a workspace (persisted by /launch use and the panel). */
  function selectedFileFor(workspace) {
    return resolveFileArg(typeof state.files[workspace] === 'string' ? state.files[workspace] : '', workspace)
  }

  function preparedFor(fileState, name) {
    const desc = findConfig(fileState, name)
    if (!desc.supported) throw new Error(`"${desc.name}" cannot start: ${desc.error}`)
    const plan = fileState.planByKey.get(desc.key)
    if (plan === undefined) throw new Error(`"${desc.name}" has no spawn plan`)
    return { desc, plan }
  }

  async function startByName(name, args, exec, opts = {}) {
    const workspace = await resolveWorkspace(exec)
    const file = args?.file !== undefined && asString(args.file).length > 0
      ? resolveFileArg(args.file, workspace)
      : resolveFileArg(typeof state.files[workspace] === 'string' ? state.files[workspace] : '', workspace)
    const fileState = describeFile(file)
    if (fileState.error !== null) throw new Error(fileState.error)
    const { desc, plan } = preparedFor(fileState, name)
    const result = await startPrepared(desc, plan, exec, opts)
    return { ...result, file }
  }

  function instanceByName(name, file) {
    for (const inst of instances.values()) {
      if (file !== undefined && inst.file !== path.resolve(file)) continue
      if (inst.name === name) return inst
    }
    return undefined
  }

  // ---------------------------------------------------------------- command -

  const USAGE = 'usage: /launch overview [file] | use <file> | start <name> [--no-wait] | stop <name|all> | restart <name> [--no-wait] | logs <name> [lines]'
  const commandOk = (payload) => ({ kind: 'success', text: JSON.stringify({ v: 1, ...payload }) })
  const commandFail = (message) => ({ kind: 'error', text: message })

  const launchCommand = {
    definitionId: '@local/app-launcher',
    name: 'launch',
    description: 'Manage applications declared in a VS Code launch.json: list, start, stop, restart, logs, choose file.',
    input: { hint: '[overview [file]|use <file>|start <name>|stop <name|all>|restart <name>|logs <name> [lines]]' },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        const exec = { agent, signal }
        const workspace = await resolveWorkspace(exec)
        const tokens = tokenize(rawInput)
        const sub = tokens[0] ?? 'overview'
        if (sub === 'overview' || sub === 'list' || sub === 'status') {
          const fileArg = tokens.slice(1).join(' ')
          const data = await overview({ file: fileArg }, exec)
          return commandOk({ op: 'overview', ...data })
        }
        if (sub === 'use') {
          const fileArg = tokens.slice(1).join(' ')
          if (fileArg.length === 0) return commandFail(USAGE)
          const file = resolveFileArg(fileArg, workspace)
          const fileState = describeFile(file)
          state.files[workspace] = file
          saveState()
          const data = await overview({ file }, exec)
          return commandOk({ op: 'use', ...data })
        }
        if (sub === 'start') {
          const raw = tokens.slice(1)
          const noWait = raw.includes('--no-wait')
          const name = raw.filter((tok) => tok !== '--no-wait').join(' ')
          if (name.length === 0) return commandFail(USAGE)
          const r = await startByName(name, {}, exec, { wait: !noWait })
          return commandOk({ op: 'start', ...r, ...(noWait ? { pending: true } : {}) })
        }
        if (sub === 'stop') {
          const name = tokens.slice(1).join(' ')
          if (name === 'all' || name === '*') {
            const root = await resolveWorkspace(exec)
            const selected = resolveFileArg(typeof state.files[root] === 'string' ? state.files[root] : '', root)
            const stopped = []
            for (const inst of [...instances.values()]) {
              if (inst.file !== selected || !active(inst)) continue
              const r = await stopInstance(inst)
              stopped.push({ instance: view(inst), message: r.message })
            }
            return commandOk({ op: 'stop-all', ok: true, stopped, instances: [...instances.values()].filter((i) => i.file === selected).map(view) })
          }
          if (name.length === 0) {
            let live = [...instances.values()].filter(active)
            if (live.length !== 1) return commandFail('pass a configuration name, or "all" to stop every running application')
            const r = await stopInstance(live[0])
            return commandOk({ op: 'stop', ok: true, instance: view(live[0]), message: r.message })
          }
          const selected = resolveFileArg(typeof state.files[workspace] === 'string' ? state.files[workspace] : '', workspace)
          const inst = instanceByName(name, selected) ?? instanceByName(name)
          if (inst === undefined) return commandFail(`"${name}" is not running; start it first`)
          const r = await stopInstance(inst)
          return commandOk({ op: 'stop', ok: true, instance: view(inst), message: r.message })
        }
        if (sub === 'restart') {
          const raw = tokens.slice(1)
          const noWait = raw.includes('--no-wait')
          const name = raw.filter((tok) => tok !== '--no-wait').join(' ')
          if (name.length === 0) return commandFail(USAGE)
          const root = await resolveWorkspace(exec)
          const file = resolveFileArg(typeof state.files[root] === 'string' ? state.files[root] : '', root)
          const fileState = describeFile(file)
          if (fileState.error !== null) throw new Error(fileState.error)
          const { desc, plan } = preparedFor(fileState, name)
          const inst = instances.get(desc.key)
          if (inst !== undefined && active(inst)) await stopInstance(inst)
          const r = await startPrepared(desc, plan, exec, { wait: !noWait })
          return commandOk({ op: 'restart', ...r, action: 'restart', ...(noWait ? { pending: true } : {}) })
        }
        if (sub === 'logs') {
          const rest = tokens.slice(1)
          let lines = 100
          if (rest.length > 0 && /^\d+$/.test(rest[rest.length - 1])) {
            lines = clampInt(rest.pop(), 100, 1, 500)
          }
          const name = rest.join(' ')
          if (name.length === 0) return commandFail(USAGE)
          const root = await resolveWorkspace(exec)
          const file = resolveFileArg(typeof state.files[root] === 'string' ? state.files[root] : '', root)
          const inst = instanceByName(name, file)
          if (inst === undefined) return commandFail(`no instance tracked for "${name}"; start it first`)
          const payload = { op: 'logs', ok: true, instance: view(inst), lines: inst.log.tailLines(lines) }
          if (inst.log.dropped > 0) payload.message = `earlier output older than the retained ${maxLogBytes} bytes was dropped`
          return commandOk(payload)
        }
        return commandFail(USAGE)
      } catch (error) {
        return commandFail(error instanceof Error ? error.message : String(error))
      }
    },
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register(launchCommand)
    })
  }

  // ------------------------------------------------------------------ tool -

  const configSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      key: { type: 'string' },
      file: { type: 'string' },
      type: { type: 'string' },
      request: { type: 'string' },
      supported: { type: 'boolean' },
      error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      cwd: { type: 'string' },
      port: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      mainClass: { type: 'string' },
      module: { type: 'string' },
      command: { type: 'string' },
    },
    required: ['name', 'key', 'type', 'supported'],
  }

  const instanceSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      key: { type: 'string' },
      name: { type: 'string' },
      file: { type: 'string' },
      type: { type: 'string' },
      status: { type: 'string', enum: ['starting', 'running', 'stopped', 'failed'] },
      readiness: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      cwd: { type: 'string' },
      startedAt: { type: 'integer' },
      uptimeMs: { type: 'integer' },
      port: { type: 'integer' },
      pid: { type: 'integer' },
      exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      failReason: { type: 'string' },
    },
    required: ['id', 'key', 'name', 'file', 'type', 'status', 'startedAt'],
  }

  const launcherOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'logs', 'stopAll'] },
      ok: { type: 'boolean' },
      workspace: { type: 'string' },
      file: { type: 'string' },
      exists: { type: 'boolean' },
      error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      errorCode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      configs: { type: 'array', items: configSchema },
      instance: instanceSchema,
      instances: { type: 'array', items: instanceSchema },
      logs: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['action', 'ok'],
  }

  const launcherTool = {
    name: 'launcher',
    description:
      'Manage applications declared in a VS Code launch.json: list configurations, start/stop/restart them, and read logs. '
      + 'Configurations whose process is running outside the panel (e.g. started from an IDE or a previous host run) appear with an "external" pid list in action=list; '
      + 'stop them with action=stopExternal. '
      + 'Java configurations run through "mvn spring-boot:run" in the module that owns mainClass; node configurations run '
      + 'runtimeExecutable/runtimeArgs (for example npm run dev); shell configurations run a command string. '
      + 'Configurations may use ${workspaceFolder}, ${env:NAME} and ${userHome} placeholders.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'start', 'stop', 'restart', 'logs', 'stopAll', 'stopExternal'], description: 'Operation to perform. stopExternal stops a configuration whose process was started outside the panel (pass the pids reported by list).' },
        config: { type: 'string', description: 'Configuration name from launch.json (required for start, stop, restart, logs).' },
        file: { type: 'string', description: 'launch.json path (absolute, or relative to the session working directory). Defaults to .vscode/launch.json in the session working directory.' },
        lines: { type: 'integer', description: 'Log tail lines for action=logs. Defaults to 100 and is capped at 500.' },
        pids: { type: 'array', items: { type: 'integer' }, description: 'Process ids for action=stopExternal, as reported by the "external" field of action=list.' },
      },
      required: ['action'],
    },
    output: {
      schema: launcherOutputSchema,
      render(_args, v) {
        const lines = []
        if (Array.isArray(v.configs) && v.configs.length > 0) {
          lines.push(`[launcher] ${v.file} (${v.configs.length} configuration(s))`)
          for (const c of v.configs) {
            const state = (v.instances ?? []).find((i) => i.key === c.key)
            const mark = state !== undefined ? state.status : (c.external !== undefined ? 'external' : 'stopped')
            const extra = c.error !== null && c.error !== undefined ? `  ${c.error}`
              : c.external !== undefined ? `  external(pids ${c.external.pids.join(',')})`
                : (c.port !== null && c.port !== undefined ? `  :${c.port}` : '')
            lines.push(`  ${mark.padEnd(8)} ${c.name}  [${c.type}]${extra}`)
          }
        }
        if (v.instance !== undefined) {
          const i = v.instance
          lines.push(`[launcher] ${i.name} ${i.status}${i.port !== undefined ? ` port ${i.port}` : ''}${i.pid !== undefined ? ` pid ${i.pid}` : ''}`)
        }
        if (Array.isArray(v.instances) && v.configs === undefined) {
          for (const i of v.instances) {
            lines.push(`  ${i.name} ${i.status}${i.port !== undefined ? ` :${i.port}` : ''}${i.pid !== undefined ? ` pid ${i.pid}` : ''}`)
          }
        }
        if (typeof v.message === 'string' && v.message.length > 0) lines.push(v.message)
        if (typeof v.logs === 'string' && v.logs.length > 0) lines.push('', '--- logs (tail) ---', v.logs)
        return [{ type: 'text', text: lines.join('\n') || `[launcher] ${v.action}` }]
      },
    },
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'logs',
    async execute(args, exec) {
      const action = args.action
      if (action === 'list') {
        const data = await overview({ file: args.file }, exec)
        return {
          action,
          ok: data.error === null,
          workspace: data.workspace,
          file: data.file,
          exists: data.exists,
          error: data.error,
          errorCode: data.errorCode,
          configs: data.configs,
          instances: data.instances,
          ...(data.error !== null ? { message: data.error } : {}),
        }
      }
      if (action === 'start') {
        const name = asString(args.config)
        if (name.length === 0) throw new Error('launcher: config is required for action=start')
        return { action, ...(await startByName(name, { file: args.file }, exec)) }
      }
      if (action === 'stopExternal') {
        const name = asString(args.config)
        if (name.length === 0) throw new Error('launcher: config is required for action=stopExternal')
        const workspace = await resolveWorkspace(exec)
        const file = args.file !== undefined && asString(args.file).length > 0
          ? resolveFileArg(args.file, workspace)
          : resolveFileArg(typeof state.files[workspace] === 'string' ? state.files[workspace] : '', workspace)
        return stopExternalConfig(name, file, args.pids)
      }
      if (action === 'stop' || action === 'restart') {
        const name = asString(args.config)
        if (name.length === 0) throw new Error(`launcher: config is required for action=${action}`)
        if (action === 'restart') {
          const workspace = await resolveWorkspace(exec)
          const file = args.file !== undefined && asString(args.file).length > 0
            ? resolveFileArg(args.file, workspace)
            : resolveFileArg(typeof state.files[workspace] === 'string' ? state.files[workspace] : '', workspace)
          const fileState = describeFile(file)
          if (fileState.error !== null) throw new Error(fileState.error)
          const { desc, plan } = preparedFor(fileState, name)
          const inst = instances.get(desc.key)
          if (inst !== undefined && active(inst)) await stopInstance(inst)
          return { ...(await startPrepared(desc, plan, exec)), action: 'restart' }
        }
        const workspace = await resolveWorkspace(exec)
        const file = args.file !== undefined && asString(args.file).length > 0 ? resolveFileArg(args.file, workspace) : undefined
        const inst = instanceByName(name, file)
        if (inst === undefined) return { action, ok: false, message: `"${name}" is not tracked; start it first` }
        const r = await stopInstance(inst)
        return { action, ok: true, instance: view(inst), message: r.message }
      }
      if (action === 'logs') {
        const name = asString(args.config)
        if (name.length === 0) throw new Error('launcher: config is required for action=logs')
        const workspace = await resolveWorkspace(exec)
        const file = args.file !== undefined && asString(args.file).length > 0 ? resolveFileArg(args.file, workspace) : undefined
        const inst = instanceByName(name, file)
        if (inst === undefined) return { action, ok: false, message: `no instance tracked for "${name}"; start it first` }
        const lines = clampInt(args.lines, 100, 1, 500)
        const payload = { action, ok: true, instance: view(inst), logs: inst.log.tailLines(lines) }
        if (inst.log.dropped > 0) payload.message = `earlier output older than the retained ${maxLogBytes} bytes was dropped`
        return payload
      }
      if (action === 'stopAll') {
        const workspace = await resolveWorkspace(exec)
        const file = args.file !== undefined && asString(args.file).length > 0
          ? resolveFileArg(args.file, workspace)
          : (typeof state.files[workspace] === 'string' ? state.files[workspace] : undefined)
        const stopped = []
        for (const inst of [...instances.values()]) {
          if (!active(inst)) continue
          if (file !== undefined && inst.file !== path.resolve(file)) continue
          const r = await stopInstance(inst)
          stopped.push({ instance: view(inst), message: r.message })
        }
        return {
          action,
          ok: true,
          instances: stopped.map((s) => s.instance),
          message: stopped.length === 0 ? 'no running application to stop' : stopped.map((s) => s.message).join('; '),
        }
      }
      throw new Error(`launcher: unknown action ${String(action)}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `launcher ${args.action}${typeof args.config === 'string' && args.config.length > 0 ? ` · ${args.config}` : ''}`,
      kind: 'execute',
    }),
    presentResult: (args, result) => {
      if (typeof result !== 'object' || result === null) return undefined
      return {
        card: 'generic',
        title: result.ok ? `launcher ${args.action} ok` : `launcher ${args.action} failed`,
        ...(typeof result.message === 'string' ? { content: [{ type: 'text', text: result.message }] } : {}),
      }
    },
  }

  ctx.tools.register(launcherTool)

  /** Stop processes that own a configuration's working directory but were
   * started outside the panel (or survived a host restart). */
  async function stopExternalConfig(name, file, wantedPids) {
    const fileState = describeFile(file)
    if (fileState.error !== null) throw new Error(fileState.error)
    const { desc } = preparedFor(fileState, name)
    return withOpLock(desc.key, () => stopExternalConfigInner(desc, name, wantedPids))
  }

  async function stopExternalConfigInner(desc, name, wantedPids) {
    if (typeof desc.cwd !== 'string' || desc.cwd.length === 0) throw new Error('configuration has no working directory')
    const wanted = (Array.isArray(wantedPids) ? wantedPids : []).map((x) => clampInt(x, 0, 1, 2 ** 31 - 1)).filter((x) => x > 0)
    if (wanted.length === 0) throw new Error('no process to stop')
    const expected = path.resolve(desc.cwd)
    const live = []
    for (const pid of [...new Set(wanted)]) {
      let cwd
      try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`) } catch { continue }
      if (cwd !== expected) continue
      try { process.kill(pid, 0) } catch { continue }
      live.push({ pid })
    }
    if (live.length === 0) throw new Error(`no running process matching "${name}" (pids already exited?)`)
    for (const entry of live) {
      try { process.kill(-entry.pid, 'SIGTERM') } catch {
        try { process.kill(entry.pid, 'SIGTERM') } catch { /* already gone */ }
      }
    }
    let waited = 0
    const anyAlive = () => live.some((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } })
    while (anyAlive() && waited < 5_000) { await sleep(200); waited += 200 }
    for (const entry of live) {
      try { process.kill(entry.pid, 0) } catch { continue }
      try { process.kill(-entry.pid, 'SIGKILL') } catch {
        try { process.kill(entry.pid, 'SIGKILL') } catch { /* already gone */ }
      }
    }
    if (live.some((entry) => { try { process.kill(entry.pid, 0); return true } catch { return false } })) await sleep(300)
    const port = typeof desc.port === 'number' ? desc.port : null
    if (port !== null) {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline && await checkPort(port, 300)) await sleep(200)
    }
    return {
      action: 'stop',
      ok: true,
      instance: { name, status: 'stopped' },
      message: `"${name}" stopped (${live.map((entry) => entry.pid).join(', ')})`,
    }
  }

  // ------------------------------------------------------- panel HTTP API ---
  //
  // The sidebar panel must not turn each status refresh into a slash-command
  // record: commands are durable, user-visible Chat rows. This same-origin
  // route performs the panel's reads and actions without appending Session
  // events. It speaks for one live Session, resolved to its working directory,
  // and is guarded against cross-site calls by a custom header plus a JSON
  // content type (both trigger a cross-origin preflight that this route
  // refuses). The /launch command remains the explicit chat/agent surface.

  function readApiBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 256 * 1024) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      req.on('error', reject)
    })
  }

  async function handleApi(req, res, sessionStore) {
    const send = (status, payload) => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    try {
      if (req.method !== 'POST') return send(405, { ok: false, error: { message: 'POST required' } })
      if (req.headers['x-app-launcher'] !== '1') return send(403, { ok: false, error: { message: 'forbidden' } })
      if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
        return send(415, { ok: false, error: { message: 'application/json required' } })
      }
      const body = await readApiBody(req)
      const sessionId = asString(body.sessionId)
      const session = sessionId.length > 0 && sessionStore !== undefined ? sessionStore.get(sessionId) : undefined
      if (session === undefined) {
        return send(400, { ok: false, error: { message: 'unknown or inactive session' } })
      }
      const wd = ctx.workingDirectory ?? ctx.get('workingDirectory')
      const workspace = path.resolve(wd !== undefined ? wd.get(session) : process.cwd())
      const exec = { workspace }
      const op = asString(body.op)
      let value
      if (op === 'overview') {
        value = await overview({}, exec)
      } else if (op === 'use') {
        const file = resolveFileArg(body.file, workspace)
        state.files[workspace] = file
        saveState()
        value = await overview({ file }, exec)
      } else if (op === 'start') {
        const file = selectedFileFor(workspace)
        const fileState = describeFile(file)
        if (fileState.error !== null) throw new Error(fileState.error)
        const { desc, plan } = preparedFor(fileState, asString(body.name))
        const result = await startPrepared(desc, plan, exec, { wait: false })
        value = { ...result, file }
      } else if (op === 'stop') {
        const name = asString(body.name)
        const file = selectedFileFor(workspace)
        const inst = instanceByName(name, file) ?? instanceByName(name)
        if (inst === undefined) throw new Error(`"${name}" is not running; start it first`)
        const result = await stopInstance(inst)
        value = { action: 'stop', ok: true, instance: view(inst), message: result.message }
      } else if (op === 'restart') {
        const file = selectedFileFor(workspace)
        const fileState = describeFile(file)
        if (fileState.error !== null) throw new Error(fileState.error)
        const { desc, plan } = preparedFor(fileState, asString(body.name))
        const inst = instances.get(desc.key)
        if (inst !== undefined && active(inst)) await stopInstance(inst)
        value = { ...(await startPrepared(desc, plan, exec, { wait: false })), action: 'restart' }
      } else if (op === 'logs') {
        const name = asString(body.name)
        const file = selectedFileFor(workspace)
        const inst = instanceByName(name, file) ?? instanceByName(name)
        if (inst === undefined) throw new Error(`no instance tracked for "${name}"; start it first`)
        const lines = clampInt(body.lines, 150, 1, 500)
        value = { action: 'logs', ok: true, instance: view(inst), lines: inst.log.tailLines(lines) }
        if (inst.log.dropped > 0) value.message = `earlier output older than the retained ${maxLogBytes} bytes was dropped`
      } else if (op === 'stopExternal') {
        value = await stopExternalConfig(asString(body.name), selectedFileFor(workspace), body.pids)
      } else if (op === 'stopAll') {
        const file = selectedFileFor(workspace)
        const stopped = []
        for (const inst of [...instances.values()]) {
          if (!active(inst) || inst.file !== file) continue
          const result = await stopInstance(inst)
          stopped.push({ instance: view(inst), message: result.message })
        }
        value = {
          action: 'stopAll',
          ok: true,
          instances: stopped.map((entry) => entry.instance),
          message: stopped.length === 0 ? 'no running application to stop' : stopped.map((entry) => entry.message).join('; '),
        }
      } else {
        throw new Error(`unknown op "${op}"`)
      }
      send(200, { ok: true, value })
    } catch (error) {
      send(400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } })
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'sessions'], (webCtx) => {
      const server = webCtx.webServer ?? webCtx.get('webServer')
      const sessions = webCtx.sessions ?? webCtx.get('sessions')
      if (server === undefined) return
      webCtx.effect(() => server.register({
        kind: 'exact',
        path: '/app-launcher/api',
        handler: (req, res) => handleApi(req, res, sessions),
      }), 'app-launcher: panel HTTP API')
    })
  }
}
