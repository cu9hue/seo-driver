import { describe, expect, test } from 'vitest'
import { realExec } from '../src/exec.js'

describe('realExec', () => {
  test('returns 127 for a missing binary', async () => {
    const result = await realExec('definitely-not-a-binary-xyz', [])
    expect(result.code).toBe(127)
  })

  test('passes input on stdin and captures stdout', async () => {
    const result = await realExec(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' })
    expect(result).toEqual({ code: 0, stdout: 'hello', stderr: '' })
  })

  test('kills a command that runs past its timeout', async () => {
    const started = Date.now()
    const result = await realExec(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })
    expect(result.code).toBe(124)
    expect(result.stderr).toContain('timed out after 0.3s')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
