import { describe, expect, test } from 'claude-code/testing'

import { flatten, paginate, parse, splitSentences, tokenize } from '../hooks/parse'

const FIXTURE = [
  '---',
  'title: front matter is skipped',
  '---',
  '# Findings',
  '',
  'RSVP shows one word at a time. Readers lose regressions, e.g. glancing back.',
  'Dr. Smith agreed.',
  '',
  '| Key | Action |',
  '|---|---|',
  '| Space | pause |',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '```',
  '',
  '- first item',
  '- second item',
  '  continued',
  '',
  '> a quoted line',
  '',
  '$$',
  'e = mc^2',
  '$$',
  '',
  '![a chart](chart.png)',
  '',
  'Last paragraph here.',
].join('\n')

describe('parse', () => {
  test('splits a mixed document into headings, prose and blocks', () => {
    const paras = parse(FIXTURE)
    expect(paras.map(p => (p.kind === 'block' ? p.block : p.kind))).toEqual([
      'heading', 'text', 'table', 'code', 'diagram', 'list', 'quote', 'math', 'image', 'text',
    ])
  })
  test('blocks keep their markdown whole', () => {
    const table = parse(FIXTURE).find(p => p.kind === 'block' && p.block === 'table')
    expect(table).toEqual({ kind: 'block', block: 'table', markdown: '| Key | Action |\n|---|---|\n| Space | pause |' })
    const list = parse(FIXTURE).find(p => p.kind === 'block' && p.block === 'list')
    expect(list).toEqual({ kind: 'block', block: 'list', markdown: '- first item\n- second item\n  continued' })
  })
  test('lists can read as prose instead', () => {
    const paras = parse('- first item\n- second item', false)
    expect(paras).toEqual([
      { kind: 'text', sentences: [['first', 'item']] },
      { kind: 'text', sentences: [['second', 'item']] },
    ])
  })
  test('abbreviations and initials do not end a sentence', () => {
    const prose = parse(FIXTURE)[1]
    expect(prose?.kind === 'text' && prose.sentences.map(s => s.join(' '))).toEqual([
      'RSVP shows one word at a time.',
      'Readers lose regressions, e.g. glancing back.',
      'Dr. Smith agreed.',
    ])
    expect(splitSentences(tokenize('J. Doe left. Then x.')).length).toBe(2)
  })
})

describe('tokenize', () => {
  test('strips inline markup but keeps identifiers', () => {
    expect(tokenize('**bold** and [link](http://x) with `code` and snake_case_name.')).toEqual([
      'bold', 'and', 'link', 'with', 'code', 'and', 'snake_case_name.',
    ])
  })
  test('a lone dash rides on the word before it', () => {
    expect(tokenize('fast — really')).toEqual(['fast —', 'really'])
  })
})

describe('flatten', () => {
  test('numbers sentences across prose and blocks, and marks paragraph ends', () => {
    const items = flatten(parse('One two. Three.\n\n| a |\n\nFour.'))
    expect(items.map(i => [i.kind === 'word' ? i.text : i.kind, i.sentence, i.paragraph])).toEqual([
      ['One', 0, 0], ['two.', 0, 0], ['Three.', 1, 0], ['block', 2, 1], ['Four.', 3, 2],
    ])
    const three = items[2]
    expect(three?.kind === 'word' && three.factor).toBe(3)
  })
})

describe('paginate', () => {
  test('keeps every page under the limit, in order', () => {
    const prose = Array.from({ length: 400 }, (_, n) => `Paragraph ${n} has a few words in it.`).join('\n\n')
    const pages = paginate(parse(prose), 2000)
    expect(pages.length).toBeGreaterThan(5)
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThanOrEqual(2000)
    expect(pages.flat().length).toBe(400)
  })
  test('truncates a block too large for any page', () => {
    const huge = `| ${'x'.repeat(5000)} |`
    const [page] = paginate(parse(huge), 2000)
    const block = page?.[0]
    expect(block?.kind === 'block' && block.markdown.endsWith('(truncated: too large to show whole)')).toBe(true)
  })
})
