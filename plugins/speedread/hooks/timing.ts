// How long each word stays on screen, and where the eye fixes inside it.

export const MIN_WPM = 100
export const MAX_WPM = 1000
export const WPM_STEP = 25
export const DEFAULT_WPM = 300
export const HEADING_MS = 1500

// Optimal recognition point: slightly left of centre (OpenSpritz buckets).
export const orpIndex = (word: string): number => {
  const length = word.length
  if (length <= 1) return 0
  if (length <= 5) return 1
  if (length <= 9) return 2
  if (length <= 13) return 3

  return 4
}

const SENTENCE_END = /[.!?]["')\]’”]*$/
const CLAUSE_END = /([,;:]|—|–)["')\]’”]*$/
const DENSE = /\d|^[A-Z]{2,}\W*$/

// Multiplier on the base delay (60000 / wpm) for one word.
export const wordFactor = (word: string, isParagraphEnd: boolean): number => {
  let factor = 1
  if (word.length >= 9) factor *= 1.3
  if (DENSE.test(word)) factor *= 1.4
  if (isParagraphEnd) factor *= 3
  else if (SENTENCE_END.test(word)) factor *= 2.2
  else if (CLAUSE_END.test(word)) factor *= 1.6

  return factor
}

export const baseMs = (wpm: number): number => 60000 / wpm

export const clampWpm = (wpm: number): number => Math.min(MAX_WPM, Math.max(MIN_WPM, wpm))
