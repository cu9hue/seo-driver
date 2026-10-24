import { describe, expect, test } from 'vitest'
import { realExec } from '../src/exec.js'
import { GumError, gumRead, preflight } from '../src/gum.js'
import { fakeExec, is } from './fakeExec.js'

describe('gumRead', () => {
  test('passes args as JSON and parses stdout', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{"rows":[{"keys":["a"]}]}' } }])
    const result = await gumRead(exec, 'searchconsole.searchanalytics.query', { siteUrl: 'x' })
    expect(exec.calls[0].args).toEqual([
      'read',
      'searchconsole.searchanalytics.query',
      '--args',
      '{"siteUrl":"x"}',
      '--format',
      'json',
      '--max-items',
      'all',
    ])
    expect(result).toEqual({ rows: [{ keys: ['a'] }] })
  })

  test('throws GumError with the envelope code', async () => {
    const exec = fakeExec([
      {
        match: is('gum', 'read'),
        result: { code: 1, stderr: '{"error_code":"AUTH_KEYCHAIN_UNAVAILABLE","message":"keychain did not respond"}' },
      },
    ])
    const err = await gumRead(exec, 'searchconsole.searchanalytics.query', {}).catch((e) => e)
    expect(err).toBeInstanceOf(GumError)
    expect(err.errorCode).toBe('AUTH_KEYCHAIN_UNAVAILABLE')
    expect(err.opId).toBe('searchconsole.searchanalytics.query')
    expect(err.message).toContain('keychain did not respond')
  })

  test('finds the envelope after log lines', async () => {
    const stderr = [
      '{"level":"INFO","msg":"dispatch start"}',
      '{',
      '  "error_code": "PERMISSION_DENIED",',
      '  "message": "developer token not approved"',
      '}',
    ].join('\n')
    const exec = fakeExec([{ match: is('gum', 'read'), result: { code: 1, stderr } }])
    const err = await gumRead(exec, 'googleads.keywordPlanIdeas.generateKeywordIdeas', {}).catch((e) => e)
    expect(err.errorCode).toBe('PERMISSION_DENIED')
    expect(err.message).toBe('developer token not approved')
  })

  test('throws on a plain Error line', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { code: 1, stderr: 'Error: unknown op\n' } }])
    const err = await gumRead(exec, 'nope.op', {}).catch((e) => e)
    expect(err).toBeInstanceOf(GumError)
    expect(err.errorCode).toBeUndefined()
    expect(err.message).toContain('unknown op')
  })

  test('throws GumError when stdout is not JSON', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: 'rows[1]{keys}: a' } }])
    const err = await gumRead(exec, 'searchconsole.searchanalytics.query', {}).catch((e) => e)
    expect(err).toBeInstanceOf(GumError)
  })
})

describe('preflight', () => {
  const ok = [
    { match: is('gum', '--version'), result: { stdout: 'gum 2.3.1' } },
    { match: is('git', '--version'), result: { stdout: 'git version 2.50' } },
    { match: is('gh', 'auth', 'status'), result: { stdout: 'Logged in' } },
    { match: is('claude', '--version'), result: { stdout: '2.1.310' } },
    { match: is('git', 'config', 'user.name'), result: { stdout: 'Polina\n' } },
    { match: is('git', 'config', 'user.email'), result: { stdout: 'p@example.com\n' } },
    { match: is('gh', 'config', 'get', 'git_protocol'), result: { stdout: 'https\n' } },
    { match: is('git', 'config', '--get-urlmatch', 'credential.helper', 'https://github.com'), result: { stdout: '!gh auth git-credential\n' } },
  ]

  test('passes when every program answers', async () => {
    await expect(preflight(fakeExec(ok))).resolves.toBeUndefined()
  })

  test('names the missing program', async () => {
    const exec = fakeExec([{ match: is('gum', '--version'), result: { code: 127 } }, ...ok])
    await expect(preflight(exec)).rejects.toThrow('`gum` is not installed or not on PATH')
  })

  test('names a logged-out gh', async () => {
    const exec = fakeExec([
      { match: is('gh', 'auth', 'status'), result: { code: 1, stderr: 'You are not logged into any GitHub hosts.\nRun gh auth login' } },
      ...ok,
    ])
    await expect(preflight(exec)).rejects.toThrow('`gh auth status` failed: You are not logged into any GitHub hosts.')
  })

  test('names a missing git identity', async () => {
    const exec = fakeExec([{ match: is('git', 'config', 'user.email'), result: { code: 1 } }, ...ok])
    await expect(preflight(exec)).rejects.toThrow('git user.email is not set')
  })

  test('names missing push credentials for https remotes', async () => {
    const exec = fakeExec([{ match: is('git', 'config', '--get-urlmatch'), result: { code: 1 } }, ...ok])
    await expect(preflight(exec)).rejects.toThrow('gh auth setup-git')
  })

  test('skips the credential helper check for ssh remotes', async () => {
    const exec = fakeExec([
      { match: is('gh', 'config', 'get', 'git_protocol'), result: { stdout: 'ssh\n' } },
      { match: is('git', 'config', '--get-urlmatch'), result: { code: 1 } },
      ...ok,
    ])
    await expect(preflight(exec)).resolves.toBeUndefined()
  })
})

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
