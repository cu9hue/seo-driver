import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { googleClient, readCredentials, TOKEN_URL, type HttpPost } from '../src/google.js'

const creds = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt' }

type Answer = { status: number; body: unknown; requestId?: string } | Error

function fakeHttp(answer: (url: string, body: string) => Answer) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  const http: HttpPost = async (url, init) => {
    calls.push({ url, ...init })
    const a = answer(url, init.body)
    if (a instanceof Error) throw a
    return { status: a.status, text: typeof a.body === 'string' ? a.body : JSON.stringify(a.body), requestId: a.requestId }
  }
  return { http, calls }
}

// Records the waits instead of sleeping.
function fakeSleep() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => void waits.push(ms) }
}

const tokenOk = { status: 200, body: { access_token: 'at-1', expires_in: 3600 } }

describe('googleClient', () => {
  test('refreshes the access token once and reuses it until it expires', async () => {
    let now = new Date('2026-11-08T10:00:00Z')
    const { http, calls } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 200, body: {} }))
    const google = googleClient(http, creds, () => now)
    await google.post('Search Console', 'https://api.test/a', {})
    await google.post('Search Console', 'https://api.test/b', {})
    expect(calls.filter((c) => c.url === TOKEN_URL).length).toBe(1)
    const form = new URLSearchParams(calls[0].body)
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'cid', client_secret: 'csec' })
    expect(calls[0].headers['content-type']).toBe('application/x-www-form-urlencoded')

    now = new Date('2026-11-08T11:00:00Z')
    await google.post('Search Console', 'https://api.test/c', {})
    expect(calls.filter((c) => c.url === TOKEN_URL).length).toBe(2)
  })

  test('sends the bearer token, the JSON body and extra headers, and returns the JSON', async () => {
    const { http, calls } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 200, body: { rows: [1] } }))
    const google = googleClient(http, creds, () => new Date())
    const result = await google.post('Keyword Planner', 'https://api.test/x', { a: 1 }, { 'login-customer-id': '1112223333' })
    expect(result).toEqual({ rows: [1] })
    const call = calls[1]
    expect(call.headers).toEqual({
      authorization: 'Bearer at-1',
      'content-type': 'application/json',
      'login-customer-id': '1112223333',
    })
    expect(call.body).toBe('{"a":1}')
  })

  test('an expired or revoked login says to log in again', async () => {
    const { http } = fakeHttp(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }))
    const google = googleClient(http, creds, () => new Date())
    await expect(google.post('Search Console', 'https://api.test/a', {})).rejects.toThrow(
      'Google login expired or was revoked; run `seo-driver login` again',
    )
  })

  test("names the API and Google's reason, including Google Ads error codes", async () => {
    const failure = {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'The caller does not have permission',
        details: [
          {
            '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
            errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' }, message: "User doesn't have permission." }],
          },
        ],
      },
    }
    const { http } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 403, body: failure }))
    const google = googleClient(http, creds, () => new Date())
    await expect(google.post('Keyword Planner', 'https://api.test/a', {})).rejects.toThrow(
      "Keyword Planner failed: PERMISSION_DENIED: The caller does not have permission (USER_PERMISSION_DENIED: User doesn't have permission.)",
    )
  })

  test('reports the HTTP status for a body that is not JSON', async () => {
    const { http } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 400, body: '<html>Bad Request</html>' }))
    const google = googleClient(http, creds, () => new Date())
    await expect(google.post('Search Console', 'https://api.test/a', {})).rejects.toThrow('Search Console failed: HTTP 400')
  })

  test('retries 429, 5xx and network errors with growing waits, then succeeds', async () => {
    const answers: Answer[] = [{ status: 503, body: {} }, new Error('ECONNRESET'), { status: 429, body: {} }, { status: 200, body: { ok: 1 } }]
    const { http, calls } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : answers.shift()!))
    const { waits, sleep } = fakeSleep()
    const google = googleClient(http, creds, () => new Date(), sleep)
    expect(await google.post('Search Console', 'https://api.test/a', {})).toEqual({ ok: 1 })
    expect(calls.filter((c) => c.url !== TOKEN_URL).length).toBe(4)
    expect(waits.length).toBe(3)
    expect(waits[0]).toBeLessThan(waits[1])
    expect(waits[1]).toBeLessThan(waits[2])
  })

  test('gives up after the last retry and names the failure', async () => {
    const { http, calls } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 503, body: { error: { status: 'UNAVAILABLE', message: 'try later' } } }))
    const google = googleClient(http, creds, () => new Date(), fakeSleep().sleep)
    await expect(google.post('Search Console', 'https://api.test/a', {})).rejects.toThrow('Search Console failed: UNAVAILABLE: try later')
    expect(calls.filter((c) => c.url !== TOKEN_URL).length).toBe(4)
  })

  test('does not retry a request Google rejected', async () => {
    const { http, calls } = fakeHttp((url) => (url === TOKEN_URL ? tokenOk : { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'bad' } } }))
    const google = googleClient(http, creds, () => new Date(), fakeSleep().sleep)
    await expect(google.post('Search Console', 'https://api.test/a', {})).rejects.toThrow('INVALID_ARGUMENT')
    expect(calls.filter((c) => c.url !== TOKEN_URL).length).toBe(1)
  })

  test('retries the token refresh too', async () => {
    const tokens: Answer[] = [{ status: 500, body: {} }, tokenOk]
    const { http } = fakeHttp((url) => (url === TOKEN_URL ? tokens.shift()! : { status: 200, body: {} }))
    const google = googleClient(http, creds, () => new Date(), fakeSleep().sleep)
    await expect(google.post('Search Console', 'https://api.test/a', {})).resolves.toEqual({})
  })

  test("adds Google's request id to a failure, for support", async () => {
    const { http } = fakeHttp((url) =>
      url === TOKEN_URL ? tokenOk : { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'no' } }, requestId: 'req-42' },
    )
    const google = googleClient(http, creds, () => new Date())
    await expect(google.post('Keyword Planner', 'https://api.test/a', {})).rejects.toThrow('PERMISSION_DENIED: no [request-id req-42]')
  })
})

describe('readCredentials', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-creds-'))

  test('reads the saved login', () => {
    const file = path.join(dir(), 'google.json')
    fs.writeFileSync(file, JSON.stringify(creds), { mode: 0o600 })
    expect(readCredentials(file)).toEqual(creds)
    fs.chmodSync(file, 0o400)
    expect(readCredentials(file)).toEqual(creds)
  })

  test('refuses a login file other users can read', () => {
    const file = path.join(dir(), 'google.json')
    fs.writeFileSync(file, JSON.stringify(creds), { mode: 0o600 })
    for (const mode of [0o644, 0o640, 0o440]) {
      fs.chmodSync(file, mode)
      expect(() => readCredentials(file)).toThrow(`${file} is readable by other users; run chmod 600 ${file}`)
    }
  })

  test('a missing or incomplete file says how to log in', () => {
    const file = path.join(dir(), 'google.json')
    expect(() => readCredentials(file)).toThrow(`no Google login at ${file}; run \`seo-driver login\``)
    fs.writeFileSync(file, JSON.stringify({ clientId: 'cid' }), { mode: 0o600 })
    expect(() => readCredentials(file)).toThrow('run `seo-driver login`')
  })
})
