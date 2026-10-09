import type { EngineInterface, Register } from 'claude-code'

import type { Cost, Para } from './parse'
import { costOf, flatten, paginate, parse } from './parse'
import type { ReaderProps, Snapshot } from './reader-core'
import { DEFAULT_WPM, clampWpm } from './timing'

const PANE = 'speedread'
const WPM_KEY = 'wpm'
const RESUME_PREFIX = 'pos:'
const MAX_RESUMES = 50
const READABLE = /\.(md|markdown|txt)$/i
const PASTE = 'paste'

type Source = { text: string; title: string; isFile: boolean }

type Doc = {
  id: string
  title: string
  pages: Para[][]
  costs: Cost[]
  pageIndex: number
  wpm: number
  resumeKey?: string
  resumeAt?: number
}

// The open document; one pane, one document at a time.
let doc: Doc | undefined

// Set by /speedread paste: the pane width to open the next prompt at, in place of sending it.
let pasteColumns: number | undefined

const NO_COST: Cost = { units: 0, fixedMs: 0, words: 0 }

const sum = (costs: Cost[]): Cost =>
  costs.reduce(
    (a, b) => ({ units: a.units + b.units, fixedMs: a.fixedMs + b.fixedMs, words: a.words + b.words }),
    NO_COST,
  )

// FNV-1a: a cheap content fingerprint, so an edited file starts over.
const fingerprint = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return `${(hash >>> 0).toString(16)}-${text.length}`
}

const propsFor = (d: Doc, pageIndex: number): ReaderProps => ({
  docId: d.id,
  title: d.title,
  paras: d.pages[pageIndex] ?? [],
  pageIndex,
  pageCount: d.pages.length,
  wpm: d.wpm,
  ...(d.resumeAt !== undefined && { resumeAt: d.resumeAt }),
  before: sum(d.costs.slice(0, pageIndex)),
  after: sum(d.costs.slice(pageIndex + 1)),
})

const isSnapshot = (data: unknown): data is Snapshot =>
  typeof data === 'object' && data !== null && 'mode' in data && 'pageIndex' in data && 'wpm' in data

const asPosition = (value: unknown): { pageIndex: number; index: number } | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const { pageIndex, index } = value as Record<string, unknown>

  return typeof pageIndex === 'number' && typeof index === 'number' ? { pageIndex, index } : undefined
}

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  return /ENOENT/.test(message) ? 'file not found' : message
}

const loadSource = async ($: EngineInterface, args: string): Promise<Source | string> => {
  let path = args.trim().replace(/^["']|["']$/g, '')
  if (path) {
    if (!READABLE.test(path)) return 'reads .md and .txt files only.'
    if (path.startsWith('~/')) path = `${(await $.env.get('HOME')) ?? '~'}${path.slice(1)}`
    try {
      return { text: await $.fs.read(path), title: path.split('/').pop() ?? path, isFile: true }
    } catch (error) {
      return `could not read ${path} (${describeError(error)}).`
    }
  }
  const reply = (await $.session.messages()).findLast(m => m.role === 'assistant' && m.text.trim())

  return reply
    ? { text: reply.text, title: 'Claude’s last reply', isFile: false }
    : 'there is no Claude reply to read yet.'
}

const pruneResumes = async ($: EngineInterface) => {
  const keys = (await $.store.keys()).filter(key => key.startsWith(RESUME_PREFIX))
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RESUMES))) await $.store.delete(key)
}

const awaitPaste = ($: EngineInterface, columns: number | undefined) => {
  pasteColumns = columns
  $.ui.status(columns === undefined ? undefined : 'speedread: your next prompt opens in the reader, not Claude')
}

// Opens the pane on a source; returns why not, if it could not.
const openReader = async (
  $: EngineInterface,
  source: Source,
  columns: number,
  listsAsBlocks: boolean,
): Promise<string | undefined> => {
  const pages = paginate(parse(source.text, listsAsBlocks))
  if (!pages.length) return 'nothing to read there.'

  const id = fingerprint(source.text)
  const storedWpm = await $.store.get(WPM_KEY)
  const resumeKey = source.isFile ? `${RESUME_PREFIX}${id}` : undefined
  const resume = resumeKey ? asPosition(await $.store.get(resumeKey)) : undefined
  const isResumable = resume !== undefined && resume.pageIndex < pages.length
  doc = {
    id,
    title: source.title,
    pages,
    costs: pages.map(page => costOf(flatten(page))),
    pageIndex: isResumable ? resume.pageIndex : 0,
    wpm: clampWpm(typeof storedWpm === 'number' ? storedWpm : DEFAULT_WPM),
    ...(resumeKey && { resumeKey }),
    ...(isResumable && { resumeAt: resume.index }),
  }
  if (resumeKey) await pruneResumes($)

  const opened = await $.ui.open({
    id: PANE,
    title: `speedread · ${source.title}`,
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    columns,
  })
  $.ui.invalidate('ui.render')

  return opened.isPlaced ? undefined : `the pane could not be placed (${opened.reason}).`
}

export const register: Register = (on, options) => {
  const listsAsBlocks = options.listsAsProse !== true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'speedread',
      description: 'Read a markdown file, pasted text, or Claude’s last reply one word at a time',
      argumentHint: '[file.md | paste]',
    })

    return next(e)
  })

  on('command.run', { command: 'speedread' }, async ($, e) => {
    const columns = Math.max(40, Math.floor(e.presentation.columns * 0.85))
    const wasAwaiting = pasteColumns !== undefined
    awaitPaste($, undefined)
    if (e.args.trim() === PASTE) {
      if (wasAwaiting) return { text: 'paste cancelled.' }
      awaitPaste($, columns)

      return { text: 'paste your text and press Enter: it opens in the reader instead of going to Claude. /speedread paste again cancels.' }
    }

    const source = await loadSource($, e.args)
    if (typeof source === 'string') return { text: source }
    const problem = await openReader($, source, columns, listsAsBlocks)

    return problem ? { text: problem } : {}
  })

  // After /speedread paste, the person's next prompt is the text to read; it never reaches Claude.
  on('prompt.submit', async ($, e, next) => {
    if (pasteColumns === undefined || e.origin.kind !== 'composer') return next(e)
    const columns = pasteColumns
    awaitPaste($, undefined)
    const problem = await openReader($, { text: e.text, title: 'pasted text', isFile: false }, columns, listsAsBlocks)

    return { drop: problem ?? 'opened in speedread, not sent to Claude.' }
  }).catch(($, e, next) => (next.called ? next(e) : { drop: 'speedread could not open the reader; nothing was sent to Claude.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)

      return <Text>speedread needs the terminal or the desktop app.</Text>
    }
    const { Client, Text } = $.ui.resolve(e)
    if (!doc) return <Text dimColor>Nothing loaded. Run /speedread again.</Text>

    return (
      <Client
        key="reader"
        module="./reader.tsx"
        props={propsFor(doc, doc.pageIndex)}
        height={e.props.scroll.bodyRows}
        flexGrow={1}
      />
    )
  })

  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || !doc || !isSnapshot(e.data)) return next(e)
    const snap = e.data
    if (snap.mode === 'closing') {
      await $.ui.close({ id: PANE })

      return {}
    }
    if (snap.wpm !== doc.wpm) {
      doc.wpm = snap.wpm
      await $.store.set(WPM_KEY, snap.wpm)
    }
    if (snap.mode !== 'start' && snap.mode !== 'resume') {
      delete doc.resumeAt
      if (doc.resumeKey && snap.mode === 'done') await $.store.delete(doc.resumeKey)
      else if (doc.resumeKey) await $.store.set(doc.resumeKey, { pageIndex: snap.pageIndex, index: snap.index })
    }
    if (snap.want) {
      doc.pageIndex = snap.want.index

      return { props: propsFor(doc, snap.want.index) }
    }

    return {}
  })
}
