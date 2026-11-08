import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config, SiteConfig } from './types.js'

// Google's documented caps on seed keywords and locations.
const MAX_SEED_KEYWORDS = 20
const MAX_LOCATIONS = 10
// Build commands are split on spaces and run without a shell, so shell syntax
// would not do what it looks like.
const SHELL_SYNTAX = /[&|;<>`$'"\\*?(){}[\]]|^\s*\w+=/

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
  if (typeof intervalDays !== 'number' || !Number.isInteger(intervalDays) || intervalDays < 1) {
    throw new ConfigError(`${where}.intervalDays must be a whole number of days, 1 or more`)
  }

  const seedKeywords = stringArray(raw, 'seedKeywords', where, [])
  if (seedKeywords.length > MAX_SEED_KEYWORDS) {
    throw new ConfigError(`${where}.seedKeywords allows at most ${MAX_SEED_KEYWORDS} entries`)
  }

  const buildCommands = stringArray(raw, 'buildCommands', where, [])
  if (buildCommands.length === 0) throw new ConfigError(`${where}.buildCommands needs at least one command`)
  buildCommands.forEach((command, i) => {
    if (SHELL_SYNTAX.test(command)) {
      throw new ConfigError(
        `${where}.buildCommands[${i}] uses shell syntax (${command}); commands run without a shell, so list each one separately`,
      )
    }
  })

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

// Clones are checked against workDir, so paths must be absolute. A relative
// path is taken from the config file's folder, which stays put under cron.
function resolvePath(value: string | undefined, configFile: string, fallback: string): string {
  if (value === undefined) return path.join(os.homedir(), fallback)
  if (value === '~' || value.startsWith('~/')) return path.join(os.homedir(), value.slice(1))
  return path.resolve(path.dirname(path.resolve(configFile)), value)
}

function accountId(raw: Raw, key: string): string | undefined {
  const value = optionalString(raw, key, 'keywordPlanner')?.replace(/-/g, '')
  if (value !== undefined && !/^\d{10}$/.test(value)) {
    throw new ConfigError(`keywordPlanner.${key} must be a 10-digit Google Ads account id, such as 123-456-7890`)
  }
  return value
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
  const geoTargetConstants = stringArray(kpRaw, 'geoTargetConstants', 'keywordPlanner', ['2840'])
  if (geoTargetConstants.length === 0 || geoTargetConstants.length > MAX_LOCATIONS) {
    throw new ConfigError(`keywordPlanner.geoTargetConstants needs 1 to ${MAX_LOCATIONS} locations`)
  }
  const customerId = accountId(kpRaw, 'customerId')
  if (!customerId) throw new ConfigError('keywordPlanner.customerId is required: the 10-digit Google Ads account id')
  const scRaw = raw.searchConsole ?? {}
  if (!isObject(scRaw)) throw new ConfigError('searchConsole must be an object')
  const country = optionalString(scRaw, 'country', 'searchConsole') ?? 'usa'
  if (country !== 'all' && !/^[a-z]{3}$/.test(country)) {
    throw new ConfigError('searchConsole.country must be a lowercase ISO 3166-1 alpha-3 code, such as usa, or "all"')
  }

  const claudeMaxBudgetUsd = raw.claudeMaxBudgetUsd ?? 10
  if (typeof claudeMaxBudgetUsd !== 'number' || !(claudeMaxBudgetUsd > 0)) {
    throw new ConfigError('claudeMaxBudgetUsd must be a positive number')
  }

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) throw new ConfigError('sites needs at least one site')
  const sites = raw.sites.map(parseSite)

  const seen = new Set<string>()
  for (const site of sites) {
    if (seen.has(site.domain)) throw new ConfigError(`duplicate site domain ${site.domain}`)
    seen.add(site.domain)
  }

  return {
    workDir: resolvePath(optionalString(raw, 'workDir', 'config'), file, path.join('.cache', 'seo-driver')),
    googleCredentials: resolvePath(
      optionalString(raw, 'googleCredentials', 'config'),
      file,
      path.join('.config', 'seo-driver', 'google.json'),
    ),
    keywordPlanner: {
      customerId,
      loginCustomerId: accountId(kpRaw, 'loginCustomerId'),
      geoTargetConstants,
      language: optionalString(kpRaw, 'language', 'keywordPlanner') ?? '1000',
    },
    searchConsole: { country: country === 'all' ? undefined : country },
    claudeMaxBudgetUsd,
    sites,
  }
}
