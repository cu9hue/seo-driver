import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { TOKEN_URL, type GoogleCredentials, type HttpPost } from './google.js'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const SCOPES = {
  'https://www.googleapis.com/auth/adwords': 'Google Ads',
  'https://www.googleapis.com/auth/webmasters.readonly': 'Search Console',
}
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

function readClient(file: string): { clientId: string; clientSecret: string } {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(`cannot read OAuth client ${file}: ${(err as Error).message}`)
  }
  let installed: { client_id?: string; client_secret?: string } | undefined
  try {
    installed = JSON.parse(text).installed
  } catch {
    // The parser's message quotes the file, which holds the client secret.
    throw new Error(`${file} is not valid JSON`)
  }
  if (!installed?.client_id || !installed.client_secret) {
    throw new Error(`${file} is not a Desktop app OAuth client; create one of type "Desktop app" and download its JSON`)
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret }
}

export function listen(server: http.Server, host = '127.0.0.1'): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

// Resolves with the code from the redirect that carries our state. Any other
// request, such as a favicon or a port scan, is answered and ignored.
function awaitRedirect(server: http.Server, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes')), LOGIN_TIMEOUT_MS)
    timer.unref()
    server.on('request', (req, res) => {
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const reply = (message: string) => res.writeHead(200, { 'content-type': 'text/plain' }).end(message)
      if (query.get('state') !== state) return reply('Not a sign-in redirect.')
      const error = query.get('error')
      const code = query.get('code')
      clearTimeout(timer)
      if (error || !code) {
        reply('Sign-in failed. You can close this tab.')
        reject(new Error(`Google refused the sign-in: ${error ?? 'no code'}`))
      } else {
        reply('Signed in. You can close this tab.')
        resolve(code)
      }
    })
  })
}

// The installed-app flow: a loopback redirect with PKCE. The saved refresh
// token works on any machine, so a headless box can take a copy of the file.
export async function login(opts: {
  clientFile: string
  out: string
  http: HttpPost
  log: (line: string) => void
  // Opens the consent URL; tests use it to play the browser.
  openUrl?: (url: string) => void
}): Promise<void> {
  const client = readClient(opts.clientFile)
  const verifier = crypto.randomBytes(32).toString('base64url')
  const state = crypto.randomBytes(16).toString('base64url')

  const server = http.createServer()
  await listen(server)
  let code: string
  let redirectUri: string
  try {
    redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const url = new URL(AUTH_URL)
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: Object.keys(SCOPES).join(' '),
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      // Asks for a new refresh token even when access was granted before.
      prompt: 'consent',
    }).toString()
    opts.log(`Open this URL in a browser on this machine and sign in with the Google account that has Search Console and Google Ads access:\n${url}`)
    const redirect = awaitRedirect(server, state)
    opts.openUrl?.(url.toString())
    code = await redirect
  } finally {
    server.close()
  }

  const response = await opts.http(TOKEN_URL, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  })
  let body: { refresh_token?: string; scope?: string; error?: string; error_description?: string } = {}
  try {
    body = JSON.parse(response.text)
  } catch {
    // reported below
  }
  if (response.status !== 200) throw new Error(`Google token exchange failed: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`)
  if (!body.refresh_token) throw new Error('Google returned no refresh token; start the login again')
  // The consent screen lets you untick a permission and still sign in.
  const granted = new Set((body.scope ?? '').split(' '))
  const missing = Object.entries(SCOPES).filter(([scope]) => !granted.has(scope)).map(([, name]) => name)
  if (missing.length > 0) {
    throw new Error(`the sign-in did not grant ${missing.join(' and ')} access; log in again and tick every permission`)
  }

  const creds: GoogleCredentials = { ...client, refreshToken: body.refresh_token }
  fs.mkdirSync(path.dirname(opts.out), { recursive: true, mode: 0o700 })
  // A rename is atomic, so a run starting now reads the old login or the new
  // one, never half a file.
  const temp = `${opts.out}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, opts.out)
  opts.log(`Saved the Google login to ${opts.out}. On a headless server, copy this file to the same path there.`)
}
