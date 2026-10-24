import type { Exec } from '../exec.js'
import { gumRead } from '../gum.js'
import type { Candidate, Config, SiteConfig } from '../types.js'

const MIN_MONTHLY_SEARCHES = 50
// Competition is how many advertisers bid, a rough proxy for how crowded the
// results are, not a ranking difficulty.
const COMPETITION_WEIGHT: Record<string, number> = { LOW: 1, MEDIUM: 0.5, HIGH: 0.25 }
// Keeps each response under gum's 16 MiB cap; gum pages through the rest.
const PAGE_SIZE = 1000

interface Idea {
  text?: string
  // Google sends int64 counts as JSON strings.
  keywordIdeaMetrics?: { avgMonthlySearches?: string | number; competition?: string }
}

export async function fetchKeywordIdeas(
  exec: Exec,
  site: SiteConfig,
  kp: Config['keywordPlanner'],
): Promise<Candidate[]> {
  const args: Record<string, unknown> = {
    url: `https://${site.domain}/`,
    geoTargetConstants: kp.geoTargetConstants,
    language: kp.language,
    pageSize: PAGE_SIZE,
  }
  if (site.seedKeywords.length > 0) args.keywords = site.seedKeywords
  if (kp.customerId) args.customerId = kp.customerId

  const response = (await gumRead(exec, 'googleads.keywordPlanIdeas.generateKeywordIdeas', args)) as {
    results?: Idea[]
  }

  const ideas: Candidate[] = []
  for (const idea of response.results ?? []) {
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
