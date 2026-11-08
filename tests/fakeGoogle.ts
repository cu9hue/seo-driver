import type { Google } from '../src/google.js'

export interface FakeGoogle extends Google {
  calls: Array<{ api: string; url: string; body: Record<string, unknown>; headers?: Record<string, string> }>
}

// Answers each post with the next response, or the last one again.
export function fakeGoogle(...responses: Array<unknown | Error>): FakeGoogle {
  const calls: FakeGoogle['calls'] = []
  return {
    calls,
    post: async (api, url, body, headers) => {
      calls.push({ api, url, body: body as Record<string, unknown>, headers })
      const response = responses[Math.min(calls.length - 1, responses.length - 1)]
      if (response instanceof Error) throw response
      return response
    },
  }
}
