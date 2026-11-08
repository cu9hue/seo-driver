import { describe, expect, test } from 'vitest'
import { deniedTools, renderPrompt, REVIEWER_TOOLS, runClaude, WRITER_TOOLS } from '../src/claude.js'
import { fakeExec, is } from './fakeExec.js'

describe('tool sets', () => {
  test('the writer can read, edit and research, but has no command tools', () => {
    expect(WRITER_TOOLS.tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
    expect(WRITER_TOOLS.allow).toContain('Edit(./**)')
  })

  test('the reviewer cannot edit', () => {
    expect(REVIEWER_TOOLS.tools).toEqual(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'])
    expect(REVIEWER_TOOLS.allow.some((t) => t.startsWith('Edit'))).toBe(false)
  })

  test('no allow rule reaches outside the clone', () => {
    // A bare Glob or Grep rule lets Claude search any file on the machine.
    for (const allow of [...WRITER_TOOLS.allow, ...REVIEWER_TOOLS.allow]) expect(['Glob', 'Grep']).not.toContain(allow)
  })

  test('denies edits inside .git, where hooks and config would run as the user', () => {
    expect(deniedTools()).toEqual(['Edit(./.git/**)'])
  })
})

describe('runClaude', () => {
  const schema = { type: 'object' }
  const base = { cwd: '/c', prompt: 'p', tools: REVIEWER_TOOLS, schema, home: '/h', maxBudgetUsd: 7.5, label: 'writer', log: () => {} }

  test('runs headless with the allowlist and returns structured_output', async () => {
    const exec = fakeExec([
      {
        match: is('claude', '-p'),
        result: { stdout: JSON.stringify({ type: 'result', is_error: false, structured_output: { pass: true, issues: [] } }) },
      },
    ])
    const result = await runClaude<{ pass: boolean }>(exec, {
      ...base,
      cwd: '/clone',
      prompt: 'review it',
      tools: REVIEWER_TOOLS,
      home: '/home/u',
    })
    expect(result).toEqual({ pass: true, issues: [] })
    const call = exec.calls[0]
    expect(call.opts).toEqual({ cwd: '/clone', input: 'review it', timeoutMs: 45 * 60 * 1000 })
    const args = call.args
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json'])
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('manual')
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('7.5')
    // --restricted ignores settings files, drops command tools, and confines
    // file tools to the clone and --add-dir.
    expect(args).toContain('--restricted')
    expect(args).toContain('--strict-mcp-config')
    expect(args[args.indexOf('--tools') + 1]).toBe(REVIEWER_TOOLS.tools.join(','))
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(REVIEWER_TOOLS.allow.join(','))
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(deniedTools().join(','))
    expect(args).not.toContain('--dangerously-skip-permissions')
    // User hooks (e.g. a command-rewriting PreToolUse hook) must not run or
    // change commands inside the allowlist.
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    // The writing skill's reference files sit outside the clone.
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/home/u/.claude/skills/writing')
  })

  test('logs the session id and cost, even for a failed run', async () => {
    const logs: string[] = []
    const exec = fakeExec([
      {
        match: is('claude', '-p'),
        result: { stdout: JSON.stringify({ is_error: true, result: 'budget reached', session_id: 'abc-123', total_cost_usd: 7.512 }) },
      },
    ])
    await expect(runClaude(exec, { ...base, log: (l: string) => logs.push(l) })).rejects.toThrow('budget reached')
    expect(logs).toEqual(['writer: claude session abc-123, cost $7.51'])
  })

  test('throws when is_error is true', async () => {
    const exec = fakeExec([
      { match: is('claude', '-p'), result: { stdout: JSON.stringify({ is_error: true, result: 'max turns reached' }) } },
    ])
    await expect(runClaude(exec, base)).rejects.toThrow('max turns reached')
  })

  test('throws when structured_output is missing', async () => {
    const exec = fakeExec([{ match: is('claude', '-p'), result: { stdout: JSON.stringify({ is_error: false, result: 'done' }) } }])
    await expect(runClaude(exec, base)).rejects.toThrow('structured_output')
  })

  test('throws when claude exits non-zero', async () => {
    const exec = fakeExec([{ match: is('claude', '-p'), result: { code: 1, stderr: 'not logged in' } }])
    await expect(runClaude(exec, base)).rejects.toThrow('not logged in')
  })
})

describe('renderPrompt', () => {
  const writerVars = {
    domain: 'mixingpal.com',
    shortlist: '[]',
    covered: '- how-to-arrange-a-song',
    exampleGuide: 'how-to-arrange-a-song/index.html',
    instructions: '',
    buildCommands: 'npm ci, then npm run build',
    writingSkill: '/home/u/.claude/skills/writing',
  }

  test('fills every placeholder in the writer prompt', () => {
    const prompt = renderPrompt('writer', writerVars)
    expect(prompt).not.toContain('{{')
    expect(prompt).toContain('mixingpal.com')
    expect(prompt).toContain('how-to-arrange-a-song/index.html')
    expect(prompt).toContain('/home/u/.claude/skills/writing/SKILL.md')
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
    const writingSkill = '/home/u/.claude/skills/writing'
    expect(renderPrompt('reviewer', { guidePath: 'g/index.html', keyword: 'k', covered: '-', writingSkill })).not.toContain('{{')
    expect(renderPrompt('fixer', { guidePath: 'g/index.html', issues: '[]', buildCommands: 'npm run build', writingSkill })).not.toContain('{{')
  })
})
