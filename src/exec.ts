import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  input?: string
}

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

// No shell: arguments reach the program as-is. A missing program resolves to
// code 127, as a shell would report it, instead of rejecting.
export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || err.message })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
