import { HEADING_MS, wordFactor } from './timing'

// Markdown in, a flat list of things to show out: words to flash, headings to
// card, and blocks (tables, code, lists...) to show whole until Enter.

// Claude's replies are list-heavy, so lists show whole unless the listsAsProse option is on.
export const LISTS_AS_BLOCKS = true

// A Client's props are capped at 100k serialized chars; leave headroom.
export const PAGE_LIMIT = 60000

export type BlockKind = 'table' | 'code' | 'diagram' | 'list' | 'quote' | 'math' | 'image'

export type Para =
  | { kind: 'text'; sentences: string[][] }
  | { kind: 'heading'; text: string }
  | { kind: 'block'; block: BlockKind; markdown: string }

type Place = { sentence: number; paragraph: number }

export type Item =
  | ({ kind: 'word'; text: string; factor: number } & Place)
  | ({ kind: 'heading'; text: string } & Place)
  | ({ kind: 'block'; block: BlockKind; markdown: string } & Place)

const FENCE = /^(`{3,}|~{3,})\s*([\w+-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^([-*_])(\s*\1){2,}\s*$/
const IMAGE_LINE = /^!\[[^\]]*\]\([^)]*\)\s*$/
const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/
const CONTINUATION = /^\s{2,}\S/
const HTML_LINE = /^<\/?[a-zA-Z][^>]*>\s*$/
const HAS_WORD = /[\p{L}\p{N}]/u
const CLOSERS = `"')]’”`
const SENTENCE_END = /[.!?]["')\]’”]*$/
const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'al.', 'approx.', 'fig.', 'no.', 'mr.', 'mrs.', 'ms.',
  'dr.', 'st.', 'jr.', 'sr.', 'inc.', 'ltd.', 'co.', 'u.s.', 'u.k.', 'a.m.', 'p.m.',
])

export const stripInline = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/`+/g, '')
    .replace(/~~/g, '')

// Emphasis markers come off the ends of a token only, so snake_case survives.
const cleanToken = (token: string): string =>
  token.replace(/^[*_]+/, '').replace(/[*_]+(?=["')\].,;:!?’”]*$)/, '')

export const tokenize = (text: string): string[] => {
  const tokens: string[] = []
  for (const raw of stripInline(text).split(/\s+/)) {
    const token = cleanToken(raw)
    if (!token) continue
    const previous = tokens.length - 1
    // A lone dash or symbol rides on the word before it.
    if (!HAS_WORD.test(token) && previous >= 0) tokens[previous] += ` ${token}`
    else tokens.push(token)
  }

  return tokens
}

const isSentenceEnd = (token: string): boolean => {
  if (!SENTENCE_END.test(token)) return false
  const bare = token.replace(/^["'(\[‘“]+/, '').replace(new RegExp(`[${CLOSERS}\\]]+$`), '')
  if (ABBREVIATIONS.has(bare.toLowerCase())) return false

  return !/^\p{Lu}\.$/u.test(bare)
}

export const splitSentences = (tokens: string[]): string[][] => {
  const sentences: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    current.push(token)
    if (isSentenceEnd(token)) {
      sentences.push(current)
      current = []
    }
  }
  if (current.length) sentences.push(current)

  return sentences
}

const textPara = (text: string): Para | undefined => {
  const sentences = splitSentences(tokenize(text))

  return sentences.length ? { kind: 'text', sentences } : undefined
}

const listItemTexts = (lines: string[]): string[] => {
  const items: string[] = []
  for (const line of lines) {
    if (LIST_ITEM.test(line)) items.push(line.replace(LIST_ITEM, ''))
    else if (line.trim() && items.length) items[items.length - 1] += ` ${line.trim()}`
  }

  return items
}

export const parse = (source: string, listsAsBlocks = LISTS_AS_BLOCKS): Para[] => {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const paras: Para[] = []
  let text: string[] = []
  let i = 0

  const flush = () => {
    const para = textPara(text.join(' '))
    if (para) paras.push(para)
    text = []
  }
  const takeWhile = (keep: (line: string) => boolean): string[] => {
    const taken: string[] = []
    while (i < lines.length && keep(lines[i] ?? '')) taken.push(lines[i++] ?? '')

    return taken
  }

  // Front matter.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, n) => n > 0 && line.trim() === '---')
    if (end > 0) i = end + 1
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    const fence = FENCE.exec(trimmed)
    const heading = HEADING.exec(trimmed)

    if (!trimmed) {
      flush()
      i++
    } else if (fence) {
      flush()
      const marker = fence[1] ?? '```'
      i++
      const body = takeWhile(next => !next.trim().startsWith(marker))
      i++
      const block: BlockKind = fence[2] === 'mermaid' ? 'diagram' : 'code'
      paras.push({ kind: 'block', block, markdown: [line, ...body, marker].join('\n') })
    } else if (trimmed.startsWith('$$')) {
      flush()
      const isOneLine = trimmed.length > 4 && trimmed.endsWith('$$')
      i++
      const body = isOneLine ? [] : takeWhile(next => !next.trim().endsWith('$$'))
      const close = isOneLine ? [] : [lines[i++] ?? '']
      paras.push({ kind: 'block', block: 'math', markdown: [line, ...body, ...close].join('\n') })
    } else if (heading && !line.startsWith('    ')) {
      flush()
      paras.push({ kind: 'heading', text: tokenize(heading[2] ?? '').join(' ') })
      i++
    } else if (RULE.test(trimmed) || HTML_LINE.test(trimmed)) {
      flush()
      i++
    } else if (trimmed.startsWith('|')) {
      flush()
      const rows = takeWhile(next => next.trim().startsWith('|'))
      paras.push({ kind: 'block', block: 'table', markdown: rows.join('\n') })
    } else if (trimmed.startsWith('>')) {
      flush()
      const quote = takeWhile(next => next.trim().startsWith('>'))
      paras.push({ kind: 'block', block: 'quote', markdown: quote.join('\n') })
    } else if (IMAGE_LINE.test(trimmed)) {
      flush()
      paras.push({ kind: 'block', block: 'image', markdown: trimmed })
      i++
    } else if (LIST_ITEM.test(line)) {
      flush()
      const items = takeWhile(next => {
        if (LIST_ITEM.test(next) || CONTINUATION.test(next)) return true
        if (next.trim()) return false
        const after = lines[i + 1] ?? ''

        return LIST_ITEM.test(after) || CONTINUATION.test(after)
      })
      if (listsAsBlocks) paras.push({ kind: 'block', block: 'list', markdown: items.join('\n') })
      else for (const item of listItemTexts(items)) {
        const para = textPara(item)
        if (para) paras.push(para)
      }
    } else {
      text.push(trimmed)
      i++
    }
  }
  flush()

  return paras
}

export const flatten = (paras: Para[]): Item[] => {
  const items: Item[] = []
  let sentence = 0
  paras.forEach((para, paragraph) => {
    if (para.kind !== 'text') {
      items.push({ ...para, sentence: sentence++, paragraph })

      return
    }
    const lastSentence = para.sentences.length - 1
    para.sentences.forEach((words, s) => {
      words.forEach((text, w) => {
        const isParagraphEnd = s === lastSentence && w === words.length - 1
        items.push({ kind: 'word', text, factor: wordFactor(text, isParagraphEnd), sentence, paragraph })
      })
      sentence++
    })
  })

  return items
}

const size = (value: unknown): number => JSON.stringify(value).length

// Oversized single paragraphs are split by sentence, oversized blocks truncated.
const fitPara = (para: Para, limit: number): Para[] => {
  if (size(para) <= limit) return [para]
  if (para.kind === 'block') {
    const note = '\n\n… (truncated: too large to show whole)'

    return [{ ...para, markdown: para.markdown.slice(0, limit - 1000) + note }]
  }
  if (para.kind === 'heading') return [{ ...para, text: para.text.slice(0, limit - 100) }]
  const parts: Para[] = []
  let sentences: string[][] = []
  for (const sentence of para.sentences) {
    if (sentences.length && size(sentences) + size(sentence) > limit - 100) {
      parts.push({ kind: 'text', sentences })
      sentences = []
    }
    sentences.push(sentence)
  }
  if (sentences.length) parts.push({ kind: 'text', sentences })

  return parts
}

export const paginate = (paras: Para[], limit = PAGE_LIMIT): Para[][] => {
  const pages: Para[][] = []
  let page: Para[] = []
  let used = 2
  for (const para of paras.flatMap(one => fitPara(one, limit))) {
    const cost = size(para) + 1
    if (page.length && used + cost > limit) {
      pages.push(page)
      page = []
      used = 2
    }
    page.push(para)
    used += cost
  }
  if (page.length) pages.push(page)

  return pages
}

// What a stretch of items costs to read: word units (× the base delay) plus fixed ms.
export type Cost = { units: number; fixedMs: number; words: number }

export const costOf = (items: Item[]): Cost =>
  items.reduce(
    (cost, item) => ({
      units: cost.units + (item.kind === 'word' ? item.factor : 0),
      fixedMs: cost.fixedMs + (item.kind === 'heading' ? HEADING_MS : 0),
      words: cost.words + (item.kind === 'word' ? 1 : 0),
    }),
    { units: 0, fixedMs: 0, words: 0 },
  )
