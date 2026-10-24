import fs from 'node:fs'
import path from 'node:path'

export const LOCK_FILE = 'seo-driver.lock'
export const FAILURES_FILE = 'failures.json'
// Longer than any run can last with the per-command timeouts. A lock older
// than this is stale even when its pid is alive: after a reboot, the pid may
// belong to another process.
const STALE_MS = 12 * 60 * 60 * 1000

export type Lock = { acquired: true; release: () => void } | { acquired: false; holder: string }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readHolder(file: string): { pid?: number; startedAt: string } | undefined {
  let text: string
  let mtime: number
  try {
    text = fs.readFileSync(file, 'utf8')
    mtime = fs.statSync(file).mtimeMs
  } catch {
    return undefined
  }
  try {
    const { pid, startedAt } = JSON.parse(text)
    if (typeof pid === 'number' && typeof startedAt === 'string') return { pid, startedAt }
  } catch {
    // its owner has created it but not written it yet
  }
  return { startedAt: new Date(mtime).toISOString() }
}

// One run at a time per workDir, so two runs cannot both find a site due and
// both open a PR for it. Two runs that find the same stale lock in the same
// instant can both take it; the open-PR check before each push covers that.
export function acquireLock(workDir: string, now: Date, isAlive: (pid: number) => boolean = pidAlive): Lock {
  fs.mkdirSync(workDir, { recursive: true })
  const file = path.join(workDir, LOCK_FILE)
  const content = JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, content, { flag: 'wx' })
      return {
        acquired: true,
        release: () => {
          // Leave a lock that another run took over as stale.
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) fs.rmSync(file)
        },
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = readHolder(file)
    if (!holder) continue
    const fresh = now.getTime() - Date.parse(holder.startedAt) < STALE_MS
    if (fresh && (holder.pid === undefined || isAlive(holder.pid))) {
      return { acquired: false, holder: `pid ${holder.pid ?? 'unknown'}, started ${holder.startedAt}` }
    }
    fs.rmSync(file, { force: true })
  }
  return { acquired: false, holder: 'another run that took over a stale lock' }
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
