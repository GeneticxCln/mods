import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { PRESETS, PRESET_NAMES, choose, diffLines, duration, parseSkin, toolSummary } from './hooks/skins'

// ── pure ─────────────────────────────────────────────────────────────────────

test('the presets are whole skins, and each names itself', () => {
  expect(PRESET_NAMES.sort()).toEqual(['mono', 'noah', 'paper', 'tokyo'])
  for (const [name, s] of Object.entries(PRESETS)) {
    expect(s.name).toBe(name)
    for (const v of Object.values(s)) expect(typeof v).toBe('string')
  }
})

test('/skin arguments mean a list, off, a preset, a file or nothing known', () => {
  expect(choose('').kind).toBe('list')
  expect(choose('off').kind).toBe('off')
  expect(choose('default').kind).toBe('off')
  expect(choose(' Tokyo ').kind).toBe('preset')
  expect(choose('skins/mine.json')).toEqual({ kind: 'file', path: 'skins/mine.json' })
  expect(choose('neon')).toEqual({ kind: 'unknown', arg: 'neon' })
})

test('a custom skin keeps what it sets and takes the rest from the preset it extends', () => {
  const r = parseSkin('{"name":"mine","extends":"noah","accent":"#ff0000","userBullet":"»"}')
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.skin).toMatchObject({ name: 'mine', accent: '#ff0000', userBullet: '»', add: PRESETS.noah!.add })
  }
  const plain = parseSkin('{"accent":"red"}')
  expect(plain.ok && plain.skin.dim).toBe(PRESETS.tokyo!.dim)
})

test('a custom skin that is not a short colour or a short bullet is refused, with the reason', () => {
  const bad = (json: string) => {
    const r = parseSkin(json)
    return r.ok ? null : r.error
  }
  expect(bad('not json')).toBe('not valid JSON')
  expect(bad('[]')).toBe('expected a JSON object')
  expect(bad('{"extends":"neon"}')).toContain('not a preset')
  expect(bad('{"accent":"red; rm -rf /"}')).toContain('accent must be a colour')
  expect(bad('{"accent":5}')).toContain('accent must be a colour')
  expect(bad('{"userBullet":"long bullet"}')).toContain('userBullet must be one or two characters')
  expect(bad('{"toolBullet":""}')).toContain('toolBullet')
})

test('an edit is its removed lines then its added lines, cut with a count of the rest', () => {
  expect(diffLines('a\nb', 'c')).toEqual({ lines: [{ sign: '-', text: 'a' }, { sign: '-', text: 'b' }, { sign: '+', text: 'c' }], more: 0 })
  const big = diffLines('', Array.from({ length: 14 }, (_, i) => `l${i}`).join('\n'))
  expect(big.lines.length).toBe(10)
  expect(big.more).toBe(4)
  expect(diffLines('', '').lines).toEqual([])
})

test('a tool call is summarised by what matters about it', () => {
  expect(toolSummary('Bash', { command: 'npm test\nnpm run lint' })).toBe('npm test')
  expect(toolSummary('Edit', { file_path: '/w/a.ts' })).toBe('/w/a.ts')
  expect(toolSummary('Grep', { pattern: 'TODO' })).toBe('TODO')
  expect(duration(4_000)).toBe('4s')
  expect(duration(75_000)).toBe('1m 15s')
})

// ── the hooks, over the engine ───────────────────────────────────────────────

const SESSION = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const run = (args: string) => ({ command: 'skin', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const
const ENGINE = 'engine drew this'

/** The cross-session store, in memory, where the test can look at it. */
const memory = new Map<string, unknown>()

function plumbing(on: On, entries: Record<string, unknown> = {}) {
  memory.clear()
  for (const [k, v] of Object.entries(entries)) memory.set(k, v)
  on('store.get', (_$, e) => ({ value: memory.get(e.key) }))
  on('store.set', (_$, e) => {
    memory.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'skin' } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.render', () => ({ type: 'Text', children: [ENGINE] }))
}

const user = { text: 'fix the bug', origin: { kind: 'composer' }, isExpanded: true } as const
test('with no skin the engine draws every row itself', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})

test('/skin tokyo re-colours your message with the preset\'s colour and bullet', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  expect((await $.command.run(run('tokyo'))).text).toBe('Skin: tokyo.')
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  const body = await ui.find({ type: 'Text', text: 'fix the bug' })
  expect(body?.props.color).toBe(PRESETS.tokyo!.user)
  expect(await ui.find({ type: 'Text', text: /❯/ })).toBeDefined()
  await ui.unmount()
})

test('a message that did not come from you (a notification, a peer) is left to the engine', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: { ...user, origin: { kind: 'scheduled-trigger' } as never } })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})

test('replies get the assistant bullet once, on the first block, and summaries are left alone', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('noah'))
  let ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Done.', isFirstOfReply: true } })
  expect(await ui.find({ type: 'Text', text: /◆/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'AssistantMessage', props: { text: 'More.', isFirstOfReply: false } })
  expect(await ui.find({ type: 'Text', text: /◆/ })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'AssistantMessage', props: { text: 'sum', isFirstOfReply: true, isSummary: true } })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})

const edit = {
  tool_use_id: 'u1',
  tool: 'Edit',
  input: { file_path: '/w/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
} as const

test('an edit shows its removed line in the skin\'s red and its added line in the skin\'s green, with a tick', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolUse', props: edit })
  const del = (await ui.findAll({ type: 'Text', text: /- const a = 1/ }))[0]
  const add = (await ui.findAll({ type: 'Text', text: /\+ const a = 2/ }))[0]
  expect(del?.props.color).toBe(PRESETS.tokyo!.del)
  expect(add?.props.color).toBe(PRESETS.tokyo!.add)
  expect((await ui.findAll({ type: 'Text', text: '✓' }))[0]?.props.color).toBe(PRESETS.tokyo!.ok)
  await ui.unmount()
})

test('a running call shows an ellipsis, a failed one a cross in the error colour', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  let ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolUse', props: { ...edit, tool: 'Bash', input: { command: 'npm test' }, isRunning: true } })
  expect(await ui.find({ type: 'Text', text: '…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test/ })).toBeDefined()
  await ui.unmount()
  const failed = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolUse', props: { ...edit, isErrored: true } })
  expect((await failed.findAll({ type: 'Text', text: '✗' }))[0]?.props.color).toBe(PRESETS.tokyo!.error)
  await failed.unmount()
})

test('tools the skin does not know are left to the engine', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolUse', props: { ...edit, tool: 'mcp__x__y' } })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})

test('a successful edit\'s result is one quiet line, and a failed edit\'s result is the engine\'s', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  const failed = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'u1', tool: 'Edit', output: 'boom', isErrored: true } })
  expect(await failed.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await failed.unmount()
  const fine = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: 'u1', tool: 'Edit', output: {}, isErrored: false } })
  expect(await fine.find({ type: 'Text', text: /applied/ })).toBeDefined()
  await fine.unmount()
})

test('the turn footer is drawn in the skin\'s dim colour', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('paper'))
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'TurnDuration', props: { word: 'Baked', durationMs: 75_000 } })
  const line = (await ui.findAll({ type: 'Text', text: /Baked for 1m 15s/ }))[0]
  expect(line?.props.color).toBe(PRESETS.paper!.dim)
  await ui.unmount()
})

test('/skin off gives the transcript back to the engine', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('tokyo'))
  expect((await $.command.run(run('off'))).text).toContain('Skin off')
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})

test('your own design-system file is read from the workspace, checked, and applied', async ($, on) => {
  plumbing(on)
  on('fs.read', (_$, e) => ({ value: e.path === '/w/skin.json' ? '{"name":"mine","accent":"#123456","user":"#abcdef","userBullet":"»"}' : 'not json' }))
  await $.session.start(SESSION)
  expect((await $.command.run(run('skin.json'))).text).toBe('Skin: mine.')
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect((await ui.find({ type: 'Text', text: 'fix the bug' }))?.props.color).toBe('#abcdef')
  expect(await ui.find({ type: 'Text', text: /»/ })).toBeDefined()
  await ui.unmount()
  expect((await $.command.run(run('other.json'))).text).toContain('other.json: not valid JSON')
})

test('a file that cannot be read, a name nobody knows, and a bare /skin each say so', async ($, on) => {
  plumbing(on)
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  await $.session.start(SESSION)
  expect((await $.command.run(run('missing.json'))).text).toContain('Could not read /w/missing.json')
  expect((await $.command.run(run('neon'))).text).toContain('No skin called "neon"')
  expect((await $.command.run(run(''))).text).toContain('Skin: off. Presets: ')
})

test('the choice is remembered across sessions, and "off" is remembered too', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(run('noah'))
  expect((memory.get('skin') as { name: string }).name).toBe('noah')
  await $.command.run(run('off'))
  expect(memory.get('skin')).toBe('off')
})

test('a skin saved last session is back when the next one starts', async ($, on) => {
  plumbing(on, { skin: PRESETS.paper })
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect((await ui.find({ type: 'Text', text: 'fix the bug' }))?.props.color).toBe(PRESETS.paper!.user)
  await ui.unmount()
})

test('with the default-skin option set it applies until the person chooses', { options: { defaultSkin: 'mono' } }, async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect((await ui.find({ type: 'Text', text: 'fix the bug' }))?.props.color).toBe(PRESETS.mono!.user)
  await ui.unmount()
})

test('a saved "off" beats the default-skin option', { options: { defaultSkin: 'mono' } }, async ($, on) => {
  plumbing(on, { skin: 'off' })
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'transcript-skins', surface: 'terminal', component: 'UserMessage', props: user })
  expect(await ui.find({ type: 'Text', text: ENGINE })).toBeDefined()
  await ui.unmount()
})
