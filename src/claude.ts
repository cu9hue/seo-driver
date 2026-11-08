import fs from 'node:fs'
import path from 'node:path'
import type { Exec } from './exec.js'

const CLAUDE_TIMEOUT_MS = 45 * 60 * 1000
export const writingSkillDir = (home: string) => path.join(home, '.claude', 'skills', 'writing')

export interface ToolSet {
  // The only tools Claude has. No command tools: the script runs the build.
  tools: string[]
  // What Claude may use without asking. Glob and Grep need no rule inside
  // the clone; a bare rule would let them search the whole machine.
  allow: string[]
}

export const WRITER_TOOLS: ToolSet = {
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  allow: ['Read(./**)', 'Edit(./**)', 'WebSearch', 'WebFetch'],
}

export const REVIEWER_TOOLS: ToolSet = {
  tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  allow: ['Read(./**)', 'WebSearch', 'WebFetch'],
}

// Edits under .git could plant hooks or config that the script's own git
// calls would run. Edit rules cover every file-writing tool.
export function deniedTools(): string[] {
  return ['Edit(./.git/**)']
}

export async function runClaude<T>(
  exec: Exec,
  opts: {
    cwd: string
    prompt: string
    tools: ToolSet
    schema: object
    home: string
    maxBudgetUsd: number
    label: string
    log: (line: string) => void
  },
): Promise<T> {
  const result = await exec(
    'claude',
    [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(opts.schema),
      // Search text and fetched pages can carry injected instructions, so
      // Claude runs restricted: no settings files (yours or the repo's), no
      // command tools, and file tools confined to the clone and --add-dir.
      '--restricted',
      '--strict-mcp-config',
      '--tools', opts.tools.tools.join(','),
      '--permission-mode', 'manual',
      '--max-budget-usd', String(opts.maxBudgetUsd),
      // Belt and braces: no hook from any remaining source runs either.
      '--settings', JSON.stringify({ disableAllHooks: true }),
      // Restricted mode loads no user skills, so the prompts point Claude at
      // the writing skill's files, which it may read but not edit.
      '--add-dir', writingSkillDir(opts.home),
      '--allowedTools', opts.tools.allow.join(','),
      '--disallowedTools', deniedTools().join(','),
    ],
    { cwd: opts.cwd, input: opts.prompt, timeoutMs: CLAUDE_TIMEOUT_MS },
  )
  if (result.code !== 0) throw new Error(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim()}`)

  let parsed: { is_error?: boolean; result?: string; structured_output?: T; session_id?: string; total_cost_usd?: number }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('claude returned output that is not JSON')
  }
  // The session id lets you resume a run with `claude -r` to see what it did.
  opts.log(`${opts.label}: claude session ${parsed.session_id ?? 'unknown'}, cost $${(parsed.total_cost_usd ?? 0).toFixed(2)}`)
  if (parsed.is_error) throw new Error(`claude reported an error: ${parsed.result ?? 'no detail'}`)
  if (parsed.structured_output === undefined) throw new Error('claude returned no structured_output')
  return parsed.structured_output
}

export type PromptName = 'writer' | 'reviewer' | 'fixer'

export function renderPrompt(name: PromptName, vars: Record<string, string>): string {
  const template = fs.readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8')
  // One pass, so placeholders inside substituted values stay literal.
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`prompt ${name} needs a value for ${key}`)
    return vars[key]
  })
}

export const guideSchema = {
  type: 'object',
  properties: {
    keyword: { type: 'string', description: 'The shortlist keyword this guide targets, copied exactly.' },
    title: { type: 'string' },
    slug: { type: 'string', description: 'URL slug, lowercase words joined by hyphens.' },
    guidePath: { type: 'string', description: 'Repo-relative path of the new guide file.' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Every source URL cited in the guide.' },
    linkedFrom: { type: 'array', items: { type: 'string' }, description: 'Repo-relative files that now link to the guide.' },
    reason: { type: 'string', description: 'Why this keyword fits the product best, in one or two sentences.' },
  },
  required: ['keyword', 'title', 'slug', 'guidePath', 'sources', 'linkedFrom', 'reason'],
}

export const reviewSchema = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['unsourced-claim', 'wrong-claim', 'slop', 'overlap', 'other'] },
          location: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['kind', 'location', 'detail'],
      },
    },
  },
  required: ['pass', 'issues'],
}
