import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { TOKEN_URL, type HttpPost } from '../src/google.js'
import http from 'node:http'
import { listen, login } from '../src/login.js'

const BOTH_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/adwords'

function setup(
  tokenAnswer: { status: number; body: object } = { status: 200, body: { access_token: 'at', refresh_token: 'rt-new', scope: BOTH_SCOPES } },
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-login-'))
  const clientFile = path.join(dir, 'client_secret.json')
  fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csec' } }))
  const out = path.join(dir, 'config', 'google.json')
  const tokenCalls: string[] = []
  const http: HttpPost = async (url, init) => {
    if (url !== TOKEN_URL) throw new Error(`unexpected ${url}`)
    tokenCalls.push(init.body)
    return { status: tokenAnswer.status, text: JSON.stringify(tokenAnswer.body) }
  }
  const logs: string[] = []
  return { clientFile, out, http, tokenCalls, logs, log: (l: string) => logs.push(l) }
}

// Plays the browser: sends each query, in order, to the loopback redirect.
const browser = (...queries: Array<(auth: URL) => Record<string, string>>) => (url: string) => {
  const auth = new URL(url)
  void (async () => {
    for (const query of queries) {
      const redirect = new URL(auth.searchParams.get('redirect_uri')!)
      for (const [k, v] of Object.entries(query(auth))) redirect.searchParams.set(k, v)
      await fetch(redirect).catch(() => {})
    }
  })()
}
const stateOf = (auth: URL) => auth.searchParams.get('state')!

describe('login', () => {
  test('signs in through the loopback redirect and saves the login, readable only by you', async () => {
    const s = setup()
    let auth: URL | undefined
    await login({
      clientFile: s.clientFile,
      out: s.out,
      http: s.http,
      log: s.log,
      openUrl: browser((a) => ((auth = a), { code: 'abc', state: stateOf(a) })),
    })

    expect(auth!.origin + auth!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(auth!.searchParams.get('client_id')).toBe('cid')
    expect(auth!.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(auth!.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/webmasters.readonly',
    )
    expect(auth!.searchParams.get('code_challenge_method')).toBe('S256')

    const form = new URLSearchParams(s.tokenCalls[0])
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('abc')
    expect(form.get('redirect_uri')).toBe(auth!.searchParams.get('redirect_uri'))
    const challenge = crypto.createHash('sha256').update(form.get('code_verifier')!).digest('base64url')
    expect(challenge).toBe(auth!.searchParams.get('code_challenge'))

    expect(JSON.parse(fs.readFileSync(s.out, 'utf8'))).toEqual({ clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt-new' })
    expect(fs.statSync(s.out).mode & 0o777).toBe(0o600)
    expect(s.logs.some((l) => l.includes(auth!.toString()))).toBe(true)
  })

  test('ignores stray and forged requests and waits for the real redirect', async () => {
    const s = setup()
    await login({
      clientFile: s.clientFile,
      out: s.out,
      http: s.http,
      log: s.log,
      openUrl: browser(
        () => ({}),
        () => ({ code: 'forged-code', state: 'forged' }),
        () => ({ error: 'access_denied', state: 'forged' }),
        (a) => ({ code: 'abc', state: stateOf(a) }),
      ),
    })
    expect(s.tokenCalls.length).toBe(1)
    expect(new URLSearchParams(s.tokenCalls[0]).get('code')).toBe('abc')
  })

  test('reports a refused consent', async () => {
    const s = setup()
    const run = login({ clientFile: s.clientFile, out: s.out, http: s.http, log: s.log, openUrl: browser((a) => ({ error: 'access_denied', state: stateOf(a) })) })
    await expect(run).rejects.toThrow('access_denied')
  })

  test('refuses a login that lacks one of the two permissions', async () => {
    const s = setup({ status: 200, body: { access_token: 'at', refresh_token: 'rt', scope: 'https://www.googleapis.com/auth/webmasters.readonly' } })
    const run = login({ clientFile: s.clientFile, out: s.out, http: s.http, log: s.log, openUrl: browser((a) => ({ code: 'abc', state: stateOf(a) })) })
    await expect(run).rejects.toThrow('Google Ads')
    expect(fs.existsSync(s.out)).toBe(false)
  })

  test('replaces an existing login in one step, leaving no temp file', async () => {
    const s = setup()
    fs.mkdirSync(path.dirname(s.out), { recursive: true })
    fs.writeFileSync(s.out, 'old', { mode: 0o644 })
    await login({ clientFile: s.clientFile, out: s.out, http: s.http, log: s.log, openUrl: browser((a) => ({ code: 'abc', state: stateOf(a) })) })
    expect(JSON.parse(fs.readFileSync(s.out, 'utf8')).refreshToken).toBe('rt-new')
    expect(fs.statSync(s.out).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(s.out))).toEqual(['google.json'])
  })

  test('does not echo a malformed client file into the error', async () => {
    const s = setup()
    fs.writeFileSync(s.clientFile, '{"installed":{"client_secret":"GOCSPX-supersecret"')
    const err = await login({ clientFile: s.clientFile, out: s.out, http: s.http, log: s.log }).catch((e) => e)
    expect(err.message).toBe(`${s.clientFile} is not valid JSON`)
  })

  test('fails when Google returns no refresh token', async () => {
    const s = setup({ status: 200, body: { access_token: 'at' } })
    const run = login({
      clientFile: s.clientFile,
      out: s.out,
      http: s.http,
      log: s.log,
      openUrl: browser((a) => ({ code: 'abc', state: stateOf(a) })),
    })
    await expect(run).rejects.toThrow('no refresh token')
  })

  test('rejects a client file that is not a Desktop app client', async () => {
    const s = setup()
    fs.writeFileSync(s.clientFile, JSON.stringify({ web: { client_id: 'cid', client_secret: 'csec' } }))
    await expect(login({ clientFile: s.clientFile, out: s.out, http: s.http, log: s.log })).rejects.toThrow('Desktop app')
  })
})

describe('listen', () => {
  test('rejects instead of crashing when the port cannot be opened', async () => {
    const server = http.createServer()
    // A documentation-only address this machine does not have.
    await expect(listen(server, '203.0.113.1')).rejects.toThrow(/EADDRNOTAVAIL|EINVAL/)
  })
})
