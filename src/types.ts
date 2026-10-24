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
