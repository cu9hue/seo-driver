import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config, SiteConfig } from './types.js'

// Google's documented keywordSeed cap, which gum enforces.
const MAX_SEED_KEYWORDS = 20

export class ConfigError extends Error {}

type Raw = Record<string, unknown>

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(raw: Raw, key: string, where: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value === '') throw new ConfigError(`${where}.${key} must be a non-empty string`)
  return value
}

function stringArray(raw: Raw, key: string, where: string, fallback: string[]): string[] {
  const value = raw[key]
  if (value === undefined) return fallback
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
    throw new ConfigError(`${where}.${key} must be an array of non-empty strings`)
  }
  return value
}

function parseSite(raw: unknown, index: number): SiteConfig {
  const where = `sites[${index}]`
  if (!isObject(raw)) throw new ConfigError(`${where} must be an object`)

  const domain = optionalString(raw, 'domain', where)
  if (!domain) throw new ConfigError(`${where}.domain is required`)

  const repo = optionalString(raw, 'repo', where)
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ConfigError(`${where}.repo must look like owner/name`)

  const intervalDays = raw.intervalDays ?? 2
  if (typeof intervalDays !== 'number' || !(intervalDays > 0)) {
    throw new ConfigError(`${where}.intervalDays must be a positive number`)
  }

  const seedKeywords = stringArray(raw, 'seedKeywords', where, [])
  if (seedKeywords.length > MAX_SEED_KEYWORDS) {
    throw new ConfigError(`${where}.seedKeywords allows at most ${MAX_SEED_KEYWORDS} entries`)
  }

  const buildCommands = stringArray(raw, 'buildCommands', where, [])
  if (buildCommands.length === 0) throw new ConfigError(`${where}.buildCommands needs at least one command`)

  const exampleGuide = optionalString(raw, 'exampleGuide', where)
  const instructionsFile = optionalString(raw, 'instructionsFile', where)
  if (!exampleGuide && !instructionsFile) {
    throw new ConfigError(`${where} needs exampleGuide or instructionsFile`)
  }

  return {
    domain,
    repo,
    baseBranch: optionalString(raw, 'baseBranch', where) ?? 'main',
    intervalDays,
    searchConsoleProperty: optionalString(raw, 'searchConsoleProperty', where),
    seedKeywords,
    buildCommands,
    exampleGuide,
    instructionsFile,
  }
}

export function loadConfig(file: string): Config {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new ConfigError(`cannot read config ${file}: ${(err as Error).message}`)
  }
  if (!isObject(raw)) throw new ConfigError(`config ${file} must be a JSON object`)

  const kpRaw = raw.keywordPlanner ?? {}
  if (!isObject(kpRaw)) throw new ConfigError('keywordPlanner must be an object')

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) throw new ConfigError('sites needs at least one site')
  const sites = raw.sites.map(parseSite)

  const seen = new Set<string>()
  for (const site of sites) {
    if (seen.has(site.domain)) throw new ConfigError(`duplicate site domain ${site.domain}`)
    seen.add(site.domain)
  }

  return {
    workDir: optionalString(raw, 'workDir', 'config') ?? path.join(os.homedir(), '.cache', 'seo-driver'),
    keywordPlanner: {
      customerId: optionalString(kpRaw, 'customerId', 'keywordPlanner'),
      geoTargetConstants: stringArray(kpRaw, 'geoTargetConstants', 'keywordPlanner', ['2840']),
      language: optionalString(kpRaw, 'language', 'keywordPlanner') ?? '1000',
    },
    sites,
  }
}
