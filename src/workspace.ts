import fs from 'node:fs'
import path from 'node:path'
import type { Exec } from './exec.js'
import type { SiteConfig } from './types.js'

async function run(exec: Exec, cwd: string, cmd: string, args: string[]): Promise<string> {
  const result = await exec(cmd, args, { cwd })
  if (result.code !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Each site keeps at most one clone: the newest, from a failed or dry run.
function pruneClones(workDir: string, domain: string): void {
  if (!fs.existsSync(workDir)) return
  const ownClone = new RegExp(`^${escapeRegExp(domain)}-\\d{14}$`)
  for (const entry of fs.readdirSync(workDir)) {
    if (ownClone.test(entry)) fs.rmSync(path.join(workDir, entry), { recursive: true, force: true })
  }
}

export async function cloneSite(exec: Exec, site: SiteConfig, workDir: string, now: Date): Promise<string> {
  pruneClones(workDir, site.domain)
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

// -uall lists each file inside a new folder, and -z keeps paths unquoted, so
// the protected-file check sees every real path.
export async function changedFiles(exec: Exec, clonePath: string): Promise<string[]> {
  const stdout = await run(exec, clonePath, 'git', ['status', '--porcelain', '-uall', '-z'])
  const fields = stdout.split('\0')
  const files: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry === '') continue
    files.push(entry.slice(3))
    // A rename or copy is followed by its original path as the next field.
    if (/^[RC]/.test(entry) && fields[i + 1]) files.push(fields[++i])
  }
  return files
}

export async function commitAndPush(exec: Exec, clonePath: string, branch: string, message: string): Promise<void> {
  await run(exec, clonePath, 'git', ['checkout', '-b', branch])
  await run(exec, clonePath, 'git', ['add', '-A'])
  // --no-verify: hooks in the clone are repo code, and these calls run with
  // the user's credentials.
  await run(exec, clonePath, 'git', ['commit', '--no-verify', '-m', message])
  await run(exec, clonePath, 'git', ['push', '--no-verify', '-u', 'origin', branch])
}

export async function deleteRemoteBranch(exec: Exec, clonePath: string, branch: string): Promise<void> {
  await run(exec, clonePath, 'git', ['push', '--no-verify', 'origin', '--delete', branch])
}

const PROTECTED_DIRS = ['.github/']
const PROTECTED_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', '.npmrc',
])

// Files a guide never needs, whose changes would run code with the user's
// credentials (install scripts, CI workflows triggered by the push).
export function protectedChanges(files: string[]): string[] {
  return files.filter(
    (file) => PROTECTED_DIRS.some((dir) => file.startsWith(dir)) || PROTECTED_FILES.has(path.basename(file)),
  )
}

// Commands are split on spaces and run without a shell, matching the
// Bash(<command>) entries Claude is allowed to run.
export async function runBuild(exec: Exec, clonePath: string, site: SiteConfig): Promise<{ ok: boolean; output: string }> {
  let output = ''
  for (const command of site.buildCommands) {
    const [cmd, ...args] = command.split(' ').filter(Boolean)
    const result = await exec(cmd, args, { cwd: clonePath, timeoutMs: BUILD_TIMEOUT_MS })
    output += `$ ${command}\n${result.stdout}${result.stderr}`
    if (result.code !== 0) return { ok: false, output }
  }
  return { ok: true, output }
}

// An h2 or h3 whose text, with inner tags removed, starts with "Sources".
export function hasSourcesSection(text: string): boolean {
  for (const match of text.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    if (/^sources\b/i.test(match[2].replace(/<[^>]*>/g, '').trim())) return true
  }
  return /^#{2,3}\s+sources\b/im.test(text)
}
