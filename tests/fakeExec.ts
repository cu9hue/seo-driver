import type { Exec, ExecOptions, ExecResult } from '../src/exec.js'

export interface Handler {
  match: (cmd: string, args: string[]) => boolean
  result: Partial<ExecResult> | ((cmd: string, args: string[], opts?: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>)
}

export interface FakeExec extends Exec {
  calls: Array<{ cmd: string; args: string[]; opts?: ExecOptions }>
}

// The first matching handler answers. Unmatched calls fail loudly, so a test
// never passes because an unexpected command silently "succeeded".
export function fakeExec(handlers: Handler[]): FakeExec {
  const calls: FakeExec['calls'] = []
  const exec = (async (cmd: string, args: string[], opts?: ExecOptions) => {
    calls.push({ cmd, args, opts })
    const handler = handlers.find((h) => h.match(cmd, args))
    if (!handler) return { code: 1, stdout: '', stderr: `unexpected call: ${cmd} ${args.join(' ')}` }
    const partial = typeof handler.result === 'function' ? await handler.result(cmd, args, opts) : handler.result
    return { code: 0, stdout: '', stderr: '', ...partial }
  }) as FakeExec
  exec.calls = calls
  return exec
}

export const is =
  (cmd: string, ...prefix: string[]) =>
  (c: string, args: string[]) =>
    c === cmd && prefix.every((p, i) => args[i] === p)
