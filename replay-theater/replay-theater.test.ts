import { expect, mock, test } from 'claude-code/testing'

import { filesTouched, isWorthReplaying, stepOf, unified, withOutcome } from './hooks/steps'

// ── steps: pure ──────────────────────────────────────────────────────────────

test('an edit becomes a diff of exactly the text it replaced', () => {
  const step = stepOf(1, 'Edit', { file_path: '/w/a.ts', old_string: 'one\ntwo', new_string: 'one\n2' })
  expect(step.title).toBe('Edit /w/a.ts')
  expect(step.file).toBe('/w/a.ts')
  expect(step.diff).toBe('--- /w/a.ts\n+++ /w/a.ts\n@@ -1,2 +1,2 @@\n-one\n-two\n+one\n+2\n')
})

test('a write is all additions; a command shows its first line', () => {
  expect(unified('/w/n.ts', '', 'x\ny\n')).toContain('@@ -1,0 +1,2 @@\n+x\n+y\n')
  expect(stepOf(2, 'Write', { file_path: '/w/n.ts', content: 'x\ny\n' }).title).toBe('Write /w/n.ts (2 lines)')
  const bash = stepOf(3, 'Bash', { command: 'npm test\nnpm run lint' })
  expect(bash.title).toBe('$ npm test')
  expect(bash.detail).toContain('npm run lint')
})

test('a command keeps what it printed; a read does not; a failure always does', () => {
  const bash = withOutcome(stepOf(1, 'Bash', { command: 'ls' }), 'a\nb\n', false)
  expect(bash.detail).toBe('a\nb')
  const read = withOutcome(stepOf(2, 'Read', { file_path: '/w/a.ts' }), 'file contents', false)
  expect(read.detail).toBeUndefined()
  const failed = withOutcome(stepOf(3, 'Read', { file_path: '/w/a.ts' }), 'ENOENT', true)
  expect(failed.isError).toBe(true)
  expect(failed.detail).toBe('ENOENT')
})

test('only turns that changed or ran something are worth a replay, and failed edits do not count as changes', () => {
  expect(isWorthReplaying([stepOf(1, 'Read', { file_path: '/a' }), stepOf(2, 'Grep', { pattern: 'x' })])).toBe(false)
  expect(isWorthReplaying([stepOf(1, 'Bash', { command: 'ls' })])).toBe(true)
  const edit = stepOf(1, 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
  expect([...filesTouched([edit, edit])]).toEqual([['/a', 2]])
  expect(filesTouched([withOutcome(edit, 'no match', true)]).size).toBe(0)
})

// ── the hooks, over the engine ───────────────────────────────────────────────

const PANE = {
  component: 'Pane',
  requestId: 'replay-theater',
  props: { title: 'Replay', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const done = { reason: 'answer', answer: 'ok', durationMs: 100, isAborted: false } as const

test('a turn that edits a file is recorded, and /replay opens a pane that steps through it', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'replay' } }))

  await $.turn.start({ text: 'rename the helper', turnId: 't1' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/w/a.ts' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u2', file_path: '/w/a.ts', old_string: 'helper', new_string: 'util' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u3', command: 'npm test' })
  await $.turn.complete({ ...done, turnId: 't1' })

  const opened = await $.command.run({ command: 'replay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(opened.text).toContain('3 steps')

  const ui = await $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read \/w\/a.ts/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Step 2 of 3/ })).toBeDefined()
  const code = await ui.find({ type: 'Code' })
  expect(code?.text).toContain('-helper')
  expect(code?.text).toContain('+util')
  await ui.press({ key: 'last' })
  expect(await ui.find({ type: 'Text', text: /Step 3 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test/ })).toBeDefined()
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: /Step 3 of 3/ })).toBeDefined()
  await ui.press({ key: 'first' })
  expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /Step 1 of 3/ })).toBeDefined()
  await ui.unmount()
})

test('a turn that only read files leaves nothing to replay', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'what does a.ts do', turnId: 't2' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/w/a.ts' })
  await $.turn.complete({ ...done, turnId: 't2' })
  const r = await $.command.run({ command: 'replay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toContain('Nothing to replay')
})

test('a denied or failed call is shown as failed, with the reason', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ deny: 'protected file' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.turn.start({ text: 'edit the env file', turnId: 't3' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/w/.env', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'true' })
  await $.turn.complete({ ...done, turnId: 't3' })
  await $.command.run({ command: 'replay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  const ui = await $.ui.mount({ plugin: 'replay-theater', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /failed: Edit \/w\/.env/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /protected file/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent finishing does not close the main task: steps after it are still recorded', async ($, on) => {
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.turn.start({ text: 'split the module', turnId: 't4' })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'u1', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ ...done, turnId: 'sub-turn', agentId: 'sub1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'npm test' })
  await $.turn.complete({ ...done, turnId: 't4' })
  const r = await $.command.run({ command: 'replay', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  expect(r.text).toContain('2 steps')
})
