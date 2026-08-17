// scripts/launch.mjs — 一键启动：检查 key → 缺失则提示输入 → 启动 API + Web → 打开浏览器
//
// 用法：
//   node scripts/launch.mjs                 # 检查后启动
//   node scripts/launch.mjs --no-open       # 启动后不打开浏览器
//   node scripts/launch.mjs --reset         # 重新走 key 询问流程（即便 .env 已有值）
//   node scripts/launch.mjs --port 5174     # 自定义后端端口（默认 5174）
//
// 设计：
//   - 同时查 .env + .model-settings.json（运行时配置）；任一存在即视为已配
//   - 缺失时交互式读取输入，掩码回显，写入 .env（保留其他字段和注释）
//   - 依赖检测：若 node_modules / frontend/node_modules 缺失则自动 npm install
//   - Node 版本检查：需要 22.13+（内置 node:sqlite，无需编译）
//   - 启动后用 /api/health 探活，再 spawn dev.mjs
//   - Ctrl-C 时优雅关闭所有子进程

import { spawn, execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import process from 'node:process'

// ---------- ANSI colors ----------
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}
const tag = (label, color) => `${color}[${label}]${c.reset}`

const log = (msg) => console.log(msg)
const info = (msg) => log(`${c.cyan}[launch]${c.reset} ${msg}`)
const warn = (msg) => log(`${c.yellow}[launch]${c.reset} ${msg}`)
const err = (msg) => log(`${c.red}[launch]${c.reset} ${msg}`)
const ok = (msg) => log(`${c.green}[launch]${c.reset} ${msg}`)

// ---------- CLI args ----------
const args = process.argv.slice(2)
const flags = {
  noOpen: args.includes('--no-open'),
  reset: args.includes('--reset'),
  port: (() => {
    const i = args.indexOf('--port')
    return i > -1 && args[i + 1] ? Number(args[i + 1]) : 5174
  })(),
}

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = resolve(__dirname, '..')
const envPath = join(projectRoot, '.env')
const envExamplePath = join(projectRoot, '.env.example')
const runtimePath = join(projectRoot, '.model-settings.json')
const webPort = 5173

// ---------- .env parser/writer ----------
/**
 * Parse a .env file into a Map<key, { value, raw }>. Keeps comments and
 * blank lines so we can rewrite without destroying the file.
 */
function parseEnvFile(path) {
  const entries = new Map() // key -> { value, comment, line }
  const lines = []
  if (!existsSync(path)) return { entries, lines }
  const content = readFileSync(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    lines.push(line)
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) {
      const key = m[1]
      let value = m[2]
      // strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      entries.set(key, { value, line })
    }
  }
  return { entries, lines }
}

function setEnvKey(entries, key, value) {
  entries.set(key, { value, line: `${key}=${value}` })
}

function writeEnvFile(path, entries, originalLines) {
  // Rewrite preserving original line order where possible, then append new keys
  const seen = new Set()
  const out = []
  for (const line of originalLines) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/)
    if (m) {
      const e = entries.get(m[1])
      if (e) {
        out.push(e.line)
        seen.add(m[1])
      } else {
        out.push(line)
      }
    } else {
      out.push(line)
    }
  }
  // Append any new keys
  for (const [key, e] of entries) {
    if (!seen.has(key)) {
      out.push(e.line)
    }
  }
  writeFileSync(path, out.join('\n') + '\n', 'utf8')
}

// ---------- Read keys from .env and .model-settings.json ----------
function readEnvKeys() {
  const { entries } = parseEnvFile(envPath)
  return {
    mimo: entries.get('MIMO_API_KEY')?.value || '',
    deepseek: entries.get('DEEPSEEK_API_KEY')?.value || '',
  }
}

function readRuntimeKeys() {
  if (!existsSync(runtimePath)) return { mimo: '', deepseek: '' }
  try {
    const data = JSON.parse(readFileSync(runtimePath, 'utf8'))
    return {
      mimo: data.mimoApiKey || '',
      deepseek: data.deepseekApiKey || '',
    }
  } catch {
    return { mimo: '', deepseek: '' }
  }
}

function isRealKey(value) {
  if (!value) return false
  const v = value.trim()
  if (v.length < 8) return false
  if (v.includes('REPLACE_ME')) return false
  return true
}

// ---------- Interactive prompt with masked input ----------
//
// We use readline.question() in all cases. When stdin is a TTY, the
// `terminal: true` flag makes readline support raw keystroke handling
// and we'll wrap it with a mute listener to display '*' instead of the
// typed characters. When stdin is NOT a TTY (piped input, CI, etc.),
// we use the same API but with `terminal: false` and read plain text.
//
// In non-TTY mode the first call drains the rest of stdin into a
// buffer so multiple prompts can sequentially read piped input like
//   printf 'a\nb\n' | node launch.mjs

const stdinBuffer = { lines: [], drained: false }
function drainStdin() {
  if (stdinBuffer.drained) return Promise.resolve()
  stdinBuffer.drained = true
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
      crlfDelay: Infinity,
    })
    rl.on('line', (line) => stdinBuffer.lines.push(line))
    rl.on('close', () => resolve())
  })
}

async function promptMasked(question) {
  const isTTY = !!process.stdin.isTTY
  if (!isTTY) {
    // Non-TTY (piped / CI): drain all of stdin up front so we can
    // sequentially read from the buffer across multiple prompts.
    await drainStdin()
    const value = stdinBuffer.lines.shift() ?? ''
    process.stdout.write(question)
    // No echo of the value — piping a key into the terminal has no
    // visual feedback in the first place, and re-printing 50 asterisks
    // here just clutters the screen. The ✓ preview after Enter is the
    // real confirmation.
    return value
  }
  // TTY: use readline in terminal mode. We intercept the output so that
  // * per-character typing is masked (standard behavior), but
  // * a paste (multiple chars arriving in one chunk) is shown ONCE
  //   as a length hint, not as 50 individual asterisks.
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    })
    const realWrite = rl._writeToOutput.bind(rl)
    let pasteHintShown = false
    rl._writeToOutput = (s) => {
      // Always pass through newlines / carriage returns unchanged
      if (s === '\r' || s === '\n' || s === '\r\n' || s.includes('\n')) {
        realWrite(s)
        return
      }
      // If the chunk contains any control char (backspace etc.) or ANSI
      // escape, it's a "cursor action" — readline is doing visual
      // bookkeeping. Pass it through unchanged so backspace / arrow
      // keys work normally.
      if (/[\x00-\x1f\x7f]|\x1b\[/.test(s)) {
        realWrite(s)
        return
      }
      // All remaining chunks are pure printable text. Decide based on
      // length: 1 char = typing, N>1 chars = paste.
      if (s.length === 1) {
        // Single character typed — mask with '*'
        realWrite('*')
        return
      }
      // Multi-character chunk — treat as paste. Show ONE concise hint
      // instead of N asterisks, so the line stays clean. The chars
      // themselves are not echoed (readline has already buffered them).
      if (!pasteHintShown) {
        pasteHintShown = true
        realWrite(`\x1b[2m[paste ${s.length} chars]\x1b[0m`)
      }
      // Don't echo the individual pasted chars — the hint is enough.
    }
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// ---------- Key providers metadata ----------
const KEY_PROVIDERS = {
  mimo: {
    envKey: 'MIMO_API_KEY',
    label: 'MiMo',
    fullName: 'Xiaomi MiMo',
    purpose: '语音转文字 (STT) + 文字转语音 (TTS)',
    url: 'https://platform.xiaomimimo.com',
    keysPath: '控制台 → API Keys → Create new key',
    formatHint: 'sk-mimo-xxxxxxxxxx... (约 48-56 字符)',
    validate: (v) => {
      if (v.length < 20) return '太短了，MiMo key 一般 ≥ 48 字符'
      if (!v.startsWith('sk-')) return '应该以 "sk-" 开头'
      return null
    },
  },
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    fullName: 'DeepSeek',
    purpose: '面搭子的大脑（出题 / 追问 / 点评）',
    url: 'https://platform.deepseek.com',
    keysPath: 'API Keys → Create new secret key',
    formatHint: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx (约 35 字符)',
    validate: (v) => {
      if (v.length < 20) return '太短了，DeepSeek key 一般 ≥ 35 字符'
      if (!v.startsWith('sk-')) return '应该以 "sk-" 开头'
      return null
    },
  },
}

// ---------- Terminal box drawing ----------
function box(lines, opts = {}) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length))
  const top = `${c.dim}┌${'─'.repeat(width + 2)}┐${c.reset}`
  const bot = `${c.dim}└${'─'.repeat(width + 2)}┘${c.reset}`
  const body = lines.map((l) => `${c.dim}│${c.reset} ${l.padEnd(width)} ${c.dim}│${c.reset}`).join('\n')
  return `${top}\n${body}\n${bot}`
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// ---------- Prompt: yes/no ----------
async function promptYN(question, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] '
  process.stdout.write(question + suffix)
  if (!process.stdin.isTTY) {
    // Non-TTY: default to yes (matches typical CLI tool behavior)
    process.stdout.write(defaultYes ? 'Y\n' : 'N\n')
    return defaultYes
  }
  return new Promise((resolve) => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const cleanup = () => {
      try { stdin.setRawMode(false) } catch { /* noop */ }
      stdin.pause()
      stdin.removeListener('data', onData)
    }
    const onData = (ch) => {
      for (const c of ch) {
        const code = c.charCodeAt(0)
        if (code === 3) { cleanup(); process.exit(130) }
        else if (code === 13 || code === 10) {
          cleanup()
          process.stdout.write(defaultYes ? 'Y\n' : 'N\n')
          resolve(defaultYes)
          return
        } else if (code === 121 || code === 89) { // y / Y
          cleanup()
          process.stdout.write('Y\n')
          resolve(true)
          return
        } else if (code === 110 || code === 78) { // n / N
          cleanup()
          process.stdout.write('N\n')
          resolve(false)
          return
        }
      }
    }
    stdin.on('data', onData)
  })
}

// ---------- Prompt: open browser (returns true if user wants to) ----------
async function offerOpenBrowser(url) {
  return promptYN(`  ${c.dim}需要我帮你打开浏览器到申请页吗？${c.reset}`, true)
    .then((yes) => {
      if (yes) openBrowser(url)
      return yes
    })
}

async function ensureKeys() {
  const envKeys = readEnvKeys()
  const runtimeKeys = readRuntimeKeys()
  const have = {
    mimo: isRealKey(envKeys.mimo) || isRealKey(runtimeKeys.mimo),
    deepseek: isRealKey(envKeys.deepseek) || isRealKey(runtimeKeys.deepseek),
  }

  if (have.mimo && have.deepseek && !flags.reset) {
    const sources = []
    if (isRealKey(envKeys.mimo) || isRealKey(envKeys.deepseek)) sources.push('.env')
    if (isRealKey(runtimeKeys.mimo) || isRealKey(runtimeKeys.deepseek)) sources.push('.model-settings.json')
    ok(`检测到 Key 已配置（来源: ${sources.join(' + ')}），跳过输入。`)
    return
  }

  if (flags.reset) {
    info('--reset：强制重新输入 Key（输入回车则保留当前值）')
  } else {
    const missing = []
    if (!have.mimo) missing.push('MiMo')
    if (!have.deepseek) missing.push('DeepSeek')
    warn(`检测到 Key 缺失: ${missing.join(' + ')}`)
  }

  // Parse existing .env (or start from .env.example) so we can preserve other fields.
  let entries, originalLines
  if (existsSync(envPath)) {
    const parsed = parseEnvFile(envPath)
    entries = parsed.entries
    originalLines = parsed.lines
  } else if (existsSync(envExamplePath)) {
    const parsed = parseEnvFile(envExamplePath)
    entries = parsed.entries
    originalLines = parsed.lines
    warn(`.env 不存在，将从 .env.example 复制模板`)
  } else {
    entries = new Map()
    originalLines = []
  }

  // Build the list of steps to ask for, in order.
  const steps = []
  if (!have.mimo) steps.push('mimo')
  if (!have.deepseek) steps.push('deepseek')
  // --reset mode: ask both even if currently configured
  if (flags.reset) {
    steps.length = 0
    steps.push('mimo', 'deepseek')
  }
  const total = steps.length

  log('')
  log(box([
    `${c.bold}${c.cyan}  🗝  需要配置 ${total} 个 API Key${c.reset}`,
    '',
    `  接下来会依次询问，按提示填写即可。`,
    `  Ctrl-C 随时取消。输入 ?  查看帮助。`,
  ]))
  log('')

  for (let i = 0; i < steps.length; i++) {
    const providerKey = steps[i]
    const stepNum = i + 1
    const p = KEY_PROVIDERS[providerKey]
    const result = await askKeyStep(stepNum, total, p, entries)
    if (result === 'aborted') {
      warn('用户取消，按当前配置继续启动。')
      log('')
      return
    }
    if (result.changed) {
      setEnvKey(entries, p.envKey, result.value)
    }
    log('')
  }

  // Preview + confirm
  if (flags.reset) {
    const anyChange = steps.some((k) => entries.get(KEY_PROVIDERS[k].envKey)?.value)
    if (!anyChange) {
      warn('未输入新 Key，按当前配置继续启动。')
      log('')
      return
    }
  } else {
    // For first-time setup, at least one key was just set
  }

  writeEnvFile(envPath, entries, originalLines)
  log(box([
    `${c.green}  ✅  全部完成${c.reset}`,
    '',
    `  已写入 ${c.cyan}${envPath}${c.reset}`,
    `  下次启动 npm run launch 会自动跳过询问。`,
  ]))
  log('')
}

// Prompt for one key, with step indicator, format hint, browser helper,
// validation (loops until valid), and a "press ? for help" affordance.
// Returns:
//   { changed: true, value: string }   — user entered a valid key
//   { changed: false }                 — reset mode and user pressed Enter
//   'aborted'                          — user pressed Ctrl-C
async function askKeyStep(stepNum, total, p, entries) {
  const current = entries.get(p.envKey)?.value || ''
  const hadCurrent = current && isRealKey(current)

  // Render the step header (box)
  const stepHeader = box([
    `${c.bold}${c.cyan}  Step ${stepNum} / ${total}  ·  ${p.fullName} API Key${c.reset}`,
    '',
    `  ${c.dim}用途${c.reset}   ${p.purpose}`,
    `  ${c.dim}申请${c.reset}   ${c.underline}${p.url}${c.reset}  →  ${p.keysPath}`,
    `  ${c.dim}格式${c.reset}   ${p.formatHint}`,
  ])
  log(stepHeader)
  log('')

  // Offer to open the browser
  if (!flags.noOpen) {
    const opened = await offerOpenBrowser(p.url)
    if (opened) {
      log(`  ${c.dim}已打开浏览器，请拿 key 后回来粘贴（输入 ? 查帮助）${c.reset}`)
    }
  }

  // Loop until a valid key is entered or user aborts
  let attempt = 0
  while (true) {
    attempt++
    const currentHint = hadCurrent
      ? `  ${c.dim}（当前: ${maskKey(current)}，回车跳过）${c.reset}`
      : ''
    const value = await promptMasked(
      `  ${c.bold}  ${p.label} Key>${c.reset}${currentHint} `,
    )

    // Empty input
    if (!value || value.trim().length === 0) {
      if (hadCurrent) {
        // --reset mode: keep the existing value
        return { changed: false }
      }
      // Strict: no skip allowed when there's no current value
      if (flags.reset) return { changed: false }
      log(`  ${c.yellow}✗ 不能跳过，请填写 ${p.fullName} 的 API Key${c.reset}`)
      log(`  ${c.dim}  提示：去 ${p.url} 拿 key，复制后粘贴到这里${c.reset}`)
      continue
    }

    const trimmed = value.trim()

    // Help
    if (trimmed === '?' || trimmed.toLowerCase() === 'help') {
      log(`  ${c.dim}${helpText(p, current)}${c.reset}`)
      continue
    }

    // Validate
    const errMsg = p.validate(trimmed)
    if (errMsg) {
      log(`  ${c.yellow}✗ ${errMsg}${c.reset}`)
      log(`  ${c.dim}  请重输，或输入 ? 查看帮助${c.reset}`)
      continue
    }

    // Success
    log(`  ${c.green}✓ 已收到: ${maskKey(trimmed)} (${trimmed.length} 字符)${c.reset}`)
    return { changed: true, value: trimmed }
  }
}

function helpText(p, current) {
  const lines = [
    ``,
    `  ┌─ ${p.fullName} API Key 快速帮助 ─────────────────────`,
    `  │ 1. 浏览器打开: ${p.url}`,
    `  │ 2. 注册 / 登录后进入: ${p.keysPath}`,
    `  │ 3. 创建一个新 key（如果还没有）`,
    `  │ 4. 复制 key（一般以 sk- 开头）`,
    `  │ 5. 回到这里粘贴`,
    `  │`,
    `  │ 格式要求: ${p.formatHint}`,
  ]
  if (current && isRealKey(current)) {
    lines.push(`  │ 当前值:   ${maskKey(current)} (回车跳过)`)
  }
  lines.push(`  └──────────────────────────────────────────────────`)
  return lines.join('\n')
}

function maskKey(value) {
  if (!value || value.length < 8) return '***'
  return value.slice(0, 4) + '***' + value.slice(-4)
}

// ---------- Environment checks ----------
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  const ok = major > 22 || (major === 22 && minor >= 13)
  if (!ok) {
    err(`需要 Node 22.13+（当前 ${process.versions.node}）。内置 node:sqlite 与 --experimental-strip-types 在 22.13+ 才可用。`)
    process.exit(1)
  }
}

function ensureDeps() {
  if (!existsSync(join(projectRoot, 'node_modules'))) {
    info('根目录 node_modules 缺失，正在安装...')
    execSync('npm install', { stdio: 'inherit', cwd: projectRoot })
  }
  if (!existsSync(join(projectRoot, 'frontend', 'node_modules'))) {
    info('frontend/node_modules 缺失，正在安装...')
    execSync('npm install', { stdio: 'inherit', cwd: join(projectRoot, 'frontend') })
  }
}

function killPortIfBusy(port) {
  // On Windows use netstat + taskkill; on POSIX use lsof
  if (process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano | findstr ":${port}"`, { encoding: 'utf8' })
      const pids = new Set()
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/\s(\d+)\s*$/)
        if (m && line.includes('LISTENING')) pids.add(m[1])
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }) } catch { /* noop */ }
      }
      if (pids.size > 0) info(`已清理端口 ${port} 上的旧进程（${pids.size} 个）`)
    } catch {
      // netstat returns 1 if no match — that's fine
    }
  } else {
    try {
      execSync(`lsof -ti :${port} | xargs -r kill -9`, { stdio: 'ignore' })
    } catch { /* noop */ }
  }
}

// ---------- Wait for /api/health ----------
async function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) {
        const data = await r.json()
        return data
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

// Best-effort wait for any HTTP endpoint to respond (used for Vite).
async function waitForHttp(url, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return true
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// ---------- Open browser ----------
function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  try {
    spawn(cmd, { shell: true, stdio: 'ignore', detached: true }).unref()
  } catch {
    // best-effort
  }
}

// ---------- Main ----------
async function main() {
  log('')
  log(`${c.bold}${c.cyan}  🍜 面搭子 · 一键启动${c.reset}`)
  log(`${c.dim}  项目根目录: ${projectRoot}${c.reset}`)
  log('')

  checkNode()
  ensureDeps()
  await ensureKeys()

  // Free up ports just in case
  killPortIfBusy(flags.port)
  killPortIfBusy(webPort)

  info(`启动后端 (port ${flags.port}) + 前端 (port ${webPort})...`)
  log('')

  // Start dev.mjs in a child process so we can capture exit
  const devScript = join(__dirname, 'dev.mjs')
  const child = spawn(process.execPath, [devScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(flags.port) },
    shell: false,
  })

  // Prefix its output so the user can tell which log is which
  const prefix = `${c.magenta}[dev]${c.reset} `
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8')
    child[stream].on('data', (chunk) => {
      const lines = chunk.split(/\r?\n/)
      for (const line of lines) {
        if (line.length === 0) continue
        process.stdout.write(prefix + line + '\n')
      }
    })
  }
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      err(`dev.mjs 退出，code=${code}`)
    }
    process.exit(code ?? 0)
  })

  // Wait for the backend to come up
  const health = await waitForHealth(flags.port)
  if (!health) {
    err(`后端在 ${flags.port} 端口 ${15000}ms 内未响应 /api/health`)
    info('请检查上方 [dev] 日志中的报错')
    child.kill()
    process.exit(1)
  }
  ok(`后端就绪: http://localhost:${flags.port}/api/health`)

  // Status summary
  if (health.hasApiKey && health.hasDeepseekKey) {
    ok(`Key 状态: MiMo ✓  DeepSeek ✓`)
  } else {
    warn(`Key 状态: ${[
      health.hasApiKey ? null : 'MiMo ✗',
      health.hasDeepseekKey ? null : 'DeepSeek ✗',
    ].filter(Boolean).join(' / ')} — 启动后访问 http://localhost:${webPort}/settings 在线补填`)
  }

  // Wait for the frontend dev server to come up too (best-effort, 8s)
  const webReady = await waitForHttp(`http://localhost:${webPort}/`, 8000)
  if (!webReady) {
    warn(`前端 Vite 在 ${webPort} 端口 8s 内未响应，请查看上方 [dev] 日志`)
  }

  const target = `http://localhost:${webPort}`
  log('')
  ok(`前端地址: ${c.cyan}${target}${c.reset}`)
  log(`${c.dim}  按 Ctrl-C 停止所有服务${c.reset}`)
  log('')

  if (!flags.noOpen) {
    info('正在打开浏览器...')
    openBrowser(target)
  } else {
    info('已跳过自动打开浏览器（--no-open）')
  }

  // Graceful shutdown
  const shutdown = () => {
    log('')
    info('收到退出信号，正在关闭服务...')
    try { child.kill() } catch { /* noop */ }
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((e) => {
  err(`启动失败: ${e.message}`)
  console.error(e)
  process.exit(1)
})
