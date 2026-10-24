import { describe, expect, test } from 'vitest'
import { dueCheck, ensureLabel, listGuidePrs, openPr, renderPrBody, type GuidePr, type GuideResult } from '../src/github.js'
import type { Candidate, SiteConfig } from '../src/types.js'
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

const pr = (number: number, state: GuidePr['state'], createdAt: string): GuidePr => ({
  number,
  state,
  createdAt,
  url: `https://github.com/x/y/pull/${number}`,
})

describe('listGuidePrs', () => {
  test('lists labeled PRs and reads the keyword marker', async () => {
    const stdout = JSON.stringify([
      {
        number: 3,
        state: 'MERGED',
        createdAt: '2026-10-20T07:00:00Z',
        url: 'https://github.com/x/y/pull/3',
        body: '<!-- seo-driver keyword: how to finish a song -->\n## Target keyword',
      },
      { number: 1, state: 'CLOSED', createdAt: '2026-10-01T07:00:00Z', url: 'https://github.com/x/y/pull/1', body: 'hand-made' },
    ])
    const exec = fakeExec([{ match: is('gh', 'pr', 'list'), result: { stdout } }])
    const prs = await listGuidePrs(exec, 'x/y')
    expect(exec.calls[0].args).toEqual([
      'pr', 'list', '--repo', 'x/y', '--label', 'seo-guide', '--state', 'all', '--limit', '1000',
      '--json', 'number,state,createdAt,url,body',
    ])
    expect(prs).toEqual([
      { number: 3, state: 'MERGED', createdAt: '2026-10-20T07:00:00Z', url: 'https://github.com/x/y/pull/3', keyword: 'how to finish a song' },
      { number: 1, state: 'CLOSED', createdAt: '2026-10-01T07:00:00Z', url: 'https://github.com/x/y/pull/1', keyword: undefined },
    ])
  })

  test('throws when gh fails', async () => {
    const exec = fakeExec([{ match: is('gh', 'pr', 'list'), result: { code: 1, stderr: 'HTTP 404: Not Found' } }])
    await expect(listGuidePrs(exec, 'x/y')).rejects.toThrow('HTTP 404')
  })
})

describe('dueCheck', () => {
  const now = new Date('2026-10-24T07:00:00Z')

  test('an open PR blocks the site', () => {
    expect(dueCheck(site, [pr(12, 'OPEN', '2026-10-01T07:00:00Z')], now)).toEqual({
      due: false,
      reason: 'guide PR #12 is still open',
    })
  })

  test('a PR inside the interval blocks the site', () => {
    expect(dueCheck(site, [pr(4, 'MERGED', '2026-10-23T09:00:00Z')], now)).toEqual({
      due: false,
      reason: 'next guide due 2026-10-25',
    })
  })

  test('a PR older than the interval does not block', () => {
    expect(dueCheck(site, [pr(4, 'MERGED', '2026-10-21T09:00:00Z')], now)).toEqual({ due: true })
  })

  test('counts calendar days, so a later time of day two days ago is due', () => {
    expect(dueCheck(site, [pr(4, 'MERGED', '2026-10-22T07:05:00Z')], now)).toEqual({ due: true })
  })

  test('uses the newest PR', () => {
    const prs = [pr(2, 'CLOSED', '2026-10-10T07:00:00Z'), pr(5, 'CLOSED', '2026-10-23T07:00:00Z')]
    expect(dueCheck(site, prs, now)).toEqual({ due: false, reason: 'next guide due 2026-10-25' })
  })

  test('no PRs means due', () => {
    expect(dueCheck(site, [], now)).toEqual({ due: true })
  })

  test('a failed run inside the interval blocks the site', () => {
    expect(dueCheck(site, [pr(4, 'MERGED', '2026-10-01T07:00:00Z')], now, '2026-10-23T07:00:00Z')).toEqual({
      due: false,
      reason: 'last run failed on 2026-10-23; next try 2026-10-25',
    })
  })

  test('a failed run older than the interval does not block', () => {
    expect(dueCheck(site, [], now, '2026-10-22T07:00:00Z')).toEqual({ due: true })
  })

  test('a newer PR wins over an older failure', () => {
    expect(dueCheck(site, [pr(4, 'MERGED', '2026-10-23T09:00:00Z')], now, '2026-10-20T07:00:00Z')).toEqual({
      due: false,
      reason: 'next guide due 2026-10-25',
    })
  })
})

describe('renderPrBody', () => {
  const guide: GuideResult = {
    keyword: 'how to arrange a song',
    title: 'How to Arrange a Song From a Loop',
    slug: 'arrange-song-from-loop',
    guidePath: 'arrange-song-from-loop/index.html',
    sources: ['https://www.ableton.com/en/manual/arrangement-view/'],
    linkedFrom: ['index.html', 'how-to-start-producing-music/index.html'],
    reason: 'Highest-impression gap that matches the product.',
  }
  const chosen: Candidate = {
    keyword: 'how to arrange a song',
    source: 'search-console',
    score: 16000,
    impressions: 16000,
    clicks: 0,
    position: 50.2,
  }
  const runnerUp: Candidate = {
    keyword: 'ableton drop',
    source: 'keyword-planner',
    score: 440,
    avgMonthlySearches: 880,
    competition: 'MEDIUM',
  }

  test('carries the marker, the data, sources and links', () => {
    const body = renderPrBody({ site, guide, chosen, shortlist: [chosen, runnerUp], fixed: [] })
    expect(body.startsWith('<!-- seo-driver keyword: how to arrange a song -->')).toBe(true)
    expect(body).toContain('16000 impressions')
    expect(body).toContain('0 clicks')
    expect(body).toContain('50.2')
    expect(body).toContain('Highest-impression gap that matches the product.')
    expect(body).toContain('ableton drop')
    expect(body).toContain('880 searches a month')
    expect(body).toContain('https://www.ableton.com/en/manual/arrangement-view/')
    expect(body).toContain('how-to-start-producing-music/index.html')
    expect(body).toContain('No issues found.')
  })

  test('lists fixed review issues', () => {
    const body = renderPrBody({
      site,
      guide,
      chosen,
      shortlist: [chosen],
      fixed: [{ kind: 'unsourced-claim', location: 'paragraph 3', detail: 'Cut the claim about 16 bars.' }],
    })
    expect(body).toContain('unsourced-claim: Cut the claim about 16 bars.')
    expect(body).not.toContain('No issues found.')
  })
})

describe('ensureLabel', () => {
  test('creates or updates the seo-guide label', async () => {
    const exec = fakeExec([{ match: is('gh', 'label', 'create'), result: {} }])
    await ensureLabel(exec, site.repo)
    expect(exec.calls[0].args).toEqual([
      'label', 'create', 'seo-guide', '--repo', 'antithetical-labs/mixing-pal-landing', '--force', '--color', '1D76DB',
    ])
  })
})

describe('openPr', () => {
  test('creates the PR with the label and the body on stdin', async () => {
    const exec = fakeExec([{ match: is('gh', 'pr', 'create'), result: { stdout: 'https://github.com/x/y/pull/7\n' } }])
    const url = await openPr(exec, site, 'seo-guide/arrange-song-from-loop', 'Add guide: How to Arrange', 'BODY')
    expect(url).toBe('https://github.com/x/y/pull/7')
    expect(exec.calls.length).toBe(1)
    expect(exec.calls[0].args).toEqual([
      'pr', 'create', '--repo', 'antithetical-labs/mixing-pal-landing', '--base', 'main',
      '--head', 'seo-guide/arrange-song-from-loop', '--title', 'Add guide: How to Arrange',
      '--label', 'seo-guide', '--body-file', '-',
    ])
    expect(exec.calls[0].opts?.input).toBe('BODY')
  })

  test('throws when gh pr create fails', async () => {
    const exec = fakeExec([{ match: is('gh', 'pr', 'create'), result: { code: 1, stderr: 'a pull request already exists' } }])
    await expect(openPr(exec, site, 'b', 't', 'body')).rejects.toThrow('already exists')
  })
})
