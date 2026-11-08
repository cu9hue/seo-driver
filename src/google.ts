import fs from 'node:fs'

export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REQUEST_TIMEOUT_MS = 60 * 1000
// Refresh a minute early, so a token never expires mid-request.
const EXPIRY_MARGIN_MS = 60 * 1000
// Rate limits and brief outages; anything else is Google refusing the request.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const RETRY_WAITS_MS = [2000, 8000, 30000]

export type HttpPost = (
  url: string,
  init: { headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: string; requestId?: string }>

export const realHttpPost: HttpPost = async (url, init) => {
  const response = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  return { status: response.status, text: await response.text(), requestId: response.headers.get('request-id') ?? undefined }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export interface GoogleCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface Google {
  // api names the service in error messages, such as "Search Console".
  post(api: string, url: string, body: object, headers?: Record<string, string>): Promise<unknown>
}

export class GoogleError extends Error {}

export function readCredentials(file: string): GoogleCredentials {
  let parsed: Partial<GoogleCredentials> | undefined
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // reported below
  }
  // The refresh token works from anywhere, so only its owner may read it.
  if (parsed && fs.statSync(file).mode & 0o077) throw new GoogleError(`${file} is readable by other users; run chmod 600 ${file}`)
  if (!parsed?.clientId || !parsed.clientSecret || !parsed.refreshToken) {
    throw new GoogleError(`no Google login at ${file}; run \`seo-driver login\``)
  }
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, refreshToken: parsed.refreshToken }
}

function parseJson(text: string): Record<string, any> | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// Google's error envelope, plus the per-error codes Google Ads adds in details.
function describeFailure(status: number, body: Record<string, any> | undefined): string {
  const error = body?.error
  if (!error?.message) return `HTTP ${status}`
  const adsErrors = (error.details ?? []).flatMap((d: any) => d.errors ?? [])
  const codes = adsErrors.map((e: any) => `${Object.values(e.errorCode ?? {})[0] ?? 'ERROR'}: ${e.message}`)
  return `${error.status ?? `HTTP ${status}`}: ${error.message}${codes.length ? ` (${codes.join('; ')})` : ''}`
}

export function googleClient(
  http: HttpPost,
  creds: GoogleCredentials,
  now: () => Date,
  sleep: (ms: number) => Promise<void> = realSleep,
): Google {
  let token: { value: string; expiresAt: number } | undefined

  // Retries rate limits, 5xx and network errors, with jitter so retries from
  // one run don't line up.
  const send: HttpPost = async (url, init) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt === RETRY_WAITS_MS.length
      try {
        const response = await http(url, init)
        if (last || !RETRY_STATUS.has(response.status)) return response
      } catch (err) {
        if (last) throw err
      }
      await sleep(RETRY_WAITS_MS[attempt] * (1 + Math.random() / 2))
    }
  }

  async function accessToken(): Promise<string> {
    if (token && now().getTime() < token.expiresAt) return token.value
    const response = await send(TOKEN_URL, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString(),
    })
    const body = parseJson(response.text)
    if (body?.error === 'invalid_grant') throw new GoogleError('Google login expired or was revoked; run `seo-driver login` again')
    if (response.status !== 200 || typeof body?.access_token !== 'string') {
      throw new GoogleError(`Google token refresh failed: ${body?.error_description ?? body?.error ?? `HTTP ${response.status}`}`)
    }
    token = { value: body.access_token, expiresAt: now().getTime() + Number(body.expires_in ?? 3600) * 1000 - EXPIRY_MARGIN_MS }
    return token.value
  }

  return {
    async post(api, url, body, headers = {}) {
      const response = await send(url, {
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      const parsed = parseJson(response.text)
      if (response.status !== 200 || parsed === undefined) {
        // Google support asks for the request id.
        const id = response.requestId ? ` [request-id ${response.requestId}]` : ''
        throw new GoogleError(`${api} failed: ${describeFailure(response.status, parsed)}${id}`)
      }
      return parsed
    },
  }
}
