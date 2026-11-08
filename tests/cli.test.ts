import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { logLine, main } from '../src/cli.js'
import { makeEnv } from './pipelineEnv.js'

function configFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-cli-'))
  const file = path.join(dir, 'seo-driver.config.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      workDir: path.join(dir, 'work'),
      googleCredentials: makeEnv().config.googleCredentials,
      keywordPlanner: { customerId: '1234567890' },
      sites: [
        {
          domain: 'mixingpal.com',
          repo: 'acme/site',
          buildCommands: ['npm run build'],
          exampleGuide: 'how-to-arrange-a-song/index.html',
        },
      ],
    }),
  )
  return file
}

describe('main', () => {
  test('unknown --site lists configured domains', async () => {
    const env = makeEnv()
    const code = await main(['run', '--config', configFile(), '--site', 'nope.com'], env.deps)
    expect(code).toBe(1)
    expect(env.logs.join('\n')).toContain('nope.com')
    expect(env.logs.join('\n')).toContain('mixingpal.com')
  })

  test('a dry run prints one line per site and exits 0', async () => {
    const env = makeEnv()
    const code = await main(['run', '--config', configFile(), '--dry-run'], env.deps)
    expect(code).toBe(0)
    expect(env.logs.some((l) => l.startsWith('mixingpal.com: dry-run'))).toBe(true)
  })

  test('a bad config exits 1 with the reason', async () => {
    const env = makeEnv()
    const code = await main(['run', '--config', '/does/not/exist.json'], env.deps)
    expect(code).toBe(1)
    expect(env.logs.join('\n')).toContain('/does/not/exist.json')
  })

  test('an unknown command prints usage and exits 1', async () => {
    const env = makeEnv()
    expect(await main(['publish'], env.deps)).toBe(1)
    expect(env.logs.join('\n')).toContain('usage: seo-driver run')
  })

  test('login without --client prints usage and exits 1', async () => {
    const env = makeEnv()
    expect(await main(['login'], env.deps)).toBe(1)
    expect(env.logs.join('\n')).toContain('seo-driver login --client <client_secret.json>')
  })

  test('log lines start with a UTC timestamp', () => {
    expect(logLine(new Date('2026-10-24T07:00:05Z'), 'mixingpal.com: dry-run')).toBe('2026-10-24T07:00:05Z mixingpal.com: dry-run')
  })
})
