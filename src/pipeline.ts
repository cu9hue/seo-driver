import fs from 'node:fs'
import path from 'node:path'
import { allowedTools, guideSchema, renderPrompt, reviewerTools, reviewSchema, runClaude } from './claude.js'
import { sitemapSlugs, type FetchText } from './covered.js'
import type { Exec } from './exec.js'
import { dueCheck, listGuidePrs, openPr, renderPrBody, type GuidePr, type GuideResult, type ReviewIssue } from './github.js'
import { GumError, preflight } from './gum.js'
import { fetchKeywordIdeas } from './sources/keywordPlanner.js'
import { fetchSearchGaps } from './sources/searchConsole.js'
import { keywordTokens, shortlist } from './topics.js'
import type { Candidate, Config, SiteConfig } from './types.js'
import {
  changedFiles,
  cloneSite,
  commitAndPush,
  hasGuideTemplate,
  hasSourcesSection,
  protectedChanges,
  runBuild,
} from './workspace.js'

const MAX_FIX_ROUNDS = 2

export interface Deps {
  exec: Exec
  fetchText: FetchText
  now: () => Date
  home: string
  log: (line: string) => void
}

export type SiteOutcome =
  | { domain: string; status: 'opened'; prUrl: string }
  | { domain: string; status: 'skipped'; reason: string }
  | { domain: string; status: 'dry-run'; clonePath: string }
  | { domain: string; status: 'failed'; reason: string; clonePath?: string }

interface DueSite {
  site: SiteConfig
  prs: GuidePr[]
  gaps: Candidate[]
  ideas: Candidate[]
}

class SiteFailure extends Error {}

const sameWords = (a: string, b: string) => [...keywordTokens(a)].sort().join(' ') === [...keywordTokens(b)].sort().join(' ')
const branchSlug = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// The guide path comes from Claude, so it must stay inside the clone.
function guideFile(clonePath: string, guide: GuideResult): string {
  const file = path.resolve(clonePath, guide.guidePath)
  if (!file.startsWith(clonePath + path.sep)) throw new SiteFailure(`guide path ${guide.guidePath} is outside the repo`)
  if (!fs.existsSync(file)) throw new SiteFailure(`guide file ${guide.guidePath} does not exist`)
  return file
}

async function checkChanges(exec: Exec, clonePath: string): Promise<void> {
  const files = await changedFiles(exec, clonePath)
  if (files.length === 0) throw new SiteFailure('writer changed no files')
  const blocked = protectedChanges(files)
  if (blocked.length > 0) throw new SiteFailure(`Claude changed protected files: ${blocked.join(', ')}`)
}

async function writeGuide(
  deps: Deps,
  site: SiteConfig,
  clonePath: string,
  candidates: Candidate[],
  covered: string[],
): Promise<{ guide: GuideResult; chosen: Candidate; fixed: ReviewIssue[] }> {
  const { exec, home, log } = deps
  const coveredList = covered.map((c) => `- ${c}`).join('\n') || '- (none yet)'
  const buildCommands = site.buildCommands.join(', then ')
  const instructions = site.instructionsFile
    ? (() => {
        const file = path.join(clonePath, site.instructionsFile)
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      })()
    : ''

  log(`${site.domain}: writing a guide from ${candidates.length} candidates`)
  let guide = await runClaude<GuideResult>(exec, {
    cwd: clonePath,
    prompt: renderPrompt('writer', {
      domain: site.domain,
      shortlist: JSON.stringify(candidates, null, 2),
      covered: coveredList,
      exampleGuide: site.exampleGuide ?? '(none: follow the site-specific instructions below)',
      instructions,
      buildCommands,
    }),
    tools: allowedTools(site, home),
    schema: guideSchema,
    home,
  })

  const chosen = candidates.find((c) => sameWords(c.keyword, guide.keyword))
  if (!chosen) throw new SiteFailure(`writer picked "${guide.keyword}", which is not on the shortlist`)
  guideFile(clonePath, guide)
  await checkChanges(exec, clonePath)

  const fixed: ReviewIssue[] = []
  for (let round = 0; ; round++) {
    log(`${site.domain}: reviewing "${guide.keyword}" (round ${round + 1})`)
    const review = await runClaude<{ pass: boolean; issues: ReviewIssue[] }>(exec, {
      cwd: clonePath,
      prompt: renderPrompt('reviewer', { guidePath: guide.guidePath, keyword: guide.keyword, covered: coveredList }),
      tools: reviewerTools(site, home),
      schema: reviewSchema,
      home,
    })
    if (review.pass && review.issues.length === 0) break
    if (round === MAX_FIX_ROUNDS) {
      const kinds = [...new Set(review.issues.map((i) => i.kind))].join(', ') || 'unlisted'
      throw new SiteFailure(`review still failing after ${MAX_FIX_ROUNDS} fix rounds: ${kinds}`)
    }
    log(`${site.domain}: fixing ${review.issues.length} review issues`)
    guide = await runClaude<GuideResult>(exec, {
      cwd: clonePath,
      prompt: renderPrompt('fixer', {
        guidePath: guide.guidePath,
        issues: JSON.stringify(review.issues, null, 2),
        buildCommands,
      }),
      tools: allowedTools(site, home),
      schema: guideSchema,
      home,
    })
    guideFile(clonePath, guide)
    await checkChanges(exec, clonePath)
    fixed.push(...review.issues)
  }
  return { guide, chosen, fixed }
}

async function runSite(config: Config, deps: Deps, due: DueSite, dryRun: boolean): Promise<SiteOutcome> {
  const { site } = due
  const { exec, log } = deps
  const covered = [
    ...(await sitemapSlugs(deps.fetchText, site.domain)),
    ...due.prs.map((pr) => pr.keyword).filter((k): k is string => Boolean(k)),
  ]
  const candidates = shortlist(due.gaps, due.ideas, covered)
  if (candidates.length === 0) return { domain: site.domain, status: 'skipped', reason: 'no candidates' }

  let clonePath: string | undefined
  try {
    clonePath = await cloneSite(exec, site, config.workDir, deps.now())
    if (!hasGuideTemplate(clonePath, site)) {
      fs.rmSync(clonePath, { recursive: true, force: true })
      return { domain: site.domain, status: 'skipped', reason: 'no exampleGuide or instructionsFile in repo' }
    }

    const { guide, chosen, fixed } = await writeGuide(deps, site, clonePath, candidates, covered)

    const build = await runBuild(exec, clonePath, site)
    if (!build.ok) throw new SiteFailure(`build failed:\n${build.output.slice(-2000)}`)
    if (!hasSourcesSection(fs.readFileSync(guideFile(clonePath, guide), 'utf8'))) {
      throw new SiteFailure(`guide ${guide.guidePath} has no Sources section`)
    }

    if (dryRun) return { domain: site.domain, status: 'dry-run', clonePath }

    const branch = `seo-guide/${branchSlug(guide.slug) || branchSlug(guide.keyword)}`
    const title = `Add guide: ${guide.title}`
    await commitAndPush(exec, clonePath, branch, title)
    const prUrl = await openPr(exec, site, branch, title, renderPrBody({ site, guide, chosen, shortlist: candidates, fixed }))
    fs.rmSync(clonePath, { recursive: true, force: true })
    log(`${site.domain}: opened ${prUrl}`)
    return { domain: site.domain, status: 'opened', prUrl }
  } catch (err) {
    return { domain: site.domain, status: 'failed', reason: (err as Error).message, clonePath }
  }
}

export async function runAll(
  config: Config,
  deps: Deps,
  opts: { site?: string; dryRun: boolean },
): Promise<{ outcomes: SiteOutcome[]; exitCode: 0 | 1 }> {
  const { exec, log } = deps

  const sites = opts.site ? config.sites.filter((s) => s.domain === opts.site) : config.sites
  if (sites.length === 0) {
    log(`unknown site ${opts.site}; configured sites: ${config.sites.map((s) => s.domain).join(', ')}`)
    return { outcomes: [], exitCode: 1 }
  }

  try {
    await preflight(exec)
  } catch (err) {
    log((err as Error).message)
    return { outcomes: [], exitCode: 1 }
  }

  const outcomes: SiteOutcome[] = []
  const dueSites: DueSite[] = []
  for (const site of sites) {
    try {
      const prs = await listGuidePrs(exec, site.repo)
      const check = dueCheck(site, prs, deps.now())
      if (check.due) dueSites.push({ site, prs, gaps: [], ideas: [] })
      else outcomes.push({ domain: site.domain, status: 'skipped', reason: check.reason })
    } catch (err) {
      outcomes.push({ domain: site.domain, status: 'failed', reason: (err as Error).message })
    }
  }

  // Fetch Google data for every due site before writing anything: Keyword
  // Planner is required, so a credential problem must stop the whole run.
  for (const due of dueSites) {
    try {
      due.gaps = await fetchSearchGaps(exec, due.site, deps.now())
      due.ideas = await fetchKeywordIdeas(exec, due.site, config.keywordPlanner)
    } catch (err) {
      const reason =
        err instanceof GumError
          ? `${err.opId} failed: ${[err.errorCode, err.message].filter(Boolean).join(' ')}`
          : (err as Error).message
      log(`${due.site.domain}: ${reason}`)
      log('stopping: Google data is required before any guide is written')
      for (const d of dueSites) outcomes.push({ domain: d.site.domain, status: 'failed', reason })
      return { outcomes: sortLike(sites, outcomes), exitCode: 1 }
    }
  }

  for (const due of dueSites) outcomes.push(await runSite(config, deps, due, opts.dryRun))

  const sorted = sortLike(sites, outcomes)
  return { outcomes: sorted, exitCode: sorted.some((o) => o.status === 'failed') ? 1 : 0 }
}

function sortLike(sites: SiteConfig[], outcomes: SiteOutcome[]): SiteOutcome[] {
  const order = sites.map((s) => s.domain)
  return [...outcomes].sort((a, b) => order.indexOf(a.domain) - order.indexOf(b.domain))
}
