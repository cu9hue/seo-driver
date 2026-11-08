import fs from 'node:fs'
import path from 'node:path'

export const LOCK_FILE = 'seo-driver.lock'
export const FAILURES_FILE = 'failures.json'
// Longer than one site can take with the per-command timeouts; a run
// refreshes its lock before each site. A lock older than this is stale even
// when its pid is alive: after a reboot, the pid may belong to another process.
const STALE_MS = 12 * 60 * 60 * 1000

export type Lock =
  | { acquired: true; refresh: (now: Date) => void; release: () => void }
  | { acquired: false; holder: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface Holder {
  pid?: number
  startedAt: string
  // When the holder last showed it was alive.
  seenAt: string
  // The exact file read, so a takeover can tell it was not replaced since.
  identity: string
  claimKey: string
}

function readHolder(file: string): Holder | undefined {
  let text: string
  let stat: fs.Stats
  try {
    text = fs.readFileSync(file, 'utf8')
    stat = fs.statSync(file)
  } catch {
    return undefined
  }
  const mtime = new Date(stat.mtimeMs).toISOString()
  const ids = { identity: `${stat.ino}:${stat.mtimeMs}:${text}`, claimKey: `${stat.ino}-${Math.round(stat.mtimeMs)}` }
  try {
    const { pid, startedAt, refreshedAt } = JSON.parse(text)
    if (typeof pid === 'number' && typeof startedAt === 'string') {
      return { pid, startedAt, seenAt: typeof refreshedAt === 'string' ? refreshedAt : startedAt, ...ids }
    }
  } catch {
    // its owner has created it but not written it yet
  }
  return { startedAt: mtime, seenAt: mtime, ...ids }
}

// One run at a time per workDir, so two runs cannot both find a site due and
// both open a PR for it, or prune each other's clones.
export function acquireLock(workDir: string, now: Date, isAlive: (pid: number) => boolean = pidAlive): Lock {
  fs.mkdirSync(workDir, { recursive: true })
  const file = path.join(workDir, LOCK_FILE)
  const startedAt = now.toISOString()
  let content = JSON.stringify({ pid: process.pid, startedAt })
  const ours = () => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content
  const create = (): Lock | undefined => {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return undefined
      throw err
    }
    return {
      acquired: true,
      refresh: (at) => {
        if (!ours()) return
        content = JSON.stringify({ pid: process.pid, startedAt, refreshedAt: at.toISOString() })
        fs.writeFileSync(file, content)
      },
      // Leave a lock that another run took over as stale.
      release: () => {
        if (ours()) fs.rmSync(file)
      },
    }
  }
  const raced = { acquired: false as const, holder: 'another run that took the lock a moment ago' }

  const taken = create()
  if (taken) return taken
  const holder = readHolder(file)
  if (!holder) return create() ?? raced
  const fresh = now.getTime() - Date.parse(holder.seenAt) < STALE_MS
  if (fresh && (holder.pid === undefined || isAlive(holder.pid))) {
    return { acquired: false, holder: `pid ${holder.pid ?? 'unknown'}, started ${holder.startedAt}` }
  }

  // Only the run that creates the claim for this exact lock may remove it.
  // A run that claims it later finds the lock replaced and backs off.
  const claim = `${file}.takeover-${holder.claimKey}`
  try {
    fs.writeFileSync(claim, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return { acquired: false, holder: `another run taking over the stale lock; if none is running, delete ${claim}` }
  }
  try {
    if (readHolder(file)?.identity !== holder.identity) return raced
    fs.rmSync(file)
    return create() ?? raced
  } finally {
    fs.rmSync(claim, { force: true })
  }
}

export function readFailures(workDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(workDir, FAILURES_FILE), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

// Called only while holding the lock, so the read-modify-write is safe.
export function recordFailure(workDir: string, domain: string, when: Date): void {
  const failures = { ...readFailures(workDir), [domain]: when.toISOString() }
  fs.writeFileSync(path.join(workDir, FAILURES_FILE), `${JSON.stringify(failures, null, 2)}\n`)
}
