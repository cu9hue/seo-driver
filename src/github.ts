import type { Exec } from './exec.js'
import type { Candidate, SiteConfig } from './types.js'

export const GUIDE_LABEL = 'seo-guide'
const DAY_MS = 24 * 60 * 60 * 1000
const MARKER = /<!-- seo-driver keyword: (.+?) -->/

export interface GuidePr {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  url: string
  keyword?: string
}

export interface GuideResult {
  keyword: string
  title: string
  slug: string
  guidePath: string
  sources: string[]
  linkedFrom: string[]
  reason: string
}

export interface ReviewIssue {
  kind: 'unsourced-claim' | 'wrong-claim' | 'slop' | 'overlap' | 'other' | 'build'
  location: string
  detail: string
}

async function gh(exec: Exec, args: string[], input?: string): Promise<string> {
  const result = await exec('gh', args, { input })
  if (result.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export async function listGuidePrs(exec: Exec, repo: string): Promise<GuidePr[]> {
  const stdout = await gh(exec, [
    'pr', 'list', '--repo', repo, '--label', GUIDE_LABEL, '--state', 'all', '--limit', '1000',
    '--json', 'number,state,createdAt,url,body',
  ])
  const rows = JSON.parse(stdout) as Array<Omit<GuidePr, 'keyword'> & { body: string }>
  return rows.map(({ body, ...pr }) => ({ ...pr, keyword: MARKER.exec(body ?? '')?.[1] }))
}

const utcDay = (d: Date) => Math.floor(d.getTime() / DAY_MS)

const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

// Compares calendar days (UTC), so a daily run at a fixed hour stays on
// schedule even when the previous PR opened a few minutes later in the day.
// A failed run counts like an opened PR, so a broken site does not repeat its
// Claude runs every day.
export function dueCheck(
  site: SiteConfig,
  prs: GuidePr[],
  now: Date,
  lastFailure?: string,
): { due: true } | { due: false; reason: string } {
  const open = prs.find((pr) => pr.state === 'OPEN')
  if (open) return { due: false, reason: `guide PR #${open.number} is still open` }

  const newestPr = Math.max(...prs.map((pr) => Date.parse(pr.createdAt)))
  const failed = lastFailure ? Date.parse(lastFailure) : -Infinity
  const newest = Math.max(newestPr, failed)
  if (!Number.isFinite(newest)) return { due: true }
  const dueDay = utcDay(new Date(newest)) + site.intervalDays
  if (utcDay(now) >= dueDay) return { due: true }
  if (failed > newestPr) {
    return { due: false, reason: `last run failed on ${isoDay(utcDay(new Date(failed)))}; next try ${isoDay(dueDay)}` }
  }
  return { due: false, reason: `next guide due ${isoDay(dueDay)}` }
}

function describeNumbers(c: Candidate): string {
  if (c.source === 'search-console') {
    return `Search Console: ${c.impressions ?? 0} impressions, ${c.clicks ?? 0} clicks, average position ${c.position ?? 'unknown'} (last 28 days)`
  }
  return `Keyword Planner: ${c.avgMonthlySearches ?? 0} searches a month, ${c.competition ?? 'unknown'} competition`
}

// Search text comes from anyone who can make a query appear, so it is shown
// as code: no @mentions, links or formatting.
const inert = (text: string) => `\`${text.replace(/`/g, '')}\``

const bullets = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty)

export function renderPrBody(input: {
  site: SiteConfig
  guide: GuideResult
  chosen: Candidate
  shortlist: Candidate[]
  fixed: ReviewIssue[]
}): string {
  const { guide, chosen, shortlist, fixed } = input
  const runnerUps = shortlist.filter((c) => c !== chosen).map((c) => `${inert(c.keyword)} (${describeNumbers(c)})`)
  return [
    `<!-- seo-driver keyword: ${guide.keyword} -->`,
    '## Target keyword',
    inert(chosen.keyword),
    describeNumbers(chosen),
    '## Why this one',
    guide.reason,
    '## Runner-ups',
    bullets(runnerUps, 'None.'),
    '## Sources',
    bullets(guide.sources, 'None listed.'),
    '## Linked from',
    bullets(guide.linkedFrom, 'No pages.'),
    '## Review pass',
    bullets(fixed.map((i) => `${i.kind}: ${i.detail}`), 'No issues found.'),
    '',
    `Opened by seo-driver for ${input.site.domain}. Review, adjust, and merge to publish.`,
  ].join('\n\n')
}

export async function ensureLabel(exec: Exec, repo: string): Promise<void> {
  await gh(exec, ['label', 'create', GUIDE_LABEL, '--repo', repo, '--force', '--color', '1D76DB'])
}

export async function openPr(exec: Exec, site: SiteConfig, branch: string, title: string, body: string): Promise<string> {
  const stdout = await gh(
    exec,
    [
      'pr', 'create', '--repo', site.repo, '--base', site.baseBranch, '--head', branch, '--title', title,
      '--label', GUIDE_LABEL, '--body-file', '-',
    ],
    body,
  )
  return stdout.trim()
}
