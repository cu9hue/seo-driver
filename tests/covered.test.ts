import { afterEach, describe, expect, test, vi } from 'vitest'
import { sitemapSlugs, type FetchText } from '../src/covered.js'

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

afterEach(() => vi.restoreAllMocks())

describe('sitemapSlugs', () => {
  test('parses urlset slugs and skips the homepage', async () => {
    const fetchText = fakeFetch({
      'https://mixingpal.com/sitemap.xml': urlset(
        'https://mixingpal.com/',
        'https://mixingpal.com/how-to-arrange-a-song/',
        'https://mixingpal.com/privacy/',
      ),
    })
    expect(await sitemapSlugs(fetchText, 'mixingpal.com')).toEqual(['how-to-arrange-a-song', 'privacy'])
  })

  test('strips file extensions', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap.xml': urlset('https://example.com/guides/hide-photos.html'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com')).toEqual(['hide-photos'])
  })

  test('follows a sitemap index one level', async () => {
    const fetchText = fakeFetch({
      'https://example.com/sitemap.xml': index('https://example.com/a.xml', 'https://example.com/b.xml', 'https://example.com/nested.xml'),
      'https://example.com/a.xml': urlset('https://example.com/guide-one/'),
      'https://example.com/b.xml': urlset('https://example.com/guide-two/'),
      'https://example.com/nested.xml': index('https://example.com/deeper.xml'),
      'https://example.com/deeper.xml': urlset('https://example.com/too-deep/'),
    })
    expect(await sitemapSlugs(fetchText, 'example.com')).toEqual(['guide-one', 'guide-two'])
    expect(fetchText.urls).not.toContain('https://example.com/deeper.xml')
  })

  test('missing sitemap yields no slugs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sitemapSlugs(fakeFetch({}), 'example.com')).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('https://example.com/sitemap.xml'))
  })

  test('a network error yields no slugs', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failing: FetchText = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    expect(await sitemapSlugs(failing, 'example.com')).toEqual([])
  })
})
