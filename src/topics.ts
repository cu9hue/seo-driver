import type { Candidate } from './types.js'

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'how', 'in', 'on', 'for', 'of', 'and', 'or',
  'with', 'your', 'my', 'is', 'do', 'does', 'what', 'why', 'i',
])
const MIN_SIMILARITY = 0.6

export function keywordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t !== '' && !STOPWORDS.has(t)),
  )
}

function similar(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  const shared = [...a].filter((t) => b.has(t)).length
  if (shared === a.size) return true
  return shared / (a.size + b.size - shared) >= MIN_SIMILARITY
}

// `covered` holds sitemap slugs and keywords of past guide PRs.
export function isCovered(keyword: string, covered: string[]): boolean {
  const tokens = keywordTokens(keyword)
  return covered.some((entry) => similar(tokens, keywordTokens(entry)))
}

const tokenKey = (keyword: string) => [...keywordTokens(keyword)].sort().join(' ')

export function shortlist(gaps: Candidate[], ideas: Candidate[], covered: string[], size = 10): Candidate[] {
  const byScore = (a: Candidate, b: Candidate) => b.score - a.score
  const seen = new Set<string>()
  const result: Candidate[] = []
  for (const candidate of [...[...gaps].sort(byScore), ...[...ideas].sort(byScore)]) {
    const key = tokenKey(candidate.keyword)
    if (key === '' || seen.has(key) || isCovered(candidate.keyword, covered)) continue
    seen.add(key)
    result.push(candidate)
    if (result.length === size) break
  }
  return result
}
