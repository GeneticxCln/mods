import { expect, test } from 'claude-code/testing'

import { addRule, detect, toRule } from './hooks/feedback'

// ── detection and rule text: pure ────────────────────────────────────────────

test('a correction becomes a one-sentence rule without the interjection', () => {
  expect(detect("no, don't use semicolons in this repo")?.text).toBe("Don't use semicolons in this repo.")
  expect(detect('Nope. Never add comments to tests, please')?.text).toBe('Never add comments to tests.')
  expect(detect('From now on run the linter before committing')?.text).toBe('From now on run the linter before committing.')
})

test('only the sentence that holds the correction is kept', () => {
  expect(detect("Thanks, that works. But don't rename the exports again.")?.text).toBe("Don't rename the exports again.")
})

test("reassurance and self-description are not rules", () => {
  expect(detect("don't worry about the failing test")).toBeNull()
  expect(detect("I don't know which file it is")).toBeNull()
})

test('ordinary prompts, questions, commands and pastes are not corrections', () => {
  expect(detect('add a retry to the fetch helper')).toBeNull()
  expect(detect('why did you pick that? what does it do')).toBeNull()
  expect(detect('/clear')).toBeNull()
  expect(detect('')).toBeNull()
  expect(detect("don't " + 'x'.repeat(500))).toBeNull()
  expect(detect('no')).toBeNull()
})

test('a long rule is cut at a word and marked', () => {
  const rule = toRule("don't " + 'use the word really '.repeat(20))
  expect(rule.length).toBeLessThanOrEqual(181)
  expect(rule.endsWith('…')).toBe(true)
})

test('addRule starts a file, extends a section, and refuses a duplicate', () => {
  expect(addRule('', 'Never X.')).toBe('# CLAUDE.md\n\n## Rules from feedback\n\n- Never X.\n')
  const two = addRule(addRule('# Notes\n\nText\n', 'Never X.')!, 'Always Y.')!
  expect(two).toBe('# Notes\n\nText\n\n## Rules from feedback\n\n- Never X.\n- Always Y.\n')
  expect(addRule(two, 'never x')).toBeNull()
})

test('addRule adds to the section even when another heading follows it', () => {
  const file = '# A\n\n## Rules from feedback\n\n- One.\n\n## Other\n\nbody\n'
  expect(addRule(file, 'Two.')).toBe('# A\n\n## Rules from feedback\n\n- One.\n- Two.\n\n## Other\n\nbody\n')
})

// ── the band, through the engine ─────────────────────────────────────────────

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const TYPED = { kind: 'composer' } as const

test('a correction raises a banner with Save and Dismiss; an ordinary prompt raises nothing', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // What the engine would draw when the mod passes: the band's own, here a bare line.
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.prompt.submit({ text: 'add a retry', wait: false, origin: TYPED })
  let ui = await $.ui.mount({ plugin: 'reflect', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  await ui.unmount()

  await $.prompt.submit({ text: "no, don't mock the database", wait: false, origin: TYPED })
  ui = await $.ui.mount({ plugin: 'reflect', surface: 'terminal', ...BAND })
  expect(await ui.find({ key: 'save' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mock the database/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
})

test('Save writes the rule into CLAUDE.md in the session directory', async ($, on) => {
  const written: Record<string, string> = {}
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  await $.prompt.submit({ text: 'never touch the migrations folder', wait: false, origin: TYPED })
  const ui = await $.ui.mount({ plugin: 'reflect', surface: 'terminal', ...BAND })
  await ui.press({ key: 'save' })
  expect(written['/work/CLAUDE.md']).toContain('- Never touch the migrations folder.')
  expect(await ui.find({ type: 'Text', text: /Saved to CLAUDE.md/ })).toBeDefined()
  await ui.unmount()
})

test('while a survey holds the band the offer waits and the engine draws its own', async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.prompt.submit({ text: "don't reformat the lockfile", wait: false, origin: TYPED })
  const ui = await $.ui.mount({ plugin: 'reflect', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})

// ── without the band (a phone draws none): toast and /reflect ────────────────

const RUN = (args: string) => ({ command: 'reflect', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

function phone(on: import('claude-code').On, files: Record<string, string> = {}) {
  const toasts: string[] = []
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', () => ({ value: { command: 'reflect' } }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  return { files, toasts }
}

test('a correction raises a toast that says how to save it', async ($, on) => {
  const { toasts } = phone(on)
  await $.prompt.submit({ text: "no, don't mock the database", wait: false, origin: TYPED })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain("Don't mock the database.")
  expect(toasts[0]).toContain('/reflect save')
  await $.prompt.submit({ text: 'add a retry', wait: false, origin: TYPED })
  expect(toasts.length).toBe(1)
})

test('/reflect shows the waiting rule, /reflect save writes it, and it is then gone', async ($, on) => {
  const { files } = phone(on, { '/work/CLAUDE.md': '# Notes\n' })
  expect((await $.command.run(RUN(''))).text).toContain('No correction waiting')
  await $.prompt.submit({ text: 'never touch the migrations folder', wait: false, origin: TYPED })
  const shown = (await $.command.run(RUN(''))).text ?? ''
  expect(shown).toContain('Never touch the migrations folder.')
  expect(shown).toContain('/reflect save')
  const saved = (await $.command.run(RUN('save'))).text ?? ''
  expect(saved).toContain('Saved to CLAUDE.md: Never touch the migrations folder.')
  expect(files['/work/CLAUDE.md']).toBe('# Notes\n\n## Rules from feedback\n\n- Never touch the migrations folder.\n')
  expect((await $.command.run(RUN('save'))).text).toContain('Nothing to save')
})

test('/reflect dismiss drops the offer and writes nothing', async ($, on) => {
  const { files } = phone(on)
  await $.prompt.submit({ text: 'always run the linter first', wait: false, origin: TYPED })
  expect((await $.command.run(RUN('dismiss'))).text).toContain('Dropped')
  expect((await $.command.run(RUN('save'))).text).toContain('Nothing to save')
  expect(Object.keys(files)).toEqual([])
  expect((await $.command.run(RUN('dismiss'))).text).toContain('Nothing was waiting')
})

test('typing a slash command does not wipe the rule it is about to save', async ($, on) => {
  const { files } = phone(on)
  await $.prompt.submit({ text: 'never use var', wait: false, origin: TYPED })
  await $.prompt.submit({ text: '/reflect save', wait: false, origin: TYPED })
  expect((await $.command.run(RUN('save'))).text).toContain('Saved to CLAUDE.md')
  expect(files['/work/CLAUDE.md']).toContain('- Never use var.')
})
