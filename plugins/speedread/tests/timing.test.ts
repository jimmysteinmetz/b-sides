import { describe, expect, test } from 'claude-code/testing'

import { clampWpm, orpIndex, wordFactor } from '../hooks/timing'

describe('orpIndex', () => {
  test('sits slightly left of centre by length bucket', () => {
    expect(orpIndex('a')).toBe(0)
    expect(orpIndex('word')).toBe(1)
    expect(orpIndex('reading')).toBe(2)
    expect(orpIndex('comprehension')).toBe(3)
    expect(orpIndex('internationalization')).toBe(4)
  })
})

describe('wordFactor', () => {
  test('plain short word is the base delay', () => {
    expect(wordFactor('the', false)).toBe(1)
  })
  test('punctuation lengthens the pause', () => {
    expect(wordFactor('clause,', false)).toBe(1.6)
    expect(wordFactor('end.', false)).toBe(2.2)
    expect(wordFactor('"done."', false)).toBe(2.2)
    expect(wordFactor('end.', true)).toBe(3)
  })
  test('long, numeric and acronym words get longer', () => {
    expect(wordFactor('paragraph', false)).toBe(1.3)
    expect(wordFactor('NASA', false)).toBe(1.4)
    expect(wordFactor('2026', false)).toBe(1.4)
  })
})

describe('clampWpm', () => {
  test('keeps speed in range', () => {
    expect(clampWpm(50)).toBe(100)
    expect(clampWpm(5000)).toBe(1000)
    expect(clampWpm(325)).toBe(325)
  })
})
