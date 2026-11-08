import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { SiteConfig } from '../src/types.js'
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
} from '../src/workspace.js'
import { fakeExec, is } from './fakeExec.js'

const site: SiteConfig = {
  domain: 'mixingpal.com',
  repo: 'antithetical-labs/mixing-pal-landing',
  baseBranch: 'main',
  intervalDays: 2,
  seedKeywords: [],
  buildCommands: ['npm ci', 'npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}

describe('cloneSite', () => {
  test('shallow-clones the base branch into a timestamped folder', async () => {
    const exec = fakeExec([{ match: is('gh', 'repo', 'clone'), result: {} }])
    const clone = await cloneSite(exec, site, '/work', new Date('2026-10-24T08:30:00Z'))
    expect(clone).toBe(path.join('/work', 'mixingpal.com-20261024083000'))
    expect(exec.calls[0].args).toEqual([
      'repo', 'clone', 'antithetical-labs/mixing-pal-landing', clone, '--', '--depth', '1', '--branch', 'main',
    ])
  })

  test('removes older clones of the same site only', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-work-'))
    for (const dir of ['mixingpal.com-20261020070000', 'mixingpal.com.au-20261020070000', 'other.com-20261020070000', 'mixingpal.com-notes']) {
      fs.mkdirSync(path.join(workDir, dir))
    }
    const exec = fakeExec([{ match: is('gh', 'repo', 'clone'), result: {} }])
    await cloneSite(exec, site, workDir, new Date('2026-10-24T08:30:00Z'))
    expect(fs.readdirSync(workDir).sort()).toEqual(['mixingpal.com-notes', 'mixingpal.com.au-20261020070000', 'other.com-20261020070000'])
  })

  test('throws when the clone fails', async () => {
    const exec = fakeExec([{ match: is('gh', 'repo', 'clone'), result: { code: 1, stderr: 'repository not found' } }])
    await expect(cloneSite(exec, site, '/work', new Date())).rejects.toThrow('repository not found')
  })
})

describe('hasGuideTemplate', () => {
  test('true only when the example guide or instructions file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-clone-'))
    expect(hasGuideTemplate(dir, site)).toBe(false)
    fs.writeFileSync(path.join(dir, 'SEO.md'), 'how to add a guide')
    expect(hasGuideTemplate(dir, { ...site, exampleGuide: undefined, instructionsFile: 'SEO.md' })).toBe(true)
    fs.mkdirSync(path.join(dir, 'how-to-arrange-a-song'))
    fs.writeFileSync(path.join(dir, 'how-to-arrange-a-song', 'index.html'), '<h1>x</h1>')
    expect(hasGuideTemplate(dir, site)).toBe(true)
  })
})

describe('changedFiles', () => {
  test('lists every untracked file, unquoted, including both sides of a rename', async () => {
    const stdout = [
      ' M index.html',
      '?? newpkg/package.json',
      '?? .github/workflows/a b.yml',
      'R  renamed.html',
      'package.json',
      '',
    ].join('\0')
    const exec = fakeExec([{ match: is('git', 'status'), result: { stdout } }])
    expect(await changedFiles(exec, '/clone')).toEqual([
      'index.html',
      'newpkg/package.json',
      '.github/workflows/a b.yml',
      'renamed.html',
      'package.json',
    ])
    expect(exec.calls[0].args).toEqual(['status', '--porcelain', '-uall', '-z'])
    expect(exec.calls[0].opts?.cwd).toBe('/clone')
  })

  test('a real repo: a new folder holding package.json is caught', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-repo-'))
    const { realExec } = await import('../src/exec.js')
    await realExec('git', ['init', '-q'], { cwd: repo })
    fs.mkdirSync(path.join(repo, 'newpkg'))
    fs.writeFileSync(path.join(repo, 'newpkg', 'package.json'), '{}')
    expect(protectedChanges(await changedFiles(realExec, repo))).toEqual(['newpkg/package.json'])
  })
})

describe('existsInBase', () => {
  test('a real repo: tells a committed file from a new one', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-repo-'))
    const { realExec } = await import('../src/exec.js')
    await realExec('git', ['init', '-q'], { cwd: repo })
    fs.mkdirSync(path.join(repo, 'old-guide'))
    fs.writeFileSync(path.join(repo, 'old-guide', 'index.html'), 'old')
    await realExec('git', ['add', '-A'], { cwd: repo })
    await realExec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'], { cwd: repo })
    fs.writeFileSync(path.join(repo, 'old-guide', 'index.html'), 'rewritten')
    fs.mkdirSync(path.join(repo, 'new-guide'))
    fs.writeFileSync(path.join(repo, 'new-guide', 'index.html'), 'new')
    expect(await existsInBase(realExec, repo, 'old-guide/index.html')).toBe(true)
    expect(await existsInBase(realExec, repo, 'new-guide/index.html')).toBe(false)
  })
})

describe('deleteRemoteBranch', () => {
  test('deletes the pushed branch without running hooks', async () => {
    const exec = fakeExec([{ match: is('git'), result: {} }])
    await deleteRemoteBranch(exec, '/clone', 'seo-guide/arrange-song')
    expect(exec.calls[0].args).toEqual(['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', 'origin', '--delete', 'seo-guide/arrange-song'])
    expect(exec.calls[0].opts?.cwd).toBe('/clone')
  })
})

describe('commitAndPush', () => {
  // --no-verify skips only some hooks; post-checkout, post-commit and
  // reference-transaction would still run from a hooks path the build set.
  test('branches, commits everything and pushes, with no hooks', async () => {
    const exec = fakeExec([{ match: is('git'), result: {} }])
    await commitAndPush(exec, '/clone', 'seo-guide/arrange-song', 'Add guide: Arrange')
    expect(exec.calls.map((c) => c.args)).toEqual([
      ['-c', 'core.hooksPath=/dev/null', 'checkout', '-b', 'seo-guide/arrange-song'],
      ['-c', 'core.hooksPath=/dev/null', 'add', '-A'],
      ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', 'Add guide: Arrange'],
      ['-c', 'core.hooksPath=/dev/null', 'push', '--no-verify', '-u', 'origin', 'seo-guide/arrange-song'],
    ])
    expect(exec.calls.every((c) => c.opts?.cwd === '/clone')).toBe(true)
  })

  test('stops at the first failing git command', async () => {
    const exec = fakeExec([
      { match: (cmd, args) => cmd === 'git' && args.includes('push'), result: { code: 1, stderr: 'permission denied' } },
      { match: is('git'), result: {} },
    ])
    await expect(commitAndPush(exec, '/clone', 'b', 'm')).rejects.toThrow('permission denied')
  })
})

describe('runBuild', () => {
  test('runs each command in the clone', async () => {
    const exec = fakeExec([{ match: is('npm'), result: { stdout: 'ok' } }])
    expect((await runBuild(exec, '/clone', site)).ok).toBe(true)
    expect(exec.calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ['npm', 'ci'],
      ['npm', 'run', 'build'],
    ])
    expect(exec.calls.every((c) => c.opts?.cwd === '/clone' && c.opts?.timeoutMs === 15 * 60 * 1000)).toBe(true)
  })

  test('stops at the first failing command and returns its output', async () => {
    const exec = fakeExec([
      { match: is('npm', 'ci'), result: { code: 1, stderr: 'ERESOLVE could not resolve' } },
      { match: is('npm'), result: {} },
    ])
    const result = await runBuild(exec, '/clone', site)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('ERESOLVE')
    expect(exec.calls.length).toBe(1)
  })
})

describe('hasSourcesSection', () => {
  test.each([
    ['<h2 id="s">Sources</h2>', true],
    ['<h3 class="x">sources</h3>', true],
    ['<h2>\n  Sources\n</h2>', true],
    ['## Sources\n', true],
    ['<h2 id="sources"><a href="#sources">Sources</a></h2>', true],
    ['<h2><span class="step-kicker">Notes</span> Sources</h2>', false],
    ['<h2>Sources and further reading</h2>', true],
    ['## Sources and further reading\n', true],
    ['<h2>Resources</h2>', false],
    ['<h2>Sourcing samples</h2>', false],
    ['<p>Sources: none</p>', false],
  ])('%s → %s', (html, expected) => {
    expect(hasSourcesSection(html)).toBe(expected)
  })
})

describe('protectedChanges', () => {
  test('flags workflows, package manifests, lockfiles and npm config at any depth', () => {
    const files = [
      'index.html',
      'vite.config.ts',
      'public/sitemap.xml',
      'how-to-finish-a-song/index.html',
      '.github/workflows/deploy.yml',
      '.github/',
      'package.json',
      'worker/package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      '.npmrc',
    ]
    expect(protectedChanges(files)).toEqual([
      '.github/workflows/deploy.yml',
      '.github/',
      'package.json',
      'worker/package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      '.npmrc',
    ])
  })
})
