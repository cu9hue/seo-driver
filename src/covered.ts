import fs from 'node:fs'
import path from 'node:path'

export type FetchText = (url: string) => Promise<{ status: number; text: string }>

const FETCH_TIMEOUT_MS = 30 * 1000
const MAX_REDIRECTS = 5
// A sitemap file may hold 50,000 URLs, about 10 MB.
export const MAX_FETCH_BYTES = 12 * 1024 * 1024
const MAX_CHILD_SITEMAPS = 50

// The same site, ignoring a leading www.
const sameSite = (url: URL, host: string) => url.hostname.replace(/^www\./, '') === host.replace(/^www\./, '')

async function readCapped(response: Response): Promise<string> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > MAX_FETCH_BYTES) throw new Error(`response larger than ${MAX_FETCH_BYTES} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Redirects are followed by hand, so a compromised site cannot point a fetch
// at another host, such as a machine on the local network.
export const realFetchText: FetchText = async (url) => {
  const start = new URL(url)
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel()
      current = new URL(location, current)
      if (!sameSite(current, start.hostname)) throw new Error(`redirected off the site to ${current.host}`)
      continue
    }
    return { status: response.status, text: await readCapped(response) }
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`)
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

// Sitemap URLs on this site only, capped in number.
function onSite(urls: string[], domain: string): string[] {
  return urls
    .filter((u) => {
      try {
        return sameSite(new URL(u), domain)
      } catch {
        return false
      }
    })
    .slice(0, MAX_CHILD_SITEMAPS)
}

// Every sitemap named in robots.txt, else the first of the two common
// default paths that answers.
async function sitemapUrls(fetchText: FetchText, domain: string, log: (line: string) => void): Promise<{ urls: string[]; all: boolean }> {
  const robots = await fetchOk(fetchText, `https://${domain}/robots.txt`, log)
  const named = onSite([...(robots ?? '').matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]), domain)
  if (named.length > 0) return { urls: named, all: true }
  return { urls: [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap-index.xml`], all: false }
}

export async function sitemapSlugs(fetchText: FetchText, domain: string, log: (line: string) => void): Promise<string[]> {
  const tried = await sitemapUrls(fetchText, domain, log)
  const roots: string[] = []
  for (const url of tried.urls) {
    const xml = await fetchOk(fetchText, url, log)
    if (!xml) continue
    roots.push(xml)
    if (!tried.all) break
  }
  if (roots.length === 0) {
    log(`${domain}: no sitemap found (tried robots.txt, ${tried.urls.join(', ')})`)
    return []
  }

  const pageUrls: string[] = []
  for (const root of roots) {
    if (!isIndex(root)) {
      pageUrls.push(...locs(root))
      continue
    }
    for (const child of onSite(locs(root), domain)) {
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
