import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { runAll, type SiteOutcome } from '../src/pipeline.js'
import { guideFor, makeEnv, site } from './pipelineEnv.js'

const clonePathOf = (outcome: SiteOutcome) => ('clonePath' in outcome ? outcome.clonePath : undefined)

describe('runAll', () => {
  test('opens a PR for a due site', async () => {
    const env = makeEnv()
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([{ domain: 'mixingpal.com', status: 'opened', prUrl: 'https://github.com/acme/site/pull/7' }])
    expect(exitCode).toBe(0)
    expect(env.claudeRuns).toEqual(['writer', 'reviewer'])
    const prCreate = env.exec.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')!
    expect(prCreate.args).toContain('seo-guide/how-to-finish-a-song')
    expect(prCreate.args).toContain('Add guide: How to Finish a Song')
    expect(prCreate.opts?.input).toContain('<!-- seo-driver keyword: how to finish a song -->')
    expect(env.callsTo('git', 'push')).toBe(1)
    expect(fs.readdirSync(env.config.workDir)).toEqual([])
  })

  test('skips a site with an open guide PR', async () => {
    const env = makeEnv({
      handlers: [
        {
          match: (cmd, args) => cmd === 'gh' && args[1] === 'list',
          result: { stdout: JSON.stringify([{ number: 12, state: 'OPEN', createdAt: '2026-10-20T07:00:00Z', url: 'u', body: '' }]) },
        },
      ],
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([{ domain: 'mixingpal.com', status: 'skipped', reason: 'guide PR #12 is still open' }])
    expect(exitCode).toBe(0)
    expect(env.callsTo('gum', 'read')).toBe(0)
  })

  test('aborts the run when Keyword Planner fails', async () => {
    const env = makeEnv({
      sites: [site('mixingpal.com'), site('other.com')],
      handlers: [
        {
          match: (cmd, args) => cmd === 'gum' && args[1] === 'googleads.keywordPlanIdeas.generateKeywordIdeas',
          result: { code: 1, stderr: '{"error_code":"PERMISSION_DENIED","message":"developer token not approved"}' },
        },
      ],
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'failed'])
    expect(env.callsTo('gh', 'repo', 'clone')).toBe(0)
    expect(env.callsTo('gh', 'pr', 'create')).toBe(0)
    expect(env.logs.join('\n')).toContain('googleads.keywordPlanIdeas.generateKeywordIdeas failed: PERMISSION_DENIED developer token not approved')
  })

  test('skips a site with no candidates', async () => {
    const env = makeEnv({
      handlers: [
        {
          match: (cmd, args) => cmd === 'gum' && args[1] === 'googleads.keywordPlanIdeas.generateKeywordIdeas',
          result: { stdout: '{}' },
        },
      ],
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([{ domain: 'mixingpal.com', status: 'skipped', reason: 'no candidates' }])
    expect(exitCode).toBe(0)
    expect(env.callsTo('gh', 'repo', 'clone')).toBe(0)
  })

  test('skips a site whose repo lacks the example guide, and removes the clone', async () => {
    const env = makeEnv({ sites: [site('mixingpal.com', { exampleGuide: 'missing/index.html' })] })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([
      { domain: 'mixingpal.com', status: 'skipped', reason: 'no exampleGuide or instructionsFile in repo' },
    ])
    expect(exitCode).toBe(0)
    expect(fs.readdirSync(env.config.workDir)).toEqual([])
  })

  describe('fails the site when the writer output is unusable', () => {
    const variants = {
      'claude exits 1': () => ({ code: 1, stdout: '' }),
      'no structured_output': () => ({ stdout: JSON.stringify({ is_error: false, result: 'done' }) }),
      'guidePath missing on disk': () => ({
        stdout: JSON.stringify({ is_error: false, structured_output: guideFor('how to finish a song') }),
      }),
      'keyword not in the shortlist': (cwd: string) => {
        fs.mkdirSync(`${cwd}/how-to-finish-a-song`, { recursive: true })
        fs.writeFileSync(`${cwd}/how-to-finish-a-song/index.html`, '<h2>Sources</h2>')
        return { stdout: JSON.stringify({ is_error: false, structured_output: guideFor('best laptop for music') }) }
      },
      'guidePath outside the clone': () => ({
        stdout: JSON.stringify({
          is_error: false,
          structured_output: { ...guideFor('how to finish a song'), guidePath: '../../etc/hosts' },
        }),
      }),
    }
    for (const [name, writer] of Object.entries(variants)) {
      test(name, async () => {
        const env = makeEnv({ writer })
        const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
        expect(exitCode).toBe(1)
        expect(outcomes[0].status).toBe('failed')
        const clone = clonePathOf(outcomes[0])
        expect(clone && fs.existsSync(clone)).toBe(true)
        expect(env.callsTo('gh', 'pr', 'create')).toBe(0)
        expect(env.callsTo('git', 'push')).toBe(0)
      })
    }
  })

  test('fixes review issues and lists them in the PR', async () => {
    const env = makeEnv({
      reviewer: (round) =>
        round === 0
          ? { pass: false, issues: [{ kind: 'slop', location: 'intro', detail: 'Stock opener.' }] }
          : { pass: true, issues: [] },
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('opened')
    expect(env.claudeRuns).toEqual(['writer', 'reviewer', 'fixer', 'reviewer'])
    const prCreate = env.exec.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')!
    expect(prCreate.opts?.input).toContain('slop: Stock opener.')
  })

  test('stops after two fix rounds', async () => {
    const env = makeEnv({
      reviewer: () => ({ pass: false, issues: [{ kind: 'unsourced-claim', location: 'p2', detail: 'No source.' }] }),
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(env.claudeRuns.filter((r) => r === 'fixer').length).toBe(2)
    expect(outcomes[0].status).toBe('failed')
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('unsourced-claim')
    expect(exitCode).toBe(1)
    expect(env.callsTo('gh', 'pr', 'create')).toBe(0)
  })

  test('fails the site when Claude touches a workflow or package file', async () => {
    const env = makeEnv({
      handlers: [{ match: (cmd, args) => cmd === 'git' && args[0] === 'status', result: { stdout: ' M package.json\n?? .github/\n' } }],
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('package.json, .github/')
    expect(env.callsTo('npm')).toBe(0)
    expect(env.callsTo('git', 'push')).toBe(0)
  })

  test('fails the site when the build breaks', async () => {
    const env = makeEnv({ handlers: [{ match: (cmd) => cmd === 'npm', result: { code: 1, stderr: 'vite: missing input' } }] })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('failed')
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('build failed')
  })

  test('fails the site when the guide has no Sources section', async () => {
    const env = makeEnv({
      writer: (cwd) => {
        fs.mkdirSync(`${cwd}/how-to-finish-a-song`, { recursive: true })
        fs.writeFileSync(`${cwd}/how-to-finish-a-song/index.html`, '<h1>No sources here</h1>')
        return { stdout: JSON.stringify({ is_error: false, structured_output: guideFor('how to finish a song') }) }
      },
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('Sources')
  })

  test('dry run makes no push and no PR, and keeps the clone', async () => {
    const env = makeEnv()
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: true })
    expect(outcomes[0].status).toBe('dry-run')
    expect(fs.existsSync(clonePathOf(outcomes[0])!)).toBe(true)
    expect(exitCode).toBe(0)
    expect(env.callsTo('git', 'push')).toBe(0)
    expect(env.callsTo('gh', 'pr', 'create')).toBe(0)
  })

  test('one failing site does not stop the next', async () => {
    let writes = 0
    const env = makeEnv({
      sites: [site('first.com'), site('second.com')],
      writer: (cwd) => {
        if (writes++ === 0) return { code: 1, stdout: '' }
        fs.mkdirSync(`${cwd}/how-to-finish-a-song`, { recursive: true })
        fs.writeFileSync(`${cwd}/how-to-finish-a-song/index.html`, '<h2>Sources</h2>')
        return { stdout: JSON.stringify({ is_error: false, structured_output: guideFor('how to finish a song') }) }
      },
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes.map((o) => [o.domain, o.status])).toEqual([
      ['first.com', 'failed'],
      ['second.com', 'opened'],
    ])
    expect(exitCode).toBe(1)
  })

  test('runs only the --site domain', async () => {
    const env = makeEnv({ sites: [site('first.com'), site('second.com')] })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: true, site: 'second.com' })
    expect(outcomes.map((o) => o.domain)).toEqual(['second.com'])
  })

  test('stops before any work when preflight fails', async () => {
    const env = makeEnv({ handlers: [{ match: (cmd) => cmd === 'gum', result: { code: 127 } }] })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes).toEqual([])
    expect(env.logs.join('\n')).toContain('`gum` is not installed')
    expect(env.callsTo('gh', 'pr', 'list')).toBe(0)
  })
})
