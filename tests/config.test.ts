import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

// Every config needs the Ads account; tests that are about it pass their own.
function writeConfig(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-config-'))
  const file = path.join(dir, 'seo-driver.config.json')
  const withAccount = typeof value === 'object' && value !== null ? { keywordPlanner: { customerId: '123-456-7890' }, ...value } : value
  fs.writeFileSync(file, JSON.stringify(withAccount))
  return file
}

const minimalSite = {
  domain: 'mixingpal.com',
  repo: 'your-org/your-site',
  buildCommands: ['npm ci', 'npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}

describe('loadConfig', () => {
  test('applies defaults', () => {
    const config = loadConfig(writeConfig({ sites: [minimalSite] }))
    expect(config.workDir).toBe(path.join(os.homedir(), '.cache', 'seo-driver'))
    expect(config.keywordPlanner.geoTargetConstants).toEqual(['2840'])
    expect(config.keywordPlanner.language).toBe('1000')
    expect(config.keywordPlanner.customerId).toBe('1234567890')
    expect(config.keywordPlanner.loginCustomerId).toBeUndefined()
    expect(config.googleCredentials).toBe(path.join(os.homedir(), '.config', 'seo-driver', 'google.json'))
    const site = config.sites[0]
    expect(site.baseBranch).toBe('main')
    expect(site.intervalDays).toBe(2)
    expect(site.seedKeywords).toEqual([])
    expect(site.searchConsoleProperty).toBeUndefined()
  })

  test('requires the 10-digit Google Ads account id', () => {
    expect(() => loadConfig(writeConfig({ keywordPlanner: {}, sites: [minimalSite] }))).toThrow('keywordPlanner.customerId')
    expect(() => loadConfig(writeConfig({ keywordPlanner: { customerId: '12345' }, sites: [minimalSite] }))).toThrow(
      'keywordPlanner.customerId',
    )
  })

  test('takes 1 to 10 Keyword Planner locations', () => {
    const geo = (ids: string[]) => writeConfig({ keywordPlanner: { customerId: '1234567890', geoTargetConstants: ids }, sites: [minimalSite] })
    expect(() => loadConfig(geo([]))).toThrow('keywordPlanner.geoTargetConstants needs 1 to 10 locations')
    expect(() => loadConfig(geo(Array.from({ length: 11 }, (_, i) => String(2000 + i))))).toThrow('1 to 10 locations')
    expect(loadConfig(geo(['2840', '2826'])).keywordPlanner.geoTargetConstants).toEqual(['2840', '2826'])
  })

  test('reads the manager account id, dashes removed', () => {
    const config = loadConfig(writeConfig({ keywordPlanner: { customerId: '1234567890', loginCustomerId: '111-222-3333' }, sites: [minimalSite] }))
    expect(config.keywordPlanner.loginCustomerId).toBe('1112223333')
  })

  test('expands ~ in googleCredentials', () => {
    const config = loadConfig(writeConfig({ googleCredentials: '~/secrets/google.json', sites: [minimalSite] }))
    expect(config.googleCredentials).toBe(path.join(os.homedir(), 'secrets', 'google.json'))
  })

  test('expands ~ in workDir', () => {
    const config = loadConfig(writeConfig({ workDir: '~/seo-work', sites: [minimalSite] }))
    expect(config.workDir).toBe(path.join(os.homedir(), 'seo-work'))
  })

  test('resolves a relative workDir against the config file folder', () => {
    const file = writeConfig({ workDir: 'work', sites: [minimalSite] })
    expect(loadConfig(file).workDir).toBe(path.join(path.dirname(file), 'work'))
  })

  test('rejects a site with neither exampleGuide nor instructionsFile', () => {
    const { exampleGuide: _, ...site } = minimalSite
    expect(() => loadConfig(writeConfig({ sites: [site] }))).toThrow(ConfigError)
    expect(() => loadConfig(writeConfig({ sites: [site] }))).toThrow(/exampleGuide/)
  })

  test('accepts instructionsFile instead of exampleGuide', () => {
    const { exampleGuide: _, ...site } = minimalSite
    const config = loadConfig(writeConfig({ sites: [{ ...site, instructionsFile: 'SEO.md' }] }))
    expect(config.sites[0].instructionsFile).toBe('SEO.md')
  })

  test('rejects more than 20 seed keywords', () => {
    const seeds = Array.from({ length: 21 }, (_, i) => `seed ${i}`)
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, seedKeywords: seeds }] }))).toThrow(/seedKeywords/)
  })

  test('rejects a repo not shaped owner/name', () => {
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, repo: 'your-site' }] }))).toThrow(/repo/)
  })

  test('rejects duplicate domains', () => {
    expect(() => loadConfig(writeConfig({ sites: [minimalSite, minimalSite] }))).toThrow(/mixingpal\.com/)
  })

  test('rejects empty buildCommands', () => {
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, buildCommands: [] }] }))).toThrow(/buildCommands/)
  })

  test.each([['npm ci && npm run build'], ['NODE_ENV=production npm run build'], ['npm run build | tee log'], ['npm run *']])(
    'rejects shell syntax in buildCommands: %s',
    (command) => {
      expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, buildCommands: [command] }] }))).toThrow(/shell/)
    },
  )

  test('rejects a fractional intervalDays', () => {
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, intervalDays: 1.5 }] }))).toThrow(/whole number/)
  })

  test('defaults the Claude budget and the Search Console country', () => {
    const config = loadConfig(writeConfig({ sites: [minimalSite] }))
    expect(config.claudeMaxBudgetUsd).toBe(10)
    expect(config.searchConsole.country).toBe('usa')
  })

  test('country "all" turns the Search Console country filter off', () => {
    const config = loadConfig(writeConfig({ searchConsole: { country: 'all' }, sites: [minimalSite] }))
    expect(config.searchConsole.country).toBeUndefined()
  })

  test('rejects a country that is not a 3-letter code', () => {
    expect(() => loadConfig(writeConfig({ searchConsole: { country: 'US' }, sites: [minimalSite] }))).toThrow(/country/)
  })

  test('rejects a non-positive Claude budget', () => {
    expect(() => loadConfig(writeConfig({ claudeMaxBudgetUsd: 0, sites: [minimalSite] }))).toThrow(/claudeMaxBudgetUsd/)
  })

  test('names the file when it is not valid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-config-'))
    const file = path.join(dir, 'broken.json')
    fs.writeFileSync(file, '{ not json')
    expect(() => loadConfig(file)).toThrow(/broken\.json/)
  })
})
