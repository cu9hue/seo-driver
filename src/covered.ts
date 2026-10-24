export type FetchText = (url: string) => Promise<{ status: number; text: string }>

export const realFetchText: FetchText = async (url) => {
  const response = await fetch(url, { redirect: 'follow' })
  return { status: response.status, text: await response.text() }
}

const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1])
const isIndex = (xml: string) => /<sitemapindex[\s>]/.test(xml)

async function fetchSitemap(fetchText: FetchText, url: string): Promise<string | undefined> {
  try {
    const { status, text } = await fetchText(url)
    if (status === 200) return text
    console.warn(`sitemap ${url} returned HTTP ${status}`)
  } catch (err) {
    console.warn(`sitemap ${url} could not be fetched: ${(err as Error).message}`)
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
  const last = pathname.split('/').filter(Boolean).pop()
  return last?.replace(/\.[a-z0-9]+$/i, '')
}

export async function sitemapSlugs(fetchText: FetchText, domain: string): Promise<string[]> {
  const root = await fetchSitemap(fetchText, `https://${domain}/sitemap.xml`)
  if (!root) return []

  let pageUrls = locs(root)
  if (isIndex(root)) {
    pageUrls = []
    for (const child of locs(root)) {
      const xml = await fetchSitemap(fetchText, child)
      // Follow one level only: a nested index is skipped.
      if (xml && !isIndex(xml)) pageUrls.push(...locs(xml))
    }
  }
  return pageUrls.map(slug).filter((s): s is string => Boolean(s))
}
