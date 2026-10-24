export interface SiteConfig {
  domain: string
  repo: string
  baseBranch: string
  intervalDays: number
  searchConsoleProperty?: string
  seedKeywords: string[]
  buildCommands: string[]
  exampleGuide?: string
  instructionsFile?: string
}

export interface Config {
  workDir: string
  keywordPlanner: { customerId?: string; geoTargetConstants: string[]; language: string }
  // ISO 3166-1 alpha-3, lowercase; undefined means every country.
  searchConsole: { country?: string }
  // Per Claude run.
  claudeMaxBudgetUsd: number
  sites: SiteConfig[]
}

export interface Candidate {
  keyword: string
  source: 'search-console' | 'keyword-planner'
  score: number
  impressions?: number
  clicks?: number
  position?: number
  avgMonthlySearches?: number
  competition?: string
}
