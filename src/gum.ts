import type { Exec } from './exec.js'

export class GumError extends Error {
  constructor(
    readonly opId: string,
    message: string,
    readonly errorCode?: string,
  ) {
    super(message)
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

// gum reports a failed dispatch on stderr as a JSON envelope
// ({"error_code": ..., "message": ...}), possibly after JSON log lines; other
// failures are an "Error: ..." line. The envelope is the last JSON value.
function parseFailure(stderr: string): { message: string; errorCode?: string } {
  const lines = stderr.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const envelope = JSON.parse(lines.slice(i).join('\n'))
      if (typeof envelope?.message === 'string' && 'error_code' in envelope) {
        return { message: envelope.message, errorCode: envelope.error_code }
      }
    } catch {
      // not a complete JSON value from this line on
    }
  }
  const errorLine = lines.find((l) => l.startsWith('Error:')) ?? lines[0] ?? ''
  return { message: errorLine.replace(/^Error:\s*/, '') || 'gum failed with no output' }
}

export async function gumRead(exec: Exec, opId: string, args: object): Promise<unknown> {
  const result = await exec('gum', ['read', opId, '--args', JSON.stringify(args), '--format', 'json', '--max-items', 'all'])
  if (result.code !== 0) {
    const { message, errorCode } = parseFailure(result.stderr)
    throw new GumError(opId, message, errorCode)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new GumError(opId, `gum returned output that is not JSON: ${firstLine(result.stdout)}`)
  }
}

const PREFLIGHT: Array<[string, string[]]> = [
  ['gum', ['--version']],
  ['git', ['--version']],
  ['gh', ['auth', 'status']],
  ['claude', ['--version']],
]

const answer = async (exec: Exec, cmd: string, args: string[]) => {
  const result = await exec(cmd, args)
  return result.code === 0 ? result.stdout.trim() : ''
}

// The commit and push come after every Claude run, so a box that cannot
// commit or push must fail here, before the spend.
export async function preflight(exec: Exec): Promise<void> {
  for (const [cmd, args] of PREFLIGHT) {
    const result = await exec(cmd, args)
    if (result.code === 127) throw new Error(`\`${cmd}\` is not installed or not on PATH`)
    if (result.code !== 0) {
      throw new Error(`\`${[cmd, ...args].join(' ')}\` failed: ${firstLine(result.stderr || result.stdout)}`)
    }
  }
  for (const key of ['user.name', 'user.email']) {
    if (!(await answer(exec, 'git', ['config', key]))) {
      throw new Error(`git ${key} is not set; run \`git config --global ${key} <value>\``)
    }
  }
  // gh clones over https unless told to use ssh, and https pushes need gh's
  // credential helper.
  if ((await answer(exec, 'gh', ['config', 'get', 'git_protocol'])) !== 'ssh') {
    if (!(await answer(exec, 'git', ['config', '--get-urlmatch', 'credential.helper', 'https://github.com']))) {
      throw new Error('git has no credential helper for github.com, so the push would fail; run `gh auth setup-git`')
    }
  }
}
