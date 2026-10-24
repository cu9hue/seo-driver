import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConfigError, loadConfig } from '../src/config.js'

function writeConfig(value: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-config-'))
  const file = path.join(dir, 'seo-driver.config.json')
  fs.writeFileSync(file, JSON.stringify(value))
  return file
}

const minimalSite = {
  domain: 'mixingpal.com',
  repo: 'antithetical-labs/mixing-pal-landing',
  buildCommands: ['npm ci', 'npm run build'],
  exampleGuide: 'how-to-arrange-a-song/index.html',
}

describe('loadConfig', () => {
  test('applies defaults', () => {
    const config = loadConfig(writeConfig({ sites: [minimalSite] }))
    expect(config.workDir).toBe(path.join(os.homedir(), '.cache', 'seo-driver'))
    expect(config.keywordPlanner.geoTargetConstants).toEqual(['2840'])
    expect(config.keywordPlanner.language).toBe('1000')
    expect(config.keywordPlanner.customerId).toBeUndefined()
    const site = config.sites[0]
    expect(site.baseBranch).toBe('main')
    expect(site.intervalDays).toBe(2)
    expect(site.seedKeywords).toEqual([])
    expect(site.searchConsoleProperty).toBeUndefined()
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
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, repo: 'mixing-pal-landing' }] }))).toThrow(/repo/)
  })

  test('rejects duplicate domains', () => {
    expect(() => loadConfig(writeConfig({ sites: [minimalSite, minimalSite] }))).toThrow(/mixingpal\.com/)
  })

  test('rejects empty buildCommands', () => {
    expect(() => loadConfig(writeConfig({ sites: [{ ...minimalSite, buildCommands: [] }] }))).toThrow(/buildCommands/)
  })

  test('names the file when it is not valid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-config-'))
    const file = path.join(dir, 'broken.json')
    fs.writeFileSync(file, '{ not json')
    expect(() => loadConfig(file)).toThrow(/broken\.json/)
  })
})
