import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FetchText } from '../src/covered.js'
import type { GuideResult } from '../src/github.js'
import type { Deps } from '../src/pipeline.js'
import type { Config, SiteConfig } from '../src/types.js'
import { fakeExec, is, type FakeExec, type Handler } from './fakeExec.js'

export const NOW = new Date('2026-10-24T07:00:00Z')

export function site(domain: string, overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    domain,
    repo: `acme/${domain.replace(/\W/g, '-')}`,
    baseBranch: 'main',
    intervalDays: 2,
    searchConsoleProperty: `sc-domain:${domain}`,
    seedKeywords: [],
    buildCommands: ['npm run build'],
    exampleGuide: 'how-to-arrange-a-song/index.html',
    ...overrides,
  }
}

export function guideFor(keyword: string): GuideResult {
  return {
    keyword,
    title: 'How to Finish a Song',
    slug: 'how-to-finish-a-song',
    guidePath: 'how-to-finish-a-song/index.html',
    sources: ['https://www.ableton.com/en/manual/arrangement-view/'],
    linkedFrom: ['index.html'],
    reason: 'Highest-volume idea that fits the product.',
  }
}

const GUIDE_HTML = '<h1>How to finish a song</h1><p>Answer.</p><h2>Sources</h2><ul><li>x</li></ul>'

export interface Env {
  config: Config
  deps: Deps
  exec: FakeExec
  logs: string[]
  claudeRuns: string[]
  callsTo: (cmd: string, ...prefix: string[]) => number
}

export interface EnvOptions {
  sites?: SiteConfig[]
  // Extra handlers win over the defaults below.
  handlers?: Handler[]
  writer?: (cwd: string) => { stdout: string; code?: number }
  reviewer?: (round: number) => object
  fixer?: (cwd: string) => GuideResult
  sitemapLocs?: string[]
}

export const result = (structured: object) => ({ stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: structured }) })

export function makeEnv(options: EnvOptions = {}): Env {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-work-'))
  const config: Config = {
    workDir,
    keywordPlanner: { geoTargetConstants: ['2840'], language: '1000' },
    searchConsole: { country: 'usa' },
    claudeMaxBudgetUsd: 10,
    sites: options.sites ?? [site('mixingpal.com')],
  }
  const claudeRuns: string[] = []
  let reviewRound = 0

  const writer =
    options.writer ??
    ((cwd: string) => {
      fs.mkdirSync(path.join(cwd, 'how-to-finish-a-song'), { recursive: true })
      fs.writeFileSync(path.join(cwd, 'how-to-finish-a-song', 'index.html'), GUIDE_HTML)
      return result(guideFor('how to finish a song'))
    })

  const defaults: Handler[] = [
    { match: is('gum', '--version'), result: { stdout: 'gum 2.3.1' } },
    { match: is('git', '--version'), result: { stdout: 'git version 2.50' } },
    { match: is('gh', 'auth', 'status'), result: {} },
    { match: is('claude', '--version'), result: { stdout: '2.1.310' } },
    { match: is('git', 'config', 'user.name'), result: { stdout: 'Polina\n' } },
    { match: is('git', 'config', 'user.email'), result: { stdout: 'p@example.com\n' } },
    { match: is('gh', 'config', 'get', 'git_protocol'), result: { stdout: 'https\n' } },
    { match: is('git', 'config', '--get-urlmatch'), result: { stdout: '!gh auth git-credential\n' } },
    { match: is('gh', 'pr', 'list'), result: { stdout: '[]' } },
    {
      match: is('gum', 'read', 'searchconsole.searchanalytics.query'),
      result: { stdout: JSON.stringify({ rows: [] }) },
    },
    {
      match: is('gum', 'read', 'googleads.keywordPlanIdeas.generateKeywordIdeas'),
      result: {
        stdout: JSON.stringify({
          results: [
            { text: 'how to finish a song', keywordIdeaMetrics: { avgMonthlySearches: '1900', competition: 'LOW' } },
            { text: 'ableton drop', keywordIdeaMetrics: { avgMonthlySearches: '880', competition: 'MEDIUM' } },
          ],
        }),
      },
    },
    {
      match: is('gh', 'repo', 'clone'),
      result: (_cmd, args) => {
        const clonePath = args[3]
        fs.mkdirSync(path.join(clonePath, 'how-to-arrange-a-song'), { recursive: true })
        fs.writeFileSync(path.join(clonePath, 'how-to-arrange-a-song', 'index.html'), '<h1>Arrange</h1>')
        fs.writeFileSync(path.join(clonePath, 'index.html'), '<h1>Home</h1>')
        return {}
      },
    },
    {
      match: is('claude', '-p'),
      result: (_cmd, _args, opts) => {
        const prompt = opts?.input ?? ''
        if (prompt.startsWith('You are adding')) {
          claudeRuns.push('writer')
          return writer(opts!.cwd!)
        }
        if (prompt.startsWith('You are reviewing')) {
          claudeRuns.push('reviewer')
          return result(options.reviewer ? options.reviewer(reviewRound++) : { pass: true, issues: [] })
        }
        claudeRuns.push('fixer')
        return result(options.fixer ? options.fixer(opts!.cwd!) : guideFor('how to finish a song'))
      },
    },
    { match: is('git', 'status'), result: { stdout: ' M index.html\0?? how-to-finish-a-song/index.html\0' } },
    { match: is('npm'), result: { stdout: 'built' } },
    { match: is('git'), result: {} },
    { match: is('gh', 'label', 'create'), result: {} },
    { match: is('gh', 'pr', 'create'), result: { stdout: 'https://github.com/acme/site/pull/7\n' } },
  ]

  const exec = fakeExec([...(options.handlers ?? []), ...defaults])
  const sitemapLocs = options.sitemapLocs ?? ['https://mixingpal.com/how-to-arrange-a-song/']
  const fetchText: FetchText = async (url) =>
    url.endsWith('/sitemap.xml')
      ? { status: 200, text: `<urlset>${sitemapLocs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>` }
      : { status: 404, text: '' }
  const logs: string[] = []
  const deps: Deps = { exec, fetchText, now: () => NOW, home: '/home/u', log: (line) => logs.push(line) }
  const callsTo = (cmd: string, ...prefix: string[]) => exec.calls.filter((c) => is(cmd, ...prefix)(c.cmd, c.args)).length
  return { config, deps, exec, logs, claudeRuns, callsTo }
}
