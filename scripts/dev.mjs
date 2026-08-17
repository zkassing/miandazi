// scripts/dev.mjs — run the Fastify API and the Vite dev server in parallel.
// Stop with Ctrl-C. Each child's stdout/stderr is prefixed with its name.

import { spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs'

// Resolve npm's CLI without a shell: run node directly on npm-cli.js.
// Avoids the DEP0190 warning (shell:true + args) and .cmd shim issues.
function npmRunWeb() {
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(npmCli)) {
    return { cmd: process.execPath, args: [npmCli, '--prefix', 'frontend', 'run', 'dev'] }
  }
  // Fallback: npm not bundled next to node (e.g. nvm) — use the .cmd shim via shell.
  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['--prefix', 'frontend', 'run', 'dev'],
    shell: true,
  }
}

const procs = [
  {
    name: 'api',
    color: '\x1b[36m', // cyan
    cmd: process.execPath,
    args: ['--experimental-strip-types', '--no-warnings', '--watch', 'src/server.ts'],
  },
  {
    name: 'web',
    color: '\x1b[35m', // magenta
    ...npmRunWeb(),
  },
]

const RESET = '\x1b[0m'
const children = []

for (const p of procs) {
  const child = spawn(p.cmd, p.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: p.shell ?? false,
  })
  const prefix = `${p.color}[${p.name}]${RESET} `
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
    process.stdout.write(`${prefix}exited with code ${code}${RESET}\n`)
    for (const c of children) {
      if (c !== child) {
        try {
          c.kill()
        } catch {
          /* noop */
        }
      }
    }
    process.exit(code ?? 0)
  })
  children.push(child)
}

const shutdown = () => {
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* noop */
    }
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
