import { describe, expect, test } from 'vitest'
import { allowedTools, deniedTools, renderPrompt, reviewerTools, runClaude } from '../src/claude.js'
import type { SiteConfig } from '../src/types.js'
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

describe('allowedTools', () => {
  test('allows file edits in the clone, research, the writing skill and the build', () => {
    const tools = allowedTools(site, '/home/u')
    expect(tools).toContain('Edit(./**)')
    expect(tools).toContain('WebFetch')
    expect(tools).toContain('Bash(npm ci)')
    expect(tools).toContain('Bash(npm run build)')
    expect(tools.some((t) => /^Bash\((git|gh|gum)\b/.test(t))).toBe(false)
  })

  test('reviewer tools cannot edit or run commands', () => {
    const tools = reviewerTools(site, '/home/u')
    expect(tools).toContain('Read(./**)')
    expect(tools).toContain('WebFetch')
    expect(tools.some((t) => t.startsWith('Edit') || t.startsWith('Write') || t.startsWith('Bash'))).toBe(false)
  })

  test('denies git, gh and gum outright', () => {
    expect(deniedTools()).toEqual(expect.arrayContaining(['Bash(git *)', 'Bash(gh *)', 'Bash(gum *)']))
  })

  test('denies edits inside .git, where hooks and config would run as the user', () => {
    expect(deniedTools()).toEqual(expect.arrayContaining(['Edit(./.git/**)', 'Write(./.git/**)']))
  })
})

describe('runClaude', () => {
  const schema = { type: 'object' }

  test('runs headless with the allowlist and returns structured_output', async () => {
    const exec = fakeExec([
      {
        match: is('claude', '-p'),
        result: { stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: { pass: true, issues: [] } }) },
      },
    ])
    const result = await runClaude<{ pass: boolean }>(exec, {
      cwd: '/clone',
      prompt: 'review it',
      tools: ['Read(./**)', 'WebFetch'],
      schema,
      home: '/home/u',
    })
    expect(result).toEqual({ pass: true, issues: [] })
    const call = exec.calls[0]
    expect(call.opts).toEqual({ cwd: '/clone', input: 'review it' })
    const args = call.args
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read(./**),WebFetch')
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(deniedTools().join(','))
    expect(args).not.toContain('--dangerously-skip-permissions')
    // User hooks (e.g. a command-rewriting PreToolUse hook) must not run or
    // change commands inside the allowlist.
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    // The writing skill's reference files sit outside the clone.
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/home/u/.claude/skills/writing')
  })

  test('throws when is_error is true', async () => {
    const exec = fakeExec([
      { match: is('claude', '-p'), result: { stdout: JSON.stringify({ is_error: true, result: 'max turns reached' }) } },
    ])
    await expect(runClaude(exec, { cwd: '/c', prompt: 'p', tools: [], schema, home: '/h' })).rejects.toThrow('max turns reached')
  })

  test('throws when structured_output is missing', async () => {
    const exec = fakeExec([{ match: is('claude', '-p'), result: { stdout: JSON.stringify({ is_error: false, result: 'done' }) } }])
    await expect(runClaude(exec, { cwd: '/c', prompt: 'p', tools: [], schema, home: '/h' })).rejects.toThrow('structured_output')
  })

  test('throws when claude exits non-zero', async () => {
    const exec = fakeExec([{ match: is('claude', '-p'), result: { code: 1, stderr: 'not logged in' } }])
    await expect(runClaude(exec, { cwd: '/c', prompt: 'p', tools: [], schema, home: '/h' })).rejects.toThrow('not logged in')
  })
})

describe('renderPrompt', () => {
  const writerVars = {
    domain: 'mixingpal.com',
    shortlist: '[]',
    covered: '- how-to-arrange-a-song',
    exampleGuide: 'how-to-arrange-a-song/index.html',
    instructions: '',
    buildCommands: 'npm ci, npm run build',
  }

  test('fills every placeholder in the writer prompt', () => {
    const prompt = renderPrompt('writer', writerVars)
    expect(prompt).not.toContain('{{')
    expect(prompt).toContain('mixingpal.com')
    expect(prompt).toContain('how-to-arrange-a-song/index.html')
  })

  test('does not expand placeholders inside values', () => {
    const prompt = renderPrompt('writer', { ...writerVars, instructions: 'keep {{domain}} literal' })
    expect(prompt).toContain('keep {{domain}} literal')
  })

  test('throws when a variable is missing', () => {
    const { domain: _, ...rest } = writerVars
    expect(() => renderPrompt('writer', rest)).toThrow('domain')
  })

  test('fills the reviewer and fixer prompts', () => {
    expect(renderPrompt('reviewer', { guidePath: 'g/index.html', keyword: 'k', covered: '-' })).not.toContain('{{')
    expect(renderPrompt('fixer', { guidePath: 'g/index.html', issues: '[]', buildCommands: 'npm run build' })).not.toContain('{{')
  })
})
