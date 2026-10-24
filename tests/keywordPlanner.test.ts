import { describe, expect, test } from 'vitest'
import { GumError } from '../src/gum.js'
import { fetchKeywordIdeas } from '../src/sources/keywordPlanner.js'
import type { Config, SiteConfig } from '../src/types.js'
import { fakeExec, is } from './fakeExec.js'

const site: SiteConfig = {
  domain: 'mixingpal.com',
  repo: 'antithetical-labs/mixing-pal-landing',
  baseBranch: 'main',
  intervalDays: 2,
  seedKeywords: [],
  buildCommands: ['npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}
const kp: Config['keywordPlanner'] = { geoTargetConstants: ['2840'], language: '1000' }

describe('fetchKeywordIdeas', () => {
  test('sends url, geo and language, and omits unset fields', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{}' } }])
    await fetchKeywordIdeas(exec, site, kp)
    expect(exec.calls[0].args[1]).toBe('googleads.keywordPlanIdeas.generateKeywordIdeas')
    expect(JSON.parse(exec.calls[0].args[3])).toEqual({
      url: 'https://mixingpal.com/',
      geoTargetConstants: ['2840'],
      language: '1000',
    })
  })

  test('sends seeds and customerId when set', async () => {
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: '{}' } }])
    await fetchKeywordIdeas(exec, { ...site, seedKeywords: ['ableton arrangement'] }, { ...kp, customerId: '1234567890' })
    const args = JSON.parse(exec.calls[0].args[3])
    expect(args.keywords).toEqual(['ableton arrangement'])
    expect(args.customerId).toBe('1234567890')
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
    const exec = fakeExec([{ match: is('gum', 'read'), result: { stdout: JSON.stringify({ results }) } }])
    expect(await fetchKeywordIdeas(exec, site, kp)).toEqual([
      {
        keyword: 'how to arrange a song',
        source: 'keyword-planner',
        score: 1900,
        avgMonthlySearches: 1900,
        competition: 'LOW',
      },
      { keyword: 'ableton drop', source: 'keyword-planner', score: 440, avgMonthlySearches: 880, competition: 'MEDIUM' },
    ])
  })

  test('propagates GumError', async () => {
    const exec = fakeExec([
      {
        match: is('gum', 'read'),
        result: { code: 1, stderr: '{"error_code":"PERMISSION_DENIED","message":"developer token not approved"}' },
      },
    ])
    await expect(fetchKeywordIdeas(exec, site, kp)).rejects.toBeInstanceOf(GumError)
  })
})
