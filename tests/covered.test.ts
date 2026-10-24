import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { repoSlugs, sitemapSlugs, type FetchText } from '../src/covered.js'

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`
const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`

function fakeFetch(pages: Record<string, string>): FetchText & { urls: string[] } {
  const urls: string[] = []
  const fetchText = (async (url: string) => {
    urls.push(url)
    return url in pages ? { status: 200, text: pages[url] } : { status: 404, text: '' }
  }) as FetchText & { urls: string[] }
  fetchText.urls = urls
  return fetchText
}

const noLog = () => {}

describe('sitemapSlugs', () => {
  test('parses urlset slugs and skips the homepage', async () => {
    const fetchText = fakeFetch({
      'https://mixingpal.com/sitemap.xml': urlset(
        'https://mixingpal.com/',
        'https://mixingpal.com/how-to-arrange-a-song/',
        'https://mixingpal.com/privacy/',
      ),
    })
    expect(await sitemapSlugs(fetchText, 'mixingpal.com', noLog)).toEqual(['how-to-arrange-a-song', 'privacy'])
  })

  test('strips file extensions', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap.xml': urlset('https://example.com/guides/hide-photos.html'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com', noLog)).toEqual(['hide-photos'])
  })

  test('follows a sitemap index one level', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap.xml': index('https://example.com/a.xml', 'https://example.com/b.xml', 'https://example.com/nested.xml'),
      'https://example.com/a.xml': urlset('https://example.com/guide-one/'),
      'https://example.com/b.xml': urlset('https://example.com/guide-two/'),
      'https://example.com/nested.xml': index('https://example.com/deeper.xml'),
      'https://example.com/deeper.xml': urlset('https://example.com/too-deep/'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com', noLog)).toEqual(['guide-one', 'guide-two'])
    expect(fetchText.urls).not.toContain('https://example.com/deeper.xml')
  })

  test('takes the page folder for a URL ending in index.html', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap.xml': urlset('https://example.com/how-to-mix-vocals/index.html', 'https://example.com/index.html'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com', noLog)).toEqual(['how-to-mix-vocals'])
  })

  test('reads the sitemaps that robots.txt names', async () => {
    const fetchText = fakeFetch({
      'https://example.com/robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml\n',
      'https://example.com/sitemap-index.xml': index('https://example.com/sitemap-0.xml'),
      'https://example.com/sitemap-0.xml': urlset('https://example.com/guide-one/'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com', noLog)).toEqual(['guide-one'])
    expect(fetchText.urls).not.toContain('https://example.com/sitemap.xml')
  })

  test('falls back to sitemap-index.xml', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap-index.xml': index('https://example.com/sitemap-0.xml'),
      'https://example.com/sitemap-0.xml': urlset('https://example.com/guide-one/'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com', noLog)).toEqual(['guide-one'])
  })

  test('missing sitemap yields no slugs and says so in the run log', async () => {
    const logs: string[] = []
    expect(await sitemapSlugs(fakeFetch({}), 'example.com', (l) => logs.push(l))).toEqual([])
    expect(logs).toEqual([
      'example.com: no sitemap found (tried robots.txt, https://example.com/sitemap.xml, https://example.com/sitemap-index.xml)',
    ])
  })

  test('a network error yields no slugs', async () => {
    const failing: FetchText = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    expect(await sitemapSlugs(failing, 'example.com', noLog)).toEqual([])
  })
})

describe('repoSlugs', () => {
  test('names page folders and page files, skipping build output and dependencies', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-driver-repo-'))
    const write = (file: string) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
      fs.writeFileSync(path.join(repo, file), '')
    }
    write('index.html')
    write('DESIGN.md')
    write('worker/README.md')
    write('how-to-arrange-a-song/index.html')
    write('guides/sidechain-compression.md')
    write('src/content/blog/mixing-vocals.mdx')
    write('node_modules/pkg/readme-page.html')
    write('dist/how-to-arrange-a-song/index.html')
    write('.github/workflow-notes.md')
    write('src/main.ts')
    expect(repoSlugs(repo).sort()).toEqual(['how-to-arrange-a-song', 'mixing-vocals', 'sidechain-compression'])
  })
})
