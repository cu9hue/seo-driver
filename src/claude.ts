import fs from 'node:fs'
import type { Exec } from './exec.js'
import type { SiteConfig } from './types.js'

const RESEARCH_TOOLS = ['Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill']
const writingSkill = (home: string) => `Read(${home}/.claude/skills/writing/**)`

export function allowedTools(site: SiteConfig, home: string): string[] {
  return [
    'Read(./**)',
    'Edit(./**)',
    'Write(./**)',
    ...RESEARCH_TOOLS,
    writingSkill(home),
    ...site.buildCommands.map((c) => `Bash(${c})`),
  ]
}

export function reviewerTools(_site: SiteConfig, home: string): string[] {
  return ['Read(./**)', ...RESEARCH_TOOLS, writingSkill(home)]
}

// Deny rules win over any allow rule in the user's own settings.
export function deniedTools(): string[] {
  return ['Bash(git *)', 'Bash(gh *)', 'Bash(gum *)']
}

export async function runClaude<T>(
  exec: Exec,
  opts: { cwd: string; prompt: string; tools: string[]; schema: object },
): Promise<T> {
  const result = await exec(
    'claude',
    [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(opts.schema),
      // Overrides a defaultMode (auto, bypass) from the user's settings.
      '--permission-mode', 'default',
      // Ignore .claude/ settings inside the cloned site repo.
      '--setting-sources', 'user',
      '--allowedTools', opts.tools.join(','),
      '--disallowedTools', deniedTools().join(','),
    ],
    { cwd: opts.cwd, input: opts.prompt },
  )
  if (result.code !== 0) throw new Error(`claude exited ${result.code}: ${(result.stderr || result.stdout).trim()}`)

  let parsed: { is_error?: boolean; result?: string; structured_output?: T }
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('claude returned output that is not JSON')
  }
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
