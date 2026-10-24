import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  input?: string
  timeoutMs?: number
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

const running = new Set<number>()

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // the group already exited
  }
}

// Children run in their own process group, so Ctrl-C or a kill of this
// process no longer reaches them. Pass the signal on, then exit.
let forwarding = false
function forwardSignals(): void {
  if (forwarding) return
  forwarding = true
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.on(signal, () => {
      for (const pid of running) killGroup(pid, signal)
      process.exit(code)
    })
  }
}

// No shell: arguments reach the program as-is. A missing program resolves to
// code 127, as a shell would report it, instead of rejecting. A command past
// its timeout is killed with its whole process group (npm and claude start
// children) and resolves to code 124, as `timeout` reports it.
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    forwardSignals()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    if (child.pid) running.add(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid!, 'SIGKILL')
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (child.pid) running.delete(child.pid)
      if (timedOut) resolve({ code: 124, stdout, stderr: `${stderr}\n${cmd} timed out after ${timeoutMs / 1000}s`.trim() })
      else resolve({ code: code ?? 1, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
