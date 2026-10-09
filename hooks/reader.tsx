import type { ClientModule, RenderElement } from 'claude-code'

import type { BlockKind, Cost, Item } from './parse'
import { costOf, flatten } from './parse'
import type { Clock, Page, ReaderProps, ReaderState, Snapshot, Step } from './reader-core'
import { click, initial, isSameSnapshot, land, press, snapshot, tick } from './reader-core'
import { baseMs, orpIndex } from './timing'

const TICK_MS = 20
const CONTEXT_WORDS = 60
const FRESH: Clock = { itemMs: 0, sentenceMs: 0 }

const BLOCK_LABEL: Record<BlockKind, string> = {
  table: 'Table',
  code: 'Code',
  diagram: 'Diagram',
  list: 'List',
  quote: 'Quote',
  math: 'Math',
  image: 'Image',
}

// One reader instance at a time: its page, clock and last post live beside its state.
let docId = ''
let page: Page = { items: [], pageIndex: 0, pageCount: 1 }
let pageKey = ''
let remaining: Cost[] = []
let clock: Clock = FRESH
let posted: Snapshot | undefined

const derive = (props: ReaderProps) => {
  const key = `${props.docId}:${props.pageIndex}`
  if (key === pageKey) return
  pageKey = key
  const items = flatten(props.paras)
  page = {
    items,
    pageIndex: props.pageIndex,
    pageCount: props.pageCount,
    ...(props.resumeAt !== undefined && { resumeAt: props.resumeAt }),
  }
  // remaining[i]: what items[i..] cost to read.
  remaining = new Array<Cost>(items.length + 1)
  remaining[items.length] = { units: 0, fixedMs: 0, words: 0 }
  for (let i = items.length - 1; i >= 0; i--) {
    const own = costOf(items.slice(i, i + 1))
    const rest = remaining[i + 1] as Cost
    remaining[i] = { units: own.units + rest.units, fixedMs: own.fixedMs + rest.fixedMs, words: own.words + rest.words }
  }
}

const formatLeft = (ms: number): string => {
  const minutes = Math.round(ms / 60000)
  if (minutes >= 1) return `~${minutes} min left`

  return `~${Math.max(1, Math.round(ms / 1000))} s left`
}

// Show a block whole, keeping a table's header and a fence's markers while scrolling.
// A drawn table takes about two rows per markdown row (a border between rows).
const windowBlock = (item: Extract<Item, { kind: 'block' }>, room: number, scroll: number, width: number) => {
  const lines = item.markdown.split('\n')
  const isTable = item.block === 'table'
  const isFenced = item.block === 'code' || item.block === 'diagram' || item.block === 'math'
  const head = isTable ? lines.slice(0, 2) : isFenced ? lines.slice(0, 1) : []
  const tail = isFenced && lines.length > 1 ? lines.slice(-1) : []
  const body = lines.slice(head.length, lines.length - tail.length)
  const fits = isTable ? Math.max(1, Math.floor((room - 3) / 2)) : Math.max(1, room - head.length - tail.length)
  const maxScroll = Math.max(0, body.length - fits)
  const from = Math.min(scroll, maxScroll)
  const shown = body.slice(from, from + fits)
  const height = isTable
    ? 3 + 2 * shown.length
    : [...head, ...shown, ...tail].reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0)

  return { text: [...head, ...shown, ...tail].join('\n'), canScroll: maxScroll > 0, height }
}

const Reader: ClientModule<ReaderProps, ReaderState> = (props, surface) => {
  const { Box, Text, Markdown } = surface.elements
  const isNew = surface.state === undefined
  // A new instance, or /speedread run again on another document: start fresh.
  const isFresh = isNew || props.docId !== docId
  if (isFresh) {
    docId = props.docId
    pageKey = ''
    clock = FRESH
    posted = undefined
  }
  derive(props)

  const current = (): Step => ({ state: surface.state ?? initial(page, props.wpm).state, clock })
  const commit = (step: Step) => {
    clock = step.clock
    if (step.state !== surface.state) surface.setState(step.state)
    const snap = snapshot(step, page)
    if (snap.mode === 'start' || isSameSnapshot(posted, snap)) return
    posted = snap
    surface.post(snap)
  }

  if (isFresh) surface.setState(initial(page, props.wpm).state)
  if (isNew) {
    surface.every(TICK_MS, () => commit(tick(current(), page, TICK_MS)))
    surface.onPointer(event => {
      if (event.type === 'down') commit(click(current(), page))
    })
    surface.onKey(event => commit(press(current(), page, event.key)))
  }

  let state = isFresh ? initial(page, props.wpm).state : current().state
  if (state.mode === 'waiting') {
    const landed = land(current(), page)
    if (landed.state !== state) {
      commit(landed)
      state = landed.state
    }
  }

  const columns = surface.columns || 80
  const rows = surface.rows || 20
  const center = Math.floor(columns / 2)
  const item = page.items[state.index]
  const before = props.before
  const pageWords = remaining[0]?.words ?? 0
  const totalWords = before.words + pageWords + props.after.words
  const wordsAt = (index: number) => before.words + pageWords - (remaining[index]?.words ?? 0)
  const left = remaining[state.index] ?? remaining[remaining.length - 1]
  const leftMs =
    ((left?.units ?? 0) + props.after.units) * baseMs(state.wpm) + (left?.fixedMs ?? 0) + props.after.fixedMs
  const done = state.mode === 'done' ? totalWords : wordsAt(state.index)
  const percent = totalWords ? Math.round((done / totalWords) * 100) : 100

  // The focal column's tick marks around one row: a word, or the cue dot.
  const framed = (row: RenderElement) => (
    <Box flexDirection="column">
      <Box marginLeft={center}>
        <Text dimColor>│</Text>
      </Box>
      {row}
      <Box marginLeft={center}>
        <Text dimColor>│</Text>
      </Box>
    </Box>
  )

  const focal = (word: string) => {
    const k = orpIndex(word)
    const pad = Math.max(0, Math.min(center - k, columns - word.length - 1))

    return framed(
      <Box key="word" flexDirection="row" marginLeft={pad}>
        <Text>{word.slice(0, k)}</Text>
        <Text color="error" bold>
          {word.slice(k, k + 1)}
        </Text>
        <Text>{word.slice(k + 1)}</Text>
      </Box>,
    )
  }

  // Where the next word lands, blinking, so the eye can find it first.
  const cueDot = () =>
    framed(
      <Box key="cue" marginLeft={center}>
        <Text color="error" bold>
          {state.isCueShown ? '●' : ' '}
        </Text>
      </Box>,
    )

  const room = rows - 5
  const block = state.mode === 'block' && item?.kind === 'block' ? windowBlock(item, room, state.scroll, columns - 2) : undefined

  const centered = (main: string, sub?: string) => (
    <Box flexDirection="column" alignItems="center">
      <Text bold>{main}</Text>
      {sub && <Text dimColor>{sub}</Text>}
    </Box>
  )

  // The paragraph around the current word, so a pause can re-read without stepping back.
  const context = () => {
    if (item?.kind !== 'word') return undefined
    const words = page.items.filter(one => one.kind === 'word' && one.paragraph === item.paragraph)
    const at = words.indexOf(item)
    const from = Math.max(0, at - CONTEXT_WORDS)
    const to = Math.min(words.length, at + CONTEXT_WORDS + 1)
    const text = (list: Item[]) => list.map(one => (one.kind === 'word' ? one.text : '')).join(' ')

    return (
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>
          {from > 0 ? '… ' : ''}
          {text(words.slice(from, at))} <Text inverse>{item.text}</Text> {text(words.slice(at + 1, to))}
          {to < words.length ? ' …' : ''}
        </Text>
      </Box>
    )
  }

  const body = () => {
    switch (state.mode) {
      case 'start':
        return centered('Click here to start', 'Then: Space pause · ← back · ↑↓ speed · Enter past tables · q close')
      case 'resume':
        return centered(
          `Resume where you left off (${Math.round((wordsAt(page.resumeAt ?? 0) / Math.max(1, totalWords)) * 100)}%)?`,
          'Enter resume · r start over',
        )
      case 'done':
        return centered(`Done · ${totalWords} words`, 'Enter close · ← go back')
      case 'waiting':
      case 'closing':
        return <Text> </Text>
      case 'heading':
        return item?.kind === 'heading' ? centered(item.text) : undefined
      case 'block':
        if (item?.kind !== 'block' || !block) return undefined

        return (
          <Box flexDirection="column" alignItems="center" paddingX={1}>
            <Text dimColor>
              {BLOCK_LABEL[item.block]} · Enter to continue{block.canScroll ? ' · ↑↓ scroll' : ''} · ← back
            </Text>
            <Markdown text={block.text} />
          </Box>
        )
      case 'cue':
        return cueDot()
      case 'paused':
        if (item?.kind === 'heading') return centered(item.text, 'paused')

        return (
          <Box flexDirection="column">
            {item?.kind === 'word' && focal(item.text)}
            {context()}
          </Box>
        )
      default:
        return item?.kind === 'word' ? focal(item.text) : undefined
    }
  }

  const label = ` ${percent}% · ${formatLeft(leftMs)} · ${state.wpm} wpm`
  const barWidth = Math.max(0, columns - label.length - 1)
  const filled = Math.round((barWidth * percent) / 100)
  const isPlaying = state.mode === 'playing' || state.mode === 'heading' || state.mode === 'cue'
  // Centre everything; only a block too tall to fit starts at the top.
  const isTallBlock = block !== undefined && block.height > room

  return (
    <Box flexDirection="column" height={rows}>
      <Box flexGrow={1} flexDirection="column" justifyContent={isTallBlock ? 'flex-start' : 'center'} overflow="hidden">
        {body()}
      </Box>
      <Box flexDirection="row">
        <Text color="claude">{'━'.repeat(filled)}</Text>
        <Text dimColor>{'─'.repeat(barWidth - filled)}</Text>
        <Text dimColor>{label}</Text>
      </Box>
      <Text dimColor>{isPlaying ? ' ' : 'Space play/pause · ← back · ↑↓ speed · Enter continue · q close'}</Text>
    </Box>
  )
}

export default Reader
