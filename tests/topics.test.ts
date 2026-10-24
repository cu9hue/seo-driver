import { describe, expect, test } from 'vitest'
import { isCovered, keywordTokens, shortlist } from '../src/topics.js'
import type { Candidate } from '../src/types.js'

const gap = (keyword: string, score: number): Candidate => ({ keyword, source: 'search-console', score, impressions: score })
const idea = (keyword: string, score: number): Candidate => ({ keyword, source: 'keyword-planner', score })

describe('keywordTokens', () => {
  test('lowercases, splits on punctuation and drops stopwords', () => {
    expect([...keywordTokens('How to Arrange a Song?')]).toEqual(['arrange', 'song'])
    expect([...keywordTokens('how-to-arrange-a-song')]).toEqual(['arrange', 'song'])
  })

  test('keeps letters outside ASCII', () => {
    expect([...keywordTokens('Mischpult für Anfänger')]).toEqual(['mischpult', 'für', 'anfänger'])
    expect(keywordTokens('ミキシング').size).toBe(1)
  })
})

describe('isCovered', () => {
  test('matches a slug with the same words', () => {
    expect(isCovered('how to arrange a song', ['how-to-arrange-a-song'])).toBe(true)
  })
  test('matches a close variant', () => {
    expect(isCovered('arrange a song in ableton', ['how-to-arrange-a-song'])).toBe(true)
  })
  test('does not match an unrelated topic', () => {
    expect(isCovered('ableton sidechain compression', ['how-to-arrange-a-song'])).toBe(false)
  })
  test('matches a past PR keyword', () => {
    expect(isCovered('sidechain compression ableton', ['ableton sidechain compression'])).toBe(true)
  })
})

describe('shortlist', () => {
  test('puts gaps first, then ideas by score, and drops covered ones', () => {
    const result = shortlist(
      [gap('ableton arrangement view', 300)],
      [idea('ableton drop', 440), idea('how to start producing music', 5000), idea('how to finish a song', 1900)],
      ['how-to-start-producing-music'],
    )
    expect(result.map((c) => c.keyword)).toEqual(['ableton arrangement view', 'how to finish a song', 'ableton drop'])
  })

  test('cuts to size', () => {
    const result = shortlist([gap('a gap', 300)], [idea('one idea', 1900), idea('two idea', 440)], [], 2)
    expect(result.map((c) => c.keyword)).toEqual(['a gap', 'one idea'])
  })

  test('deduplicates candidates with the same words', () => {
    const result = shortlist([], [idea('How to Arrange a Song?', 1900), idea('how to arrange a song', 880)], [])
    expect(result.map((c) => c.keyword)).toEqual(['How to Arrange a Song?'])
  })

  test('defaults to ten entries', () => {
    const ideas = Array.from({ length: 15 }, (_, i) => idea(`topic number${i}`, 1000 - i))
    expect(shortlist([], ideas, []).length).toBe(10)
  })
})
