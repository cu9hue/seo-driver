import fs from 'node:fs'
import path from 'node:path'
import type { Exec } from './exec.js'
import type { SiteConfig } from './types.js'

async function run(exec: Exec, cwd: string, cmd: string, args: string[]): Promise<string> {
  const result = await exec(cmd, args, { cwd })
  if (result.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14)

export async function cloneSite(exec: Exec, site: SiteConfig, workDir: string, now: Date): Promise<string> {
  const clonePath = path.join(workDir, `${site.domain}-${stamp(now)}`)
  const result = await exec('gh', [
    'repo', 'clone', site.repo, clonePath, '--', '--depth', '1', '--branch', site.baseBranch,
  ])
  if (result.code !== 0) throw new Error(`gh repo clone ${site.repo} failed: ${result.stderr.trim()}`)
  return clonePath
}

export function hasGuideTemplate(clonePath: string, site: SiteConfig): boolean {
  return [site.exampleGuide, site.instructionsFile].some((file) => file && fs.existsSync(path.join(clonePath, file)))
}

export async function changedFiles(exec: Exec, clonePath: string): Promise<string[]> {
  const stdout = await run(exec, clonePath, 'git', ['status', '--porcelain'])
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3))
}

export async function commitAndPush(exec: Exec, clonePath: string, branch: string, message: string): Promise<void> {
  await run(exec, clonePath, 'git', ['checkout', '-b', branch])
  await run(exec, clonePath, 'git', ['add', '-A'])
  await run(exec, clonePath, 'git', ['commit', '-m', message])
  await run(exec, clonePath, 'git', ['push', '-u', 'origin', branch])
}

// Commands are split on spaces and run without a shell, matching the
// Bash(<command>) entries Claude is allowed to run.
export async function runBuild(exec: Exec, clonePath: string, site: SiteConfig): Promise<{ ok: boolean; output: string }> {
  let output = ''
  for (const command of site.buildCommands) {
    const [cmd, ...args] = command.split(' ').filter(Boolean)
    const result = await exec(cmd, args, { cwd: clonePath })
    output += `$ ${command}\n${result.stdout}${result.stderr}`
    if (result.code !== 0) return { ok: false, output }
  }
  return { ok: true, output }
}

export function hasSourcesSection(text: string): boolean {
  return /<h[23][^>]*>\s*sources\s*<\/h[23]>/i.test(text) || /^#{2,3}\s+sources\s*$/im.test(text)
}
