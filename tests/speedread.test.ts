import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const DOC = ['# Title', '', 'One two three. Four five.', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Last words.'].join(
  '\n',
)

const PANE = {
  plugin: 'speedread',
  component: 'Pane',
  requestId: 'speedread',
  props: {
    title: 'speedread',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// /speedread as the person types it in a wide fullscreen terminal.
const typed = (args = '') => ({
  command: 'speedread',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}) as const

const engineBeneath = (on: On, files: Record<string, string>) => {
  mock.store(on)
  on('fs.read', ($, e) => {
    const name = Object.keys(files).find(file => e.path === file || e.path.endsWith(`/${file}`))
    const text = name === undefined ? undefined : files[name]
    if (text === undefined) return { deny: `$.fs.read(${e.path}) failed: ENOENT` }

    return { value: text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
}

describe('speedread', () => {
  test('reads a file end to end: heading, words, pause, table, done', async ($, on) => {
    engineBeneath(on, { 'notes.md': DOC })
    for (const surface of SURFACES) {
      await $.command.run(typed('notes.md'))
      const ui = await $.ui.mount({ ...PANE, surface })
      const word = async () => (await ui.find({ in: 'reader', key: 'word' }))?.text

      expect(await ui.find({ in: 'reader', text: /Click here to start/ })).toBeDefined()
      await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
      expect(await ui.find({ in: 'reader', text: 'Title' })).toBeDefined()

      await ui.advance(1500)
      expect(await word()).toBe('One')
      await ui.advance(200)
      expect(await word()).toBe('two')

      await ui.key({ key: ' ' })
      await ui.advance(2000)
      expect(await word()).toBe('two')
      await ui.key({ key: ' ' })
      expect(await ui.find({ in: 'reader', key: 'cue' })).toBeDefined()
      await ui.advance(1000)
      expect(await word()).toBe('two')

      await ui.advance(2000)
      expect(await ui.find({ in: 'reader', text: /Table · Enter to continue/ })).toBeDefined()
      await ui.key({ key: 'return' })
      expect(await ui.find({ in: 'reader', key: 'cue' })).toBeDefined()
      await ui.advance(1000)
      expect(await word()).toBe('Last')

      await ui.advance(5000)
      expect(await ui.find({ in: 'reader', text: /Done · 7 words/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('back early in a sentence goes to the previous one', async ($, on) => {
    engineBeneath(on, { 'notes.md': DOC })
    await $.command.run(typed('notes.md'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    await ui.advance(2400) // heading 1500, "One two three." 840, then into "Four"
    expect((await ui.find({ in: 'reader', key: 'word' }))?.text).toBe('Four')
    await ui.key({ key: 'left' })
    expect((await ui.find({ in: 'reader', key: 'word' }))?.text).toBe('One')
  })

  test('reopening a file offers to resume at the sentence it stopped in', async ($, on) => {
    engineBeneath(on, { 'notes.md': DOC })
    await $.command.run(typed('notes.md'))
    const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await first.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    await first.advance(1500 + 200 + 200 + 440 + 100) // inside "Four five."
    await first.unmount()

    await $.command.run(typed('notes.md'))
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await again.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    expect(await again.find({ in: 'reader', text: /Resume where you left off/ })).toBeDefined()
    await again.key({ key: 'return' })
    await again.advance(1000)
    expect((await again.find({ in: 'reader', key: 'word' }))?.text).toBe('Four')
  })

  test('with no path it reads Claude’s last reply', async ($, on) => {
    engineBeneath(on, {})
    on('session.messages', () => ({ value: [
      { role: 'assistant', text: 'Older reply.', toolUses: [] },
      { role: 'user', text: 'and now?', toolUses: [] },
      { role: 'assistant', text: 'Newest answer here.', toolUses: [] },
    ] }))
    await $.command.run(typed())
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    await ui.advance(1000)
    expect((await ui.find({ in: 'reader', key: 'word' }))?.text).toBe('Newest')
  })

  test('/speedread paste reads the next prompt instead of sending it', async ($, on) => {
    engineBeneath(on, {})
    const sent: string[] = []
    on('prompt.submit', ($, e) => {
      sent.push(e.text)

      return { text: e.text }
    })
    const prompt = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

    expect((await $.command.run(typed('paste'))).text).toMatch(/press Enter/)
    expect((await prompt('Pasted words\n\nacross two paragraphs.')).drop).toMatch(/opened in speedread/)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.pointer({ type: 'down', x: 1, y: 1, button: 'left' })
    await ui.advance(1000)
    expect((await ui.find({ in: 'reader', key: 'word' }))?.text).toBe('Pasted')

    await prompt('a real question')
    expect(sent).toEqual(['a real question'])
  })

  test('/speedread paste twice cancels, and the prompt goes to Claude', async ($, on) => {
    engineBeneath(on, {})
    const sent: string[] = []
    on('prompt.submit', ($, e) => {
      sent.push(e.text)

      return { text: e.text }
    })
    await $.command.run(typed('paste'))
    expect((await $.command.run(typed('paste'))).text).toBe('paste cancelled.')
    await $.prompt.submit({ text: 'just a question', origin: { kind: 'composer' }, wait: false })
    expect(sent).toEqual(['just a question'])
  })

  test('/speedread paste never sends the text to Claude, even when the reader fails to open', async ($, on) => {
    mock.store(on)
    on('ui.open', () => ({ deny: 'no room' }))
    const sent: string[] = []
    on('prompt.submit', ($, e) => {
      sent.push(e.text)

      return { text: e.text }
    })
    await $.command.run(typed('paste'))
    const result = await $.prompt.submit({ text: 'private notes', origin: { kind: 'composer' }, wait: false })
    expect(result.drop).toMatch(/nothing was sent to Claude/)
    expect(sent).toEqual([])
  })

  test('refuses other file types and missing files with a message', async ($, on) => {
    engineBeneath(on, {})
    expect((await $.command.run(typed('paper.pdf'))).text).toBe('reads .md and .txt files only.')
    expect((await $.command.run(typed('gone.md'))).text).toBe('could not read gone.md (file not found).')
  })
})
