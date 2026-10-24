import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { SiteConfig } from '../src/types.js'
import { changedFiles, cloneSite, commitAndPush, hasGuideTemplate, hasSourcesSection, runBuild } from '../src/workspace.js'
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
  test('returns paths from porcelain status', async () => {
    const exec = fakeExec([
      { match: is('git', 'status'), result: { stdout: ' M index.html\n?? arrange-song/index.html\n M public/sitemap.xml\n' } },
    ])
    expect(await changedFiles(exec, '/clone')).toEqual(['index.html', 'arrange-song/index.html', 'public/sitemap.xml'])
    expect(exec.calls[0].opts?.cwd).toBe('/clone')
  })
})

describe('commitAndPush', () => {
  test('branches, commits everything and pushes', async () => {
    const exec = fakeExec([{ match: is('git'), result: {} }])
    await commitAndPush(exec, '/clone', 'seo-guide/arrange-song', 'Add guide: Arrange')
    expect(exec.calls.map((c) => c.args)).toEqual([
      ['checkout', '-b', 'seo-guide/arrange-song'],
      ['add', '-A'],
      ['commit', '-m', 'Add guide: Arrange'],
      ['push', '-u', 'origin', 'seo-guide/arrange-song'],
    ])
    expect(exec.calls.every((c) => c.opts?.cwd === '/clone')).toBe(true)
  })

  test('stops at the first failing git command', async () => {
    const exec = fakeExec([
      { match: is('git', 'push'), result: { code: 1, stderr: 'permission denied' } },
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
    expect(exec.calls.every((c) => c.opts?.cwd === '/clone')).toBe(true)
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
    ['<h2>Resources</h2>', false],
    ['<p>Sources: none</p>', false],
  ])('%s → %s', (html, expected) => {
    expect(hasSourcesSection(html)).toBe(expected)
  })
})
