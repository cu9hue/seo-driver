import { describe, expect, test } from 'vitest'
import { fetchSearchGaps, searchConsoleWindow } from '../src/sources/searchConsole.js'
import type { SiteConfig } from '../src/types.js'
import { fakeGoogle } from './fakeGoogle.js'

const site: SiteConfig = {
  domain: 'mixingpal.com',
  repo: 'your-org/your-site',
  baseBranch: 'main',
  intervalDays: 2,
  searchConsoleProperty: 'sc-domain:mixingpal.com',
  seedKeywords: [],
  buildCommands: ['npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}
const today = new Date('2026-10-24T08:00:00Z')

describe('searchConsoleWindow', () => {
  test('window for 2026-10-24 is 2026-09-25..2026-10-22', () => {
    expect(searchConsoleWindow(today)).toEqual({ startDate: '2026-09-25', endDate: '2026-10-22' })
  })
})

describe('fetchSearchGaps', () => {
  test('sends the property, window, query dimension and the API row maximum', async () => {
    const google = fakeGoogle({})
    await fetchSearchGaps(google, site, today)
    expect(google.calls[0].api).toBe('Search Console')
    expect(google.calls[0].url).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Amixingpal.com/searchAnalytics/query')
    // Rows come sorted by clicks, so zero-click gaps sit at the end.
    expect(google.calls[0].body).toEqual({ startDate: '2026-09-25', endDate: '2026-10-22', dimensions: ['query'], rowLimit: 25000, startRow: 0 })
  })

  test('filters to the configured country', async () => {
    const google = fakeGoogle({})
    await fetchSearchGaps(google, site, today, 'usa')
    expect(google.calls[0].body.dimensionFilterGroups).toEqual([{ filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }])
  })

  test('keeps high-impression low-click rows', async () => {
    const rows = [
      { keys: ['ableton arrangement view'], clicks: 0, impressions: 16000, ctr: 0, position: 50.2 },
      { keys: ['mixing pal'], clicks: 40, impressions: 200, ctr: 0.2, position: 1.1 },
      { keys: ['rare query'], clicks: 0, impressions: 12, ctr: 0, position: 80 },
    ]
    expect(await fetchSearchGaps(fakeGoogle({ rows }), site, today)).toEqual([
      {
        keyword: 'ableton arrangement view',
        source: 'search-console',
        score: 16000,
        impressions: 16000,
        clicks: 0,
        position: 50.2,
      },
    ])
  })

  test('keeps a row at exactly 100 impressions and 1% ctr', async () => {
    const rows = [{ keys: ['edge'], clicks: 1, impressions: 100, ctr: 0.01, position: 30 }]
    expect((await fetchSearchGaps(fakeGoogle({ rows }), site, today)).map((c) => c.keyword)).toEqual(['edge'])
  })

  test('pages with startRow until a short page', async () => {
    const busy = Array.from({ length: 25000 }, (_, i) => ({ keys: [`q${i}`], clicks: 50, impressions: 200, ctr: 0.25, position: 3 }))
    const gap = { keys: ['zero click gap'], clicks: 0, impressions: 900, ctr: 0, position: 40 }
    const google = fakeGoogle({ rows: busy }, { rows: [gap] })
    const gaps = await fetchSearchGaps(google, site, today)
    expect(gaps.map((g) => g.keyword)).toEqual(['zero click gap'])
    expect(google.calls.length).toBe(2)
    expect(google.calls[0].body.startRow).toBe(0)
    expect(google.calls[1].body.startRow).toBe(25000)
  })

  test('no rows key yields []', async () => {
    expect(await fetchSearchGaps(fakeGoogle({}), site, today)).toEqual([])
  })

  test('unset property makes no Google call', async () => {
    const google = fakeGoogle({})
    expect(await fetchSearchGaps(google, { ...site, searchConsoleProperty: undefined }, today)).toEqual([])
    expect(google.calls.length).toBe(0)
  })
})
