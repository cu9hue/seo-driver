import fs from 'node:fs'
import path from 'node:path'

export type FetchText = (url: string) => Promise<{ status: number; text: string }>

const FETCH_TIMEOUT_MS = 30 * 1000

export const realFetchText: FetchText = async (url) => {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  return { status: response.status, text: await response.text() }
}

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1])
const isIndex = (xml: string) => /<sitemapindex[\s>]/.test(xml)
const isPageFile = (name: string) => /^index\.html?$/i.test(name)

async function fetchOk(fetchText: FetchText, url: string, log: (line: string) => void): Promise<string | undefined> {
  try {
    const { status, text } = await fetchText(url)
    if (status === 200) return text
  } catch (err) {
    log(`${url} could not be fetched: ${(err as Error).message}`)
  }
  return undefined
}

function slug(url: string): string | undefined {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return undefined
  }
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length > 0 && isPageFile(segments[segments.length - 1])) segments.pop()
  return segments.pop()?.replace(/\.[a-z0-9]+$/i, '')
}

// Sitemaps named in robots.txt, else the two common default paths.
async function sitemapUrls(fetchText: FetchText, domain: string, log: (line: string) => void): Promise<string[]> {
  const robots = await fetchOk(fetchText, `https://${domain}/robots.txt`, log)
  const named = [...(robots ?? '').matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1])
  return named.length > 0 ? named : [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap-index.xml`]
}

export async function sitemapSlugs(fetchText: FetchText, domain: string, log: (line: string) => void): Promise<string[]> {
  const tried = await sitemapUrls(fetchText, domain, log)
  let root: string | undefined
  for (const url of tried) {
    root = await fetchOk(fetchText, url, log)
    if (root) break
  }
  if (!root) {
    log(`${domain}: no sitemap found (tried robots.txt, ${tried.join(', ')})`)
    return []
  }

  let pageUrls = locs(root)
  if (isIndex(root)) {
    pageUrls = []
    for (const child of locs(root)) {
      const xml = await fetchOk(fetchText, child, log)
      // Follow one level only: a nested index is skipped.
      if (xml && !isIndex(xml)) pageUrls.push(...locs(xml))
    }
  }
  return pageUrls.map(slug).filter((s): s is string => Boolean(s))
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])
const SKIP_FILES = /^(readme|changelog|license|contributing|code_of_conduct)$/i
const MAX_DEPTH = 4

// Pages already in the repo: a folder holding index.html, an .html file, or
// an .md or .mdx file below the root (Markdown at the root is docs). Catches
// guides merged but not yet in the live sitemap.
export function repoSlugs(repo: string): string[] {
  const slugs: string[] = []
  const walk = (dir: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) walk(path.join(dir, entry.name), depth + 1)
      } else if (isPageFile(entry.name)) {
        if (dir !== repo) slugs.push(path.basename(dir))
      } else if (/\.html?$/i.test(entry.name) || (dir !== repo && /\.mdx?$/i.test(entry.name))) {
        const name = entry.name.replace(/\.[a-z]+$/i, '')
        if (!SKIP_FILES.test(name)) slugs.push(name)
      }
    }
  }
  walk(repo, 0)
  return slugs
}
