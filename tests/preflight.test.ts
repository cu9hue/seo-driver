import { describe, expect, test } from 'vitest'
import { preflight } from '../src/preflight.js'
import { fakeExec, is } from './fakeExec.js'

describe('preflight', () => {
  const ok = [
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
    const exec = fakeExec([{ match: is('claude', '--version'), result: { code: 127 } }, ...ok])
    await expect(preflight(exec)).rejects.toThrow('`claude` is not installed or not on PATH')
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
