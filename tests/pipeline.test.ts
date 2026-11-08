import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { runAll, type SiteOutcome } from '../src/pipeline.js'
import { REVIEWER_TOOLS, WRITER_TOOLS } from '../src/claude.js'
import { FAILURES_FILE, LOCK_FILE, readFailures } from '../src/runState.js'
import { guideFor, makeEnv, NOW, result, site } from './pipelineEnv.js'

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']
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
    expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(1)
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
    expect(env.googleCalls.length).toBe(0)
  })

  test('aborts the run when Keyword Planner fails', async () => {
    const env = makeEnv({
      sites: [site('mixingpal.com'), site('other.com')],
      google: (url) =>
        url.includes(':generateKeywordIdeas')
          ? { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } }
          : undefined,
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'failed'])
    expect(env.callsTo('gh', 'repo', 'clone')).toBe(0)
    expect(env.callsTo('gh', 'pr', 'create')).toBe(0)
    expect(env.logs.join('\n')).toContain('Keyword Planner failed: PERMISSION_DENIED: The caller does not have permission')
  })

  test('skips a site with no candidates', async () => {
    const env = makeEnv({
      google: (url) => (url.includes(':generateKeywordIdeas') ? { status: 200, body: {} } : undefined),
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
        expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(0)
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
      handlers: [
        {
          match: (cmd, args) => cmd === 'git' && args[0] === 'status',
          result: { stdout: ' M package.json\0?? .github/workflows/x.yml\0' },
        },
      ],
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('package.json, .github/workflows/x.yml')
    expect(env.callsTo('npm')).toBe(0)
    expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(0)
  })

  test('fails the site when the build still breaks after two fixes', async () => {
    const env = makeEnv({ handlers: [{ match: (cmd) => cmd === 'npm', result: { code: 1, stderr: 'vite: missing input' } }] })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('failed')
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('build failed')
    expect(env.claudeRuns).toEqual(['writer', 'fixer', 'fixer'])
  })

  test('sends a failing build back to the fixer, then reviews and opens the PR', async () => {
    let builds = 0
    const env = makeEnv({
      handlers: [{ match: (cmd) => cmd === 'npm', result: () => (builds++ === 0 ? { code: 1, stderr: 'vite: missing input' } : { stdout: 'built' }) }],
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('opened')
    expect(env.claudeRuns).toEqual(['writer', 'fixer', 'reviewer'])
    const fixerCall = env.exec.calls.filter((c) => c.cmd === 'claude' && c.args[0] === '-p')[1]
    expect(fixerCall.opts?.input).toContain('vite: missing input')
  })

  test('gives Claude no command tools; the script runs the build itself', async () => {
    const env = makeEnv()
    await runAll(env.config, env.deps, { dryRun: true })
    const toolsOf = (i: number) => {
      const args = env.exec.calls.filter((c) => c.cmd === 'claude' && c.args[0] === '-p')[i].args
      return args[args.indexOf('--tools') + 1]
    }
    expect(toolsOf(0)).toBe(WRITER_TOOLS.tools.join(','))
    expect(toolsOf(1)).toBe(REVIEWER_TOOLS.tools.join(','))
    expect(env.callsTo('npm', 'run', 'build')).toBe(1)
  })

  test('fails the site when the writer edits an existing page instead of adding one', async () => {
    const env = makeEnv({ handlers: [{ match: (cmd, args) => cmd === 'git' && args[0] === 'cat-file', result: { code: 0 } }] })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain(
      'guide how-to-finish-a-song/index.html is an existing page',
    )
    const check = env.exec.calls.find((c) => c.cmd === 'git' && c.args[0] === 'cat-file')
    expect(check?.args).toEqual(['cat-file', '-e', 'HEAD:how-to-finish-a-song/index.html'])
    expect(env.claudeRuns).toEqual(['writer'])
  })

  test('names the branch by date when neither slug nor keyword has Latin letters', async () => {
    const keyword = 'как закончить песню'
    const env = makeEnv({
      google: (url) =>
        url.includes(':generateKeywordIdeas')
          ? { status: 200, body: { results: [{ text: keyword, keywordIdeaMetrics: { avgMonthlySearches: '900', competition: 'LOW' } }] } }
          : undefined,
      writer: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'how-to-finish-a-song'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'how-to-finish-a-song', 'index.html'), '<h2>Sources</h2>')
        return result({ ...guideFor(keyword), slug: 'как-закончить-песню' })
      },
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('opened')
    const prCreate = env.exec.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')!
    expect(prCreate.args).toContain('seo-guide/guide-2026-10-24')
  })

  test('refreshes the lock before each site, so a long run keeps it', async () => {
    let lockDuringWrite: { refreshedAt?: string } = {}
    const env = makeEnv({
      writer: (cwd) => {
        lockDuringWrite = JSON.parse(fs.readFileSync(path.join(env.config.workDir, LOCK_FILE), 'utf8'))
        fs.mkdirSync(path.join(cwd, 'how-to-finish-a-song'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'how-to-finish-a-song', 'index.html'), '<h2>Sources</h2>')
        return result(guideFor('how to finish a song'))
      },
    })
    await runAll(env.config, env.deps, { dryRun: true })
    expect(lockDuringWrite.refreshedAt).toBe(NOW.toISOString())
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
    expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(0)
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
    const env = makeEnv({ handlers: [{ match: (cmd) => cmd === 'claude', result: { code: 127 } }] })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes).toEqual([])
    expect(env.logs.join('\n')).toContain('`claude` is not installed')
    expect(env.callsTo('gh', 'pr', 'list')).toBe(0)
  })

  test('stops before any work when there is no Google login', async () => {
    const env = makeEnv()
    env.config.googleCredentials = path.join(env.config.workDir, 'missing.json')
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes).toEqual([])
    expect(env.logs.join('\n')).toContain('run `seo-driver login`')
    expect(env.callsTo('gh', 'pr', 'list')).toBe(0)
  })

  test('a Search Console failure fails only that site', async () => {
    const env = makeEnv({
      sites: [site('first.com'), site('second.com')],
      google: (url) =>
        url.includes('/searchAnalytics/query') && url.includes('first.com')
          ? { status: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'no access to property' } } }
          : undefined,
    })
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes.map((o) => [o.domain, o.status])).toEqual([
      ['first.com', 'failed'],
      ['second.com', 'opened'],
    ])
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('no access to property')
    expect(exitCode).toBe(1)
  })

  test('filters Search Console to the configured country', async () => {
    const env = makeEnv()
    await runAll(env.config, env.deps, { dryRun: true })
    const call = env.googleCalls.find((c) => c.url.includes('/searchAnalytics/query'))!
    expect(call.body).toContain('"expression":"usa"')
  })

  test('exits without work while another run holds the lock', async () => {
    const env = makeEnv()
    fs.mkdirSync(env.config.workDir, { recursive: true })
    fs.writeFileSync(path.join(env.config.workDir, LOCK_FILE), JSON.stringify({ pid: process.pid, startedAt: NOW.toISOString() }))
    const { outcomes, exitCode } = await runAll(env.config, env.deps, { dryRun: false })
    expect(exitCode).toBe(1)
    expect(outcomes).toEqual([])
    expect(env.logs.join('\n')).toContain(`another seo-driver run (pid ${process.pid}`)
    expect(env.callsTo('gh', 'pr', 'list')).toBe(0)
  })

  test('releases the lock when the run ends', async () => {
    const env = makeEnv({ writer: () => ({ code: 1, stdout: '' }) })
    await runAll(env.config, env.deps, { dryRun: false })
    expect(fs.existsSync(path.join(env.config.workDir, LOCK_FILE))).toBe(false)
  })

  test('a failed site waits out its interval before the next try', async () => {
    const env = makeEnv({ writer: () => ({ code: 1, stdout: '' }) })
    await runAll(env.config, env.deps, { dryRun: false })
    expect(readFailures(env.config.workDir)).toEqual({ 'mixingpal.com': NOW.toISOString() })
    const again = await runAll(env.config, env.deps, { dryRun: false })
    expect(again.outcomes).toEqual([
      { domain: 'mixingpal.com', status: 'skipped', reason: 'last run failed on 2026-10-24; next try 2026-10-26' },
    ])
    expect(env.claudeRuns).toEqual(['writer'])
  })

  test('a failed dry run records no failure', async () => {
    const env = makeEnv({ writer: () => ({ code: 1, stdout: '' }) })
    await runAll(env.config, env.deps, { dryRun: true })
    expect(fs.existsSync(path.join(env.config.workDir, FAILURES_FILE))).toBe(false)
  })

  test('skips the push when a guide PR opened while this run was writing', async () => {
    let lists = 0
    const env = makeEnv({
      handlers: [
        {
          match: (cmd, args) => cmd === 'gh' && args[1] === 'list',
          result: () => ({
            stdout: JSON.stringify(
              lists++ === 0 ? [] : [{ number: 9, state: 'OPEN', createdAt: '2026-10-24T07:01:00Z', url: 'u', body: '' }],
            ),
          }),
        },
      ],
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([
      { domain: 'mixingpal.com', status: 'skipped', reason: 'guide PR #9 opened while this run was writing' },
    ])
    expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(0)
    expect(fs.readdirSync(env.config.workDir)).toEqual([])
  })

  test('creates the label before the push, and deletes the pushed branch when the PR cannot open', async () => {
    const env = makeEnv({
      handlers: [{ match: (cmd, args) => cmd === 'gh' && args[0] === 'pr' && args[1] === 'create', result: { code: 1, stderr: 'HTTP 502' } }],
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('HTTP 502')
    const label = env.exec.calls.findIndex((c) => c.cmd === 'gh' && c.args[0] === 'label')
    const push = env.exec.calls.findIndex((c) => c.cmd === 'git' && c.args.includes('push'))
    expect(label).toBeLessThan(push)
    const remove = env.exec.calls.find((c) => c.cmd === 'git' && c.args.includes('--delete'))
    expect(remove?.args).toEqual([...NO_HOOKS, 'push', '--no-verify', 'origin', '--delete', 'seo-guide/how-to-finish-a-song'])
  })

  test('fails the site when the build changes a protected file', async () => {
    let built = false
    const env = makeEnv({
      handlers: [
        { match: (cmd) => cmd === 'npm', result: () => ((built = true), { stdout: 'built' }) },
        {
          match: (cmd, args) => cmd === 'git' && args[0] === 'status',
          result: () => ({ stdout: `?? how-to-finish-a-song/index.html\0${built ? ' M package-lock.json\0' : ''}` }),
        },
      ],
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain('package-lock.json')
    expect(env.callsTo('git', ...NO_HOOKS, 'push')).toBe(0)
  })

  test("keeps the writer's keyword when the fixer changes it", async () => {
    const env = makeEnv({
      reviewer: (round) => (round === 0 ? { pass: false, issues: [{ kind: 'slop', location: 'intro', detail: 'x' }] } : { pass: true, issues: [] }),
      fixer: () => ({ ...guideFor('finish songs faster'), slug: 'finish-songs-faster' }),
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status).toBe('opened')
    const prCreate = env.exec.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')!
    expect(prCreate.opts?.input).toContain('<!-- seo-driver keyword: how to finish a song -->')
    expect(prCreate.args).toContain('seo-guide/how-to-finish-a-song')
  })

  test('fails the site when the fixer moves the guide', async () => {
    const env = makeEnv({
      reviewer: () => ({ pass: false, issues: [{ kind: 'slop', location: 'intro', detail: 'x' }] }),
      fixer: (cwd) => {
        fs.mkdirSync(path.join(cwd, 'finish-a-song'), { recursive: true })
        fs.writeFileSync(path.join(cwd, 'finish-a-song', 'index.html'), '<h2>Sources</h2>')
        return { ...guideFor('how to finish a song'), guidePath: 'finish-a-song/index.html' }
      },
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes[0].status === 'failed' && outcomes[0].reason).toContain(
      'fixer moved the guide from how-to-finish-a-song/index.html to finish-a-song/index.html',
    )
  })

  test('drops topics the repo already has a page for, and removes the clone', async () => {
    const env = makeEnv({
      handlers: [
        {
          match: (cmd, args) => cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone',
          result: (_cmd, args) => {
            for (const dir of ['how-to-arrange-a-song', 'how-to-finish-a-song', 'ableton-drop']) {
              fs.mkdirSync(path.join(args[3], dir), { recursive: true })
              fs.writeFileSync(path.join(args[3], dir, 'index.html'), '<h1>x</h1>')
            }
            return {}
          },
        },
      ],
    })
    const { outcomes } = await runAll(env.config, env.deps, { dryRun: false })
    expect(outcomes).toEqual([{ domain: 'mixingpal.com', status: 'skipped', reason: 'no candidates' }])
    expect(env.claudeRuns).toEqual([])
    expect(fs.readdirSync(env.config.workDir)).toEqual([])
  })

  test('logs each Claude session with its cost', async () => {
    const env = makeEnv()
    await runAll(env.config, env.deps, { dryRun: true })
    expect(env.logs).toContain('mixingpal.com writer: claude session unknown, cost $0.00')
    expect(env.logs).toContain('mixingpal.com reviewer: claude session unknown, cost $0.00')
  })

  test('caps the covered list in the writer prompt', async () => {
    // 450 sitemap pages plus the clone's how-to-arrange-a-song.
    const env = makeEnv({ sitemapLocs: Array.from({ length: 450 }, (_, i) => `https://mixingpal.com/page-number-${i}/`) })
    await runAll(env.config, env.deps, { dryRun: true })
    const writerCall = env.exec.calls.find((c) => c.cmd === 'claude' && c.opts?.input?.startsWith('You are adding'))!
    expect(writerCall.opts?.input).toContain('- page-number-299\n')
    expect(writerCall.opts?.input).not.toContain('page-number-300\n')
    expect(writerCall.opts?.input).toContain('- (and 151 more)')
  })
})
