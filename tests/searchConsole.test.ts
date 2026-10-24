import { describe, expect, test } from 'vitest'
import { fetchSearchGaps, searchConsoleWindow } from '../src/sources/searchConsole.js'
import type { SiteConfig } from '../src/types.js'
import { fakeExec, is } from './fakeExec.js'

const site: SiteConfig = {
  domain: 'mixingpal.com',
  repo: 'antithetical-labs/mixing-pal-landing',
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
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{}' } }])
    await fetchSearchGaps(exec, site, today)
    const args = JSON.parse(exec.calls[0].args[3])
    expect(exec.calls[0].args[1]).toBe('searchconsole.searchanalytics.query')
    // Rows come sorted by clicks, so zero-click gaps sit at the end.
    expect(args).toEqual({
      siteUrl: 'sc-domain:mixingpal.com',
      body: { startDate: '2026-09-25', endDate: '2026-10-22', dimensions: ['query'], rowLimit: 25000 },
    })
  })

  test('filters to the configured country', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{}' } }])
    await fetchSearchGaps(exec, site, today, 'usa')
    const { body } = JSON.parse(exec.calls[0].args[3])
    expect(body.dimensionFilterGroups).toEqual([{ filters: [{ dimension: 'country', operator: 'equals', expression: 'usa' }] }])
  })

  test('keeps high-impression low-click rows', async () => {
    const rows = [
      { keys: ['ableton arrangement view'], clicks: 0, impressions: 16000, ctr: 0, position: 50.2 },
      { keys: ['mixing pal'], clicks: 40, impressions: 200, ctr: 0.2, position: 1.1 },
      { keys: ['rare query'], clicks: 0, impressions: 12, ctr: 0, position: 80 },
    ]
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: JSON.stringify({ rows }) } }])
    expect(await fetchSearchGaps(exec, site, today)).toEqual([
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
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: JSON.stringify({ rows }) } }])
    expect((await fetchSearchGaps(exec, site, today)).map((c) => c.keyword)).toEqual(['edge'])
  })

  test('no rows key yields []', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{}' } }])
    expect(await fetchSearchGaps(exec, site, today)).toEqual([])
  })

  test('unset property makes no gum call', async () => {
    const exec = fakeExec([])
    expect(await fetchSearchGaps(exec, { ...site, searchConsoleProperty: undefined }, today)).toEqual([])
    expect(exec.calls.length).toBe(0)
  })
})
