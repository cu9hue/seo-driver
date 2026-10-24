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
