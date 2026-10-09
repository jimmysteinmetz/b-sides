import type { Cost, Item, Para } from './parse'
import { HEADING_MS, WPM_STEP, baseMs, clampWpm } from './timing'

// The reader as a pure state machine: register.tsx feeds it pages, reader.tsx
// feeds it ticks, clicks and keys, and draws whatever state comes back.

// Back restarts the current sentence after this long in it, else goes one further.
export const BACK_RESTART_MS = 1500

// Coming back to words after the eye was elsewhere, the focal point blinks this long first.
export const CUE_MS = 1000
export const BLINK_MS = 250

export type Mode =
  | 'start'
  | 'resume'
  | 'cue'
  | 'playing'
  | 'paused'
  | 'heading'
  | 'block'
  | 'waiting'
  | 'done'
  | 'closing'

export type Landing = 'start' | 'end'

// What the hooks module hands the Client: one page of the document.
export type ReaderProps = {
  docId: string
  title: string
  paras: Para[]
  pageIndex: number
  pageCount: number
  wpm: number
  // Item index on this page to offer resuming at.
  resumeAt?: number
  before: Cost
  after: Cost
}

// What the Client posts back: a snapshot, so a later post loses nothing.
export type Snapshot = {
  mode: Mode
  pageIndex: number
  index: number
  wpm: number
  want?: { index: number; at: Landing }
}

export type ReaderState = {
  mode: Mode
  pageIndex: number
  index: number
  wpm: number
  scroll: number
  isCueShown: boolean
  want?: { index: number; at: Landing }
}

// Time spent on the current item and sentence; kept apart so ticks don't redraw.
export type Clock = { itemMs: number; sentenceMs: number }

export type Step = { state: ReaderState; clock: Clock }

export type Page = { items: Item[]; pageIndex: number; pageCount: number; resumeAt?: number }

const ZERO: Clock = { itemMs: 0, sentenceMs: 0 }

export const initial = (page: Page, wpm: number): Step => ({
  state: { mode: 'start', pageIndex: page.pageIndex, index: 0, wpm: clampWpm(wpm), scroll: 0, isCueShown: false },
  clock: ZERO,
})

const modeFor = (item: Item | undefined): Mode =>
  item?.kind === 'block' ? 'block' : item?.kind === 'heading' ? 'heading' : 'playing'

export const sentenceStart = (items: Item[], index: number): number => {
  const sentence = items[index]?.sentence

  return Math.max(0, items.findIndex(item => item.sentence === sentence))
}

// Views that take the eye off the focal point: words resuming after one get a cue.
const AWAY: ReadonlySet<Mode> = new Set(['start', 'resume', 'paused', 'block', 'done'])

const cue = (step: Step): Step => ({
  state: { ...step.state, mode: 'cue', isCueShown: true },
  clock: { ...step.clock, itemMs: 0 },
})

const goTo = (step: Step, items: Item[], index: number, isSameSentence: boolean): Step => {
  const mode = modeFor(items[index])
  const moved: Step = {
    state: { ...step.state, mode, index, scroll: 0, want: undefined },
    clock: { itemMs: 0, sentenceMs: isSameSentence ? step.clock.sentenceMs : 0 },
  }

  return mode === 'playing' && AWAY.has(step.state.mode) ? cue(moved) : moved
}

const withMode = (step: Step, mode: Mode): Step => ({ ...step, state: { ...step.state, mode } })

const request = (step: Step, index: number, at: Landing): Step => ({
  ...step,
  state: { ...step.state, mode: 'waiting', want: { index, at } },
})

export const advance = (step: Step, page: Page): Step => {
  const next = step.state.index + 1
  const { items } = page
  if (next < items.length) return goTo(step, items, next, items[next]?.sentence === items[step.state.index]?.sentence)
  if (page.pageIndex + 1 < page.pageCount) return request(step, page.pageIndex + 1, 'start')

  return withMode(step, 'done')
}

export const tick = (step: Step, page: Page, ms: number): Step => {
  const { state, clock } = step
  const item = page.items[state.index]
  if (state.mode === 'cue') {
    const itemMs = clock.itemMs + ms
    if (itemMs >= CUE_MS) return { state: { ...state, mode: 'playing' }, clock: { ...clock, itemMs: 0 } }
    const isCueShown = Math.floor(itemMs / BLINK_MS) % 2 === 0

    return { state: isCueShown === state.isCueShown ? state : { ...state, isCueShown }, clock: { ...clock, itemMs } }
  }
  if (state.mode === 'heading') {
    const itemMs = clock.itemMs + ms
    if (itemMs >= HEADING_MS) return advance(step, page)

    return { state, clock: { ...clock, itemMs } }
  }
  if (state.mode !== 'playing' || item?.kind !== 'word') return step
  const next = { itemMs: clock.itemMs + ms, sentenceMs: clock.sentenceMs + ms }
  if (next.itemMs >= baseMs(state.wpm) * item.factor) return advance({ state, clock: next }, page)

  return { state, clock: next }
}

export const back = (step: Step, page: Page): Step => {
  const { items } = page
  const index = step.state.mode === 'done' ? items.length - 1 : step.state.index
  const current = items[index]?.sentence ?? 0
  const target = step.clock.sentenceMs > BACK_RESTART_MS ? current : current - 1
  const first = items.findIndex(item => item.sentence === target)
  if (first >= 0) return goTo(step, items, first, false)
  if (page.pageIndex > 0) return request(step, page.pageIndex - 1, 'end')

  return goTo(step, items, 0, false)
}

export const click = (step: Step, page: Page): Step => {
  if (step.state.mode !== 'start') return step
  const isResumable = page.resumeAt !== undefined && (page.resumeAt > 0 || page.pageIndex > 0)

  return isResumable ? withMode(step, 'resume') : goTo(step, page.items, 0, false)
}

const isSpace = (key: string) => key === ' ' || key.toLowerCase() === 'space'

export const press = (step: Step, page: Page, key: string): Step => {
  const { state } = step
  const { items } = page

  if (state.mode === 'start' || state.mode === 'waiting' || state.mode === 'closing') return step
  if (state.mode === 'resume') {
    if (key === 'return') return goTo(step, items, sentenceStart(items, page.resumeAt ?? 0), false)
    if (key === 'r') return page.pageIndex > 0 ? request(step, 0, 'start') : goTo(step, items, 0, false)

    return step
  }
  if (key === 'q') return withMode(step, 'closing')
  if (key === 'left') return back(step, page)
  if (key === 'up' || key === 'down') {
    const delta = key === 'up' ? 1 : -1
    if (state.mode === 'block') {
      return { ...step, state: { ...state, scroll: Math.max(0, state.scroll - delta) } }
    }

    return { ...step, state: { ...state, wpm: clampWpm(state.wpm + delta * WPM_STEP) } }
  }
  if (key === 'return') {
    if (state.mode === 'block') return advance(step, page)
    if (state.mode === 'done') return withMode(step, 'closing')

    return step
  }
  if (isSpace(key)) {
    if (state.mode === 'playing' || state.mode === 'heading' || state.mode === 'cue') return withMode(step, 'paused')
    if (state.mode === 'paused') {
      const mode = modeFor(items[state.index])

      return mode === 'playing' ? cue(step) : withMode(step, mode)
    }
  }

  return step
}

// A requested page arrived: land at its start, or at its last sentence going back.
export const land = (step: Step, page: Page): Step => {
  const { want } = step.state
  if (step.state.mode !== 'waiting' || !want || want.index !== page.pageIndex) return step
  const index = want.at === 'start' ? 0 : sentenceStart(page.items, page.items.length - 1)
  const landed = goTo(step, page.items, index, false)

  return { ...landed, state: { ...landed.state, pageIndex: page.pageIndex } }
}

export const snapshot = (step: Step, page: Page): Snapshot => ({
  mode: step.state.mode,
  pageIndex: step.state.pageIndex,
  index: sentenceStart(page.items, step.state.index),
  wpm: step.state.wpm,
  ...(step.state.want && { want: step.state.want }),
})

export const isSameSnapshot = (a: Snapshot | undefined, b: Snapshot): boolean =>
  a !== undefined &&
  a.mode === b.mode &&
  a.pageIndex === b.pageIndex &&
  a.index === b.index &&
  a.wpm === b.wpm &&
  a.want?.index === b.want?.index &&
  a.want?.at === b.want?.at
