#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { realFetchText } from './covered.js'
import { realExec } from './exec.js'
import { realHttpPost } from './google.js'
import { login } from './login.js'
import { runAll, type Deps, type SiteOutcome } from './pipeline.js'

const USAGE = [
  'usage: seo-driver run [--config <path>] [--site <domain>] [--dry-run]',
  '       seo-driver login --client <client_secret.json> [--out <path>]',
].join('\n')

function describe(outcome: SiteOutcome): string {
  switch (outcome.status) {
    case 'opened':
      return `${outcome.domain}: opened ${outcome.prUrl}`
    case 'skipped':
      return `${outcome.domain}: skipped (${outcome.reason})`
    case 'dry-run':
      return `${outcome.domain}: dry-run, guide ready in ${outcome.clonePath}`
    case 'failed':
      return `${outcome.domain}: failed (${outcome.reason})${outcome.clonePath ? `, clone kept at ${outcome.clonePath}` : ''}`
  }
}

// Cron appends every run to one file, so each line says when it happened.
export const logLine = (now: Date, line: string) => `${now.toISOString().replace(/\.\d{3}Z$/, 'Z')} ${line}`

export async function main(argv: string[], deps: Deps): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', default: 'seo-driver.config.json' },
        site: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        client: { type: 'string' },
        out: { type: 'string' },
      },
    })
  } catch (err) {
    deps.log(`${(err as Error).message}\n${USAGE}`)
    return 1
  }
  const [command, ...rest] = parsed.positionals
  if (command === 'login' && rest.length === 0 && parsed.values.client) {
    try {
      await login({
        clientFile: parsed.values.client,
        out: parsed.values.out ?? path.join(deps.home, '.config', 'seo-driver', 'google.json'),
        http: deps.http,
        log: deps.log,
      })
      return 0
    } catch (err) {
      deps.log((err as Error).message)
      return 1
    }
  }
  if (command !== 'run' || rest.length > 0) {
    deps.log(USAGE)
    return 1
  }

  let config
  try {
    config = loadConfig(parsed.values.config)
  } catch (err) {
    deps.log((err as Error).message)
    return 1
  }

  const { outcomes, exitCode } = await runAll(config, deps, {
    site: parsed.values.site,
    dryRun: parsed.values['dry-run'],
  })
  for (const outcome of outcomes) deps.log(describe(outcome))
  return exitCode
}

// npm links the bin through a symlink, so compare real paths.
const invoked = process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url
if (invoked) {
  const deps: Deps = {
    exec: realExec,
    fetchText: realFetchText,
    http: realHttpPost,
    now: () => new Date(),
    home: os.homedir(),
    log: (line) => console.log(logLine(new Date(), line)),
  }
  main(process.argv.slice(2), deps).then((code) => process.exit(code))
}
