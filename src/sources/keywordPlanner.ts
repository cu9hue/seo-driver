import type { Google } from '../google.js'
import type { Candidate, Config, SiteConfig } from '../types.js'

// Google retires each Ads API version about a year after release; move this
// forward when a sunset notice arrives.
const ADS_API = 'https://googleads.googleapis.com/v26'

const MIN_MONTHLY_SEARCHES = 50
// Competition is how many advertisers bid, a rough proxy for how crowded the
// results are, not a ranking difficulty.
const COMPETITION_WEIGHT: Record<string, number> = { LOW: 1, MEDIUM: 0.5, HIGH: 0.25 }
// The API maximum per page.
const PAGE_SIZE = 10000
// A guard against a page token that never ends.
const MAX_PAGES = 10

interface Idea {
  text?: string
  // Google sends int64 counts as JSON strings.
  keywordIdeaMetrics?: { avgMonthlySearches?: string | number; competition?: string }
}

// Config holds plain ids, such as 2840; the API wants resource names.
const resourceName = (kind: string, id: string) => (id.includes('/') ? id : `${kind}/${id}`)

export async function fetchKeywordIdeas(google: Google, site: SiteConfig, kp: Config['keywordPlanner']): Promise<Candidate[]> {
  const url = `https://${site.domain}/`
  const body: Record<string, unknown> = {
    ...(site.seedKeywords.length > 0 ? { keywordAndUrlSeed: { url, keywords: site.seedKeywords } } : { urlSeed: { url } }),
    geoTargetConstants: kp.geoTargetConstants.map((id) => resourceName('geoTargetConstants', id)),
    language: resourceName('languageConstants', kp.language),
    // Search only, like the Search Console data it is ranked with.
    keywordPlanNetwork: 'GOOGLE_SEARCH',
    pageSize: PAGE_SIZE,
  }
  // Needed only when the account is reached through a manager account.
  const headers: Record<string, string> = kp.loginCustomerId ? { 'login-customer-id': kp.loginCustomerId } : {}

  const results: Idea[] = []
  let pageToken: string | undefined
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`Keyword Planner returned more than ${MAX_PAGES} pages of ideas`)
    const response = (await google.post(
      'Keyword Planner',
      `${ADS_API}/customers/${kp.customerId}:generateKeywordIdeas`,
      pageToken ? { ...body, pageToken } : body,
      headers,
    )) as { results?: Idea[]; nextPageToken?: string }
    results.push(...(response.results ?? []))
    pageToken = response.nextPageToken
    if (!pageToken) break
  }

  const ideas: Candidate[] = []
  for (const idea of results) {
    const avgMonthlySearches = Number(idea.keywordIdeaMetrics?.avgMonthlySearches ?? 0)
    const competition = idea.keywordIdeaMetrics?.competition
    const weight = competition ? COMPETITION_WEIGHT[competition] : undefined
    if (!idea.text || !weight || !(avgMonthlySearches >= MIN_MONTHLY_SEARCHES)) continue
    ideas.push({
      keyword: idea.text,
      source: 'keyword-planner',
      score: avgMonthlySearches * weight,
      avgMonthlySearches,
      competition,
    })
  }
  return ideas
}
