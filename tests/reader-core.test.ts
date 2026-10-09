import { describe, expect, test } from 'claude-code/testing'

import { flatten, parse } from '../hooks/parse'
import type { Page, Step } from '../hooks/reader-core'
import { CUE_MS, advance, back, click, initial, land, press, tick } from '../hooks/reader-core'

// 600 wpm: base delay 100 ms.
const pageOf = (markdown: string, extra: Partial<Page> = {}): Page => ({
  items: flatten(parse(markdown)),
  pageIndex: 0,
  pageCount: 1,
  ...extra,
})
const begun = (page: Page): Step => click(initial(page, 600), page)
// Clicked, and past the opening cue when the page starts on a word.
const started = (page: Page): Step => {
  const s = begun(page)

  return s.state.mode === 'cue' ? tick(s, page, CUE_MS) : s
}
const at = (step: Step, page: Page, index: number): Step => {
  let s = step
  while (s.state.index < index) s = advance(s, page)

  return s
}

describe('playing', () => {
  test('a click cues the first word, then plays it', () => {
    const page = pageOf('One two three.')
    expect(begun(page).state).toMatchObject({ mode: 'cue', index: 0 })
    expect(started(page).state).toMatchObject({ mode: 'playing', index: 0 })
  })
  test('a word stays up for base × factor, then advances', () => {
    const page = pageOf('One two three.')
    const s = started(page)
    expect(tick(s, page, 99).state.index).toBe(0)
    expect(tick(tick(s, page, 60), page, 60).state.index).toBe(1)
  })
  test('ticks that change nothing keep the same state object', () => {
    const page = pageOf('One two three.')
    const s = started(page)
    expect(tick(s, page, 20).state).toBe(s.state)
  })
  test('space pauses and resumes', () => {
    const page = pageOf('One two three.')
    const paused = press(started(page), page, ' ')
    expect(paused.state.mode).toBe('paused')
    expect(tick(paused, page, 1000).state.index).toBe(0)
    expect(press(paused, page, 'space').state.mode).toBe('cue')
  })
  test('up and down change speed within range', () => {
    const page = pageOf('One.')
    const s = started(page)
    expect(press(s, page, 'up').state.wpm).toBe(625)
    expect(press(s, page, 'down').state.wpm).toBe(575)
  })
})

describe('back', () => {
  const page = pageOf('One two three. Four five six. Seven eight.')
  test('early in a sentence goes to the previous one', () => {
    const s = at(started(page), page, 4) // "five", sentence 1, clock fresh
    expect(back(s, page).state).toMatchObject({ mode: 'playing', index: 0 })
  })
  test('more than 1.5s into a sentence restarts it', () => {
    const s = at(started(page), page, 4)
    const later = { ...s, clock: { itemMs: 0, sentenceMs: 1600 } }
    expect(back(later, page).state.index).toBe(3)
  })
  test('from a pause it jumps, cues, and keeps playing', () => {
    const s = press(at(started(page), page, 4), page, ' ')
    expect(press(s, page, 'left').state).toMatchObject({ mode: 'cue', index: 0 })
  })
  test('while playing it jumps without a cue: the eye is already there', () => {
    const s = at(started(page), page, 4)
    expect(press(s, page, 'left').state).toMatchObject({ mode: 'playing', index: 0 })
  })
  test('at the first sentence of a later page it asks for the previous page', () => {
    const later = pageOf('One two.', { pageIndex: 2, pageCount: 3 })
    const s = started(later)
    expect(back(s, later).state).toMatchObject({ mode: 'waiting', want: { index: 1, at: 'end' } })
  })
})

describe('blocks and headings', () => {
  const page = pageOf('# Title\n\nWord one.\n\n| a | b |\n\nAfter.')
  test('a heading shows for 1.5s, then advances', () => {
    const s = started(page)
    expect(s.state.mode).toBe('heading')
    expect(tick(s, page, 1400).state.index).toBe(0)
    expect(tick(tick(s, page, 1400), page, 200).state).toMatchObject({ mode: 'playing', index: 1 })
  })
  test('a block holds until Enter; arrows scroll it', () => {
    const s = at(started(page), page, 3)
    expect(s.state.mode).toBe('block')
    expect(tick(s, page, 60000).state.index).toBe(3)
    expect(press(s, page, 'down').state.scroll).toBe(1)
    expect(press(s, page, 'down').state.wpm).toBe(600)
    expect(press(s, page, 'return').state).toMatchObject({ mode: 'cue', index: 4 })
  })
})

describe('pages and the end', () => {
  test('the end of a page asks for the next one, and landing resumes there', () => {
    const first = pageOf('One.', { pageCount: 2 })
    const waiting = advance(started(first), first)
    expect(waiting.state).toMatchObject({ mode: 'waiting', want: { index: 1, at: 'start' } })
    const second = pageOf('Two three. Four.', { pageIndex: 1, pageCount: 2 })
    expect(land(waiting, second).state).toMatchObject({ mode: 'playing', pageIndex: 1, index: 0 })
  })
  test('going back lands on the last sentence of the previous page', () => {
    const later = pageOf('One two.', { pageIndex: 1, pageCount: 2 })
    const waiting = back(started(later), later)
    const previous = pageOf('A b. C d e.', { pageIndex: 0, pageCount: 2 })
    expect(land(waiting, previous).state).toMatchObject({ pageIndex: 0, index: 2 })
  })
  test('the last word finishes; Enter then closes', () => {
    const page = pageOf('Only.')
    const done = advance(started(page), page)
    expect(done.state.mode).toBe('done')
    expect(press(done, page, 'return').state.mode).toBe('closing')
  })
})

describe('resume', () => {
  const page = pageOf('One two. Three four. Five six.', { resumeAt: 3 })
  test('a click offers to resume; Enter goes to that sentence', () => {
    const offered = click(initial(page, 300), page)
    expect(offered.state.mode).toBe('resume')
    expect(press(offered, page, 'return').state).toMatchObject({ mode: 'cue', index: 2 })
  })
  test('r starts over', () => {
    const offered = click(initial(page, 300), page)
    expect(press(offered, page, 'r').state).toMatchObject({ mode: 'cue', index: 0 })
  })
})

describe('cue', () => {
  const page = pageOf('One two three.')
  test('blinks for a second at the focal point, then the word plays', () => {
    const s = begun(page)
    expect(s.state.isCueShown).toBe(true)
    expect(tick(s, page, 300).state).toMatchObject({ mode: 'cue', isCueShown: false, index: 0 })
    expect(tick(s, page, 600).state).toMatchObject({ mode: 'cue', isCueShown: true, index: 0 })
    const played = tick(s, page, CUE_MS)
    expect(played.state).toMatchObject({ mode: 'playing', index: 0 })
    expect(tick(played, page, 99).state.index).toBe(0)
  })
  test('space during the cue pauses', () => {
    expect(press(begun(page), page, ' ').state.mode).toBe('paused')
  })
})
