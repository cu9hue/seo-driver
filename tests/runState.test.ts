import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { acquireLock, FAILURES_FILE, LOCK_FILE, readFailures, recordFailure } from '../src/runState.js'

const NOW = new Date('2026-10-24T07:00:00Z')
const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-state-'))
const alive = () => true
const dead = () => false

function writeLock(dir: string, pid: number, startedAt: string) {
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ pid, startedAt }))
}

describe('acquireLock', () => {
  test('takes a free lock, creating workDir, and release frees it', () => {
    const dir = path.join(workDir(), 'nested')
    const lock = acquireLock(dir, NOW, alive)
    expect(lock.acquired).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'))).toEqual({ pid: process.pid, startedAt: NOW.toISOString() })
    if (lock.acquired) lock.release()
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false)
  })

  test('a second run cannot take a held lock', () => {
    const dir = workDir()
    writeLock(dir, 4242, '2026-10-24T06:30:00Z')
    expect(acquireLock(dir, NOW, alive)).toEqual({ acquired: false, holder: 'pid 4242, started 2026-10-24T06:30:00Z' })
  })

  test('takes over a lock whose process is gone', () => {
    const dir = workDir()
    writeLock(dir, 4242, '2026-10-24T06:30:00Z')
    expect(acquireLock(dir, NOW, dead).acquired).toBe(true)
  })

  test('takes over a lock older than 12 hours, since its pid may belong to another process after a reboot', () => {
    const dir = workDir()
    writeLock(dir, 4242, '2026-10-23T18:59:00Z')
    expect(acquireLock(dir, NOW, alive).acquired).toBe(true)
  })

  test('treats a fresh unreadable lock as held, since its owner may still be writing it', () => {
    const dir = workDir()
    fs.writeFileSync(path.join(dir, LOCK_FILE), '')
    expect(acquireLock(dir, new Date(), dead).acquired).toBe(false)
  })

  test('release leaves a lock that another run took over', () => {
    const dir = workDir()
    const lock = acquireLock(dir, NOW, alive)
    writeLock(dir, 4242, NOW.toISOString())
    if (lock.acquired) lock.release()
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true)
  })
})

describe('failures', () => {
  test('records the last failure per site', () => {
    const dir = workDir()
    expect(readFailures(dir)).toEqual({})
    recordFailure(dir, 'mixingpal.com', NOW)
    recordFailure(dir, 'other.com', new Date('2026-10-20T07:00:00Z'))
    expect(readFailures(dir)).toEqual({ 'mixingpal.com': NOW.toISOString(), 'other.com': '2026-10-20T07:00:00.000Z' })
  })

  test('an unreadable file counts as no failures', () => {
    const dir = workDir()
    fs.writeFileSync(path.join(dir, FAILURES_FILE), '{ not json')
    expect(readFailures(dir)).toEqual({})
  })
})
