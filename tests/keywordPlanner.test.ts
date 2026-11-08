import { describe, expect, test } from 'vitest'
import { fetchKeywordIdeas } from '../src/sources/keywordPlanner.js'
import type { Config, SiteConfig } from '../src/types.js'
import { fakeGoogle } from './fakeGoogle.js'

const site: SiteConfig = {
  domain: 'mixingpal.com',
  repo: 'your-org/your-site',
  baseBranch: 'main',
  intervalDays: 2,
  seedKeywords: [],
  buildCommands: ['npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}
const kp: Config['keywordPlanner'] = { customerId: '1234567890', geoTargetConstants: ['2840'], language: '1000' }

describe('fetchKeywordIdeas', () => {
  test('posts a URL seed with geo and language resource names to the customer', async () => {
    const google = fakeGoogle({})
    await fetchKeywordIdeas(google, site, kp)
    expect(google.calls[0].api).toBe('Keyword Planner')
    expect(google.calls[0].url).toBe('https://googleads.googleapis.com/v26/customers/1234567890:generateKeywordIdeas')
    expect(google.calls[0].body).toEqual({
      urlSeed: { url: 'https://mixingpal.com/' },
      geoTargetConstants: ['geoTargetConstants/2840'],
      language: 'languageConstants/1000',
      // Search only, like the Search Console data it is ranked with.
      keywordPlanNetwork: 'GOOGLE_SEARCH',
      pageSize: 10000,
    })
    expect(google.calls[0].headers).toEqual({})
  })

  test('seeds with keywords and the URL, and sends the manager account when set', async () => {
    const google = fakeGoogle({})
    await fetchKeywordIdeas(google, { ...site, seedKeywords: ['ableton arrangement'] }, { ...kp, loginCustomerId: '1112223333' })
    expect(google.calls[0].body.keywordAndUrlSeed).toEqual({ url: 'https://mixingpal.com/', keywords: ['ableton arrangement'] })
    expect(google.calls[0].body.urlSeed).toBeUndefined()
    expect(google.calls[0].headers).toEqual({ 'login-customer-id': '1112223333' })
  })

  test('follows the page token through every page', async () => {
    const idea = (text: string) => ({ text, keywordIdeaMetrics: { avgMonthlySearches: '100', competition: 'LOW' } })
    const google = fakeGoogle({ results: [idea('one')], nextPageToken: 'p2' }, { results: [idea('two')] })
    const ideas = await fetchKeywordIdeas(google, site, kp)
    expect(ideas.map((i) => i.keyword)).toEqual(['one', 'two'])
    expect(google.calls[1].body.pageToken).toBe('p2')
  })

  test('parses string counts and missing competition', async () => {
    const results = [
      { text: 'how to arrange a song', keywordIdeaMetrics: { avgMonthlySearches: '1900', competition: 'LOW' } },
      { text: 'ableton drop', keywordIdeaMetrics: { avgMonthlySearches: 880, competition: 'MEDIUM' } },
      { text: 'daw', keywordIdeaMetrics: { avgMonthlySearches: '90500', competition: 'HIGH' } },
      { text: 'no comp', keywordIdeaMetrics: { avgMonthlySearches: '500' } },
      { text: 'tiny', keywordIdeaMetrics: { avgMonthlySearches: '10', competition: 'LOW' } },
      { text: 'no metrics' },
    ]
    expect(await fetchKeywordIdeas(fakeGoogle({ results }), site, kp)).toEqual([
      {
        keyword: 'how to arrange a song',
        source: 'keyword-planner',
        score: 1900,
        avgMonthlySearches: 1900,
        competition: 'LOW',
      },
      { keyword: 'ableton drop', source: 'keyword-planner', score: 440, avgMonthlySearches: 880, competition: 'MEDIUM' },
      // Advertiser competition is not ranking difficulty, so HIGH is down-weighted, not dropped.
      { keyword: 'daw', source: 'keyword-planner', score: 22625, avgMonthlySearches: 90500, competition: 'HIGH' },
    ])
  })

  test('fails loudly instead of truncating when pages never end', async () => {
    const google = fakeGoogle({ results: [], nextPageToken: 'again' })
    await expect(fetchKeywordIdeas(google, site, kp)).rejects.toThrow('Keyword Planner returned more than 10 pages')
  })

  test('propagates a Google failure', async () => {
    await expect(fetchKeywordIdeas(fakeGoogle(new Error('Keyword Planner failed: PERMISSION_DENIED')), site, kp)).rejects.toThrow(
      'PERMISSION_DENIED',
    )
  })
})
