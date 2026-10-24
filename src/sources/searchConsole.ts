import type { Exec } from '../exec.js'
import { gumRead } from '../gum.js'
import type { Candidate, SiteConfig } from '../types.js'

const DAY_MS = 24 * 60 * 60 * 1000
// Search Console data lags about two days behind today.
const LAG_DAYS = 2
const WINDOW_DAYS = 28
const MIN_IMPRESSIONS = 100
const MAX_CTR = 0.01
// The API maximum. Rows come sorted by clicks, so a smaller limit cuts off
// the zero-click queries first.
const ROW_LIMIT = 25000

interface Row {
  keys?: string[]
  clicks?: number
  impressions?: number
  ctr?: number
  position?: number
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)

export function searchConsoleWindow(today: Date): { startDate: string; endDate: string } {
  const end = new Date(today.getTime() - LAG_DAYS * DAY_MS)
  const start = new Date(end.getTime() - (WINDOW_DAYS - 1) * DAY_MS)
  return { startDate: isoDate(start), endDate: isoDate(end) }
}

export async function fetchSearchGaps(exec: Exec, site: SiteConfig, today: Date, country?: string): Promise<Candidate[]> {
  if (!site.searchConsoleProperty) return []
  const body: Record<string, unknown> = { ...searchConsoleWindow(today), dimensions: ['query'], rowLimit: ROW_LIMIT }
  if (country) body.dimensionFilterGroups = [{ filters: [{ dimension: 'country', operator: 'equals', expression: country }] }]
  const response = (await gumRead(exec, 'searchconsole.searchanalytics.query', {
    siteUrl: site.searchConsoleProperty,
    body,
  })) as { rows?: Row[] }

  const gaps: Candidate[] = []
  for (const row of response.rows ?? []) {
    const keyword = row.keys?.[0]
    const impressions = row.impressions ?? 0
    const clicks = row.clicks ?? 0
    const ctr = row.ctr ?? (impressions > 0 ? clicks / impressions : 0)
    if (!keyword || impressions < MIN_IMPRESSIONS || ctr > MAX_CTR) continue
    gaps.push({ keyword, source: 'search-console', score: impressions, impressions, clicks, position: row.position })
  }
  return gaps
}
