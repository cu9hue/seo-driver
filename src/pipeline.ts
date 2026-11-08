import fs from 'node:fs'
import path from 'node:path'
import { guideSchema, renderPrompt, REVIEWER_TOOLS, reviewSchema, runClaude, WRITER_TOOLS, writingSkillDir } from './claude.js'
import { repoSlugs, sitemapSlugs, type FetchText } from './covered.js'
import type { Exec } from './exec.js'
import {
  dueCheck,
  ensureLabel,
  listGuidePrs,
  openPr,
  renderPrBody,
  type GuidePr,
  type GuideResult,
  type ReviewIssue,
} from './github.js'
import { GumError, preflight } from './gum.js'
import { acquireLock, readFailures, recordFailure } from './runState.js'
import { fetchKeywordIdeas } from './sources/keywordPlanner.js'
import { fetchSearchGaps } from './sources/searchConsole.js'
import { keywordTokens, shortlist } from './topics.js'
import type { Candidate, Config, SiteConfig } from './types.js'
import {
  changedFiles,
  cloneSite,
  commitAndPush,
  deleteRemoteBranch,
  existsInBase,
  hasGuideTemplate,
  hasSourcesSection,
  protectedChanges,
  runBuild,
} from './workspace.js'

const MAX_FIX_ROUNDS = 2
// Every prompt carries the covered list; a large site would otherwise fill
// the context with it.
const MAX_COVERED_IN_PROMPT = 300

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

async function checkChanges(exec: Exec, clonePath: string, who: string): Promise<void> {
  const files = await changedFiles(exec, clonePath)
  if (files.length === 0) throw new SiteFailure('writer changed no files')
  const blocked = protectedChanges(files)
  if (blocked.length > 0) throw new SiteFailure(`${who} changed protected files: ${blocked.join(', ')}`)
}

function describeCovered(covered: string[]): string {
  if (covered.length === 0) return '- (none yet)'
  const shown = covered.slice(0, MAX_COVERED_IN_PROMPT).map((c) => `- ${c}`)
  if (covered.length > MAX_COVERED_IN_PROMPT) shown.push(`- (and ${covered.length - MAX_COVERED_IN_PROMPT} more)`)
  return shown.join('\n')
}

const describeError = (err: unknown) =>
  err instanceof GumError
    ? `${err.opId} failed: ${[err.errorCode, err.message].filter(Boolean).join(' ')}`
    : (err as Error).message

async function writeGuide(
  config: Config,
  deps: Deps,
  site: SiteConfig,
  clonePath: string,
  candidates: Candidate[],
  covered: string[],
): Promise<{ guide: GuideResult; chosen: Candidate; fixed: ReviewIssue[] }> {
  const { exec, home, log } = deps
  const claude = (label: string) => ({ home, maxBudgetUsd: config.claudeMaxBudgetUsd, label: `${site.domain} ${label}`, log })
  const coveredList = describeCovered(covered)
  const buildCommands = site.buildCommands.join(', then ')
  const instructions = site.instructionsFile
    ? (() => {
        const file = path.join(clonePath, site.instructionsFile)
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
      })()
    : ''

  const writingSkill = writingSkillDir(home)

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
      writingSkill,
    }),
    tools: WRITER_TOOLS,
    schema: guideSchema,
    ...claude('writer'),
  })

  const chosen = candidates.find((c) => sameWords(c.keyword, guide.keyword))
  if (!chosen) throw new SiteFailure(`writer picked "${guide.keyword}", which is not on the shortlist`)
  const relPath = path.relative(clonePath, guideFile(clonePath, guide)).split(path.sep).join('/')
  if (await existsInBase(exec, clonePath, relPath)) {
    throw new SiteFailure(`guide ${relPath} is an existing page; the writer must add a new one`)
  }
  await checkChanges(exec, clonePath, 'Claude')

  const fix = async (issues: ReviewIssue[]) => {
    const fixedGuide = await runClaude<GuideResult>(exec, {
      cwd: clonePath,
      prompt: renderPrompt('fixer', {
        guidePath: guide.guidePath,
        issues: JSON.stringify(issues, null, 2),
        buildCommands,
        writingSkill,
      }),
      tools: WRITER_TOOLS,
      schema: guideSchema,
      ...claude('fixer'),
    })
    // A moved guide would leave the first draft in the commit.
    if (path.normalize(fixedGuide.guidePath) !== path.normalize(guide.guidePath)) {
      throw new SiteFailure(`fixer moved the guide from ${guide.guidePath} to ${fixedGuide.guidePath}`)
    }
    // The PR marker records the keyword that was chosen and reviewed.
    guide = { ...fixedGuide, keyword: guide.keyword, slug: guide.slug }
    guideFile(clonePath, guide)
    await checkChanges(exec, clonePath, 'Claude')
  }

  // Claude cannot run commands, so the script builds after each Claude edit,
  // once the protected-file check has passed, and sends failures back.
  const buildOrFix = async () => {
    for (let round = 0; ; round++) {
      const build = await runBuild(exec, clonePath, site)
      // The build runs repo code, and everything it leaves is committed.
      await checkChanges(exec, clonePath, 'the build')
      if (build.ok) return
      const tail = build.output.slice(-2000)
      if (round === MAX_FIX_ROUNDS) throw new SiteFailure(`build failed:\n${tail}`)
      log(`${site.domain}: build failed; sending the errors to the fixer`)
      await fix([{ kind: 'build', location: 'build', detail: tail }])
    }
  }

  await buildOrFix()
  const fixed: ReviewIssue[] = []
  for (let round = 0; ; round++) {
    log(`${site.domain}: reviewing "${guide.keyword}" (round ${round + 1})`)
    const review = await runClaude<{ pass: boolean; issues: ReviewIssue[] }>(exec, {
      cwd: clonePath,
      prompt: renderPrompt('reviewer', { guidePath: guide.guidePath, keyword: guide.keyword, covered: coveredList, writingSkill }),
      tools: REVIEWER_TOOLS,
      schema: reviewSchema,
      ...claude('reviewer'),
    })
    if (review.pass && review.issues.length === 0) break
    if (round === MAX_FIX_ROUNDS) {
      const kinds = [...new Set(review.issues.map((i) => i.kind))].join(', ') || 'unlisted'
      throw new SiteFailure(`review still failing after ${MAX_FIX_ROUNDS} fix rounds: ${kinds}`)
    }
    log(`${site.domain}: fixing ${review.issues.length} review issues`)
    await fix(review.issues)
    await buildOrFix()
    fixed.push(...review.issues)
  }
  return { guide, chosen, fixed }
}

async function runSite(config: Config, deps: Deps, due: DueSite, dryRun: boolean): Promise<SiteOutcome> {
  const { site } = due
  const { exec } = deps
  let covered = [
    ...(await sitemapSlugs(deps.fetchText, site.domain, deps.log)),
    ...due.prs.map((pr) => pr.keyword).filter((k): k is string => Boolean(k)),
  ]
  const noCandidates: SiteOutcome = { domain: site.domain, status: 'skipped', reason: 'no candidates' }
  if (shortlist(due.gaps, due.ideas, covered).length === 0) return noCandidates

  let clonePath: string | undefined
  try {
    clonePath = await cloneSite(exec, site, config.workDir, deps.now())
    const removeClone = () => fs.rmSync(clonePath!, { recursive: true, force: true })
    if (!hasGuideTemplate(clonePath, site)) {
      removeClone()
      return { domain: site.domain, status: 'skipped', reason: 'no exampleGuide or instructionsFile in repo' }
    }
    covered = [...new Set([...covered, ...repoSlugs(clonePath)])]
    const candidates = shortlist(due.gaps, due.ideas, covered)
    if (candidates.length === 0) {
      removeClone()
      return noCandidates
    }

    const { guide, chosen, fixed } = await writeGuide(config, deps, site, clonePath, candidates, covered)
    if (!hasSourcesSection(fs.readFileSync(guideFile(clonePath, guide), 'utf8'))) {
      throw new SiteFailure(`guide ${guide.guidePath} has no Sources section`)
    }

    if (dryRun) return { domain: site.domain, status: 'dry-run', clonePath }

    // Another run, or a person, may have opened a guide PR while this one wrote.
    const open = (await listGuidePrs(exec, site.repo)).find((pr) => pr.state === 'OPEN')
    if (open) {
      removeClone()
      return { domain: site.domain, status: 'skipped', reason: `guide PR #${open.number} opened while this run was writing` }
    }

    // A slug and keyword with no Latin letters or digits would leave the branch name empty.
    const branch = `seo-guide/${branchSlug(guide.slug) || branchSlug(guide.keyword) || `guide-${deps.now().toISOString().slice(0, 10)}`}`
    const title = `Add guide: ${guide.title}`
    await ensureLabel(exec, site.repo)
    await commitAndPush(exec, clonePath, branch, title)
    let prUrl: string
    try {
      prUrl = await openPr(exec, site, branch, title, renderPrBody({ site, guide, chosen, shortlist: candidates, fixed }))
    } catch (err) {
      // A pushed branch with no PR is invisible to the next run, and its push
      // of the same branch would be rejected.
      const cleanup = await deleteRemoteBranch(exec, clonePath, branch).then(
        () => '',
        (e: Error) => `; the pushed branch ${branch} is still on GitHub: ${e.message}`,
      )
      throw new SiteFailure(`${(err as Error).message}${cleanup}`)
    }
    removeClone()
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
  const { log } = deps

  const sites = opts.site ? config.sites.filter((s) => s.domain === opts.site) : config.sites
  if (sites.length === 0) {
    log(`unknown site ${opts.site}; configured sites: ${config.sites.map((s) => s.domain).join(', ')}`)
    return { outcomes: [], exitCode: 1 }
  }

  try {
    await preflight(deps.exec)
  } catch (err) {
    log((err as Error).message)
    return { outcomes: [], exitCode: 1 }
  }

  const lock = acquireLock(config.workDir, deps.now())
  if (!lock.acquired) {
    log(`another seo-driver run (${lock.holder}) is still going; exiting`)
    return { outcomes: [], exitCode: 1 }
  }
  try {
    const outcomes = sortLike(sites, await runLocked(config, deps, sites, opts.dryRun, lock.refresh))
    return { outcomes, exitCode: outcomes.some((o) => o.status === 'failed') ? 1 : 0 }
  } finally {
    lock.release()
  }
}

async function runLocked(
  config: Config,
  deps: Deps,
  sites: SiteConfig[],
  dryRun: boolean,
  refreshLock: (now: Date) => void,
): Promise<SiteOutcome[]> {
  const { exec, log } = deps
  const outcomes: SiteOutcome[] = []
  const failures = readFailures(config.workDir)
  const dueSites: DueSite[] = []
  for (const site of sites) {
    try {
      const prs = await listGuidePrs(exec, site.repo)
      const check = dueCheck(site, prs, deps.now(), failures[site.domain])
      if (check.due) dueSites.push({ site, prs, gaps: [], ideas: [] })
      else outcomes.push({ domain: site.domain, status: 'skipped', reason: check.reason })
    } catch (err) {
      outcomes.push({ domain: site.domain, status: 'failed', reason: (err as Error).message })
    }
  }

  // Fetch Google data for every due site before writing anything. Keyword
  // Planner is required and its failure is a credential problem, so it stops
  // the whole run. Search Console is per property, so it fails only its site.
  const ready: DueSite[] = []
  for (const [i, due] of dueSites.entries()) {
    try {
      due.ideas = await fetchKeywordIdeas(exec, due.site, config.keywordPlanner)
    } catch (err) {
      const reason = describeError(err)
      log(`${due.site.domain}: ${reason}`)
      log('stopping: Keyword Planner data is required before any guide is written')
      for (const d of [...ready, ...dueSites.slice(i)]) outcomes.push({ domain: d.site.domain, status: 'failed', reason })
      return outcomes
    }
    try {
      due.gaps = await fetchSearchGaps(exec, due.site, deps.now(), config.searchConsole.country)
    } catch (err) {
      const reason = describeError(err)
      log(`${due.site.domain}: ${reason}`)
      outcomes.push({ domain: due.site.domain, status: 'failed', reason })
      continue
    }
    ready.push(due)
  }

  for (const due of ready) {
    // One site takes a few hours at most, so a run of many sites stays fresh.
    refreshLock(deps.now())
    const outcome = await runSite(config, deps, due, dryRun)
    // A failed site waits out its interval, since most failures come after
    // the Claude runs that would repeat. A dry run is a manual test and
    // records nothing.
    if (outcome.status === 'failed' && !dryRun) recordFailure(config.workDir, due.site.domain, deps.now())
    outcomes.push(outcome)
  }
  return outcomes
}

function sortLike(sites: SiteConfig[], outcomes: SiteOutcome[]): SiteOutcome[] {
  const order = sites.map((s) => s.domain)
  return [...outcomes].sort((a, b) => order.indexOf(a.domain) - order.indexOf(b.domain))
}
