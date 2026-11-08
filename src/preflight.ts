import type { Exec } from './exec.js'

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

const PREFLIGHT: Array<[string, string[]]> = [
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
