import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bar, duration, money, projected, sprite, todosOf } from './hooks/progress'

// ── pure ─────────────────────────────────────────────────────────────────────

test('the bar fills by todos done, and sweeps when there are no todos', () => {
  expect(bar(8, { done: 2, total: 4, current: null }, 0)).toBe('▰▰▰▰▱▱▱▱')
  expect(bar(8, { done: 4, total: 4, current: null }, 0)).toBe('▰▰▰▰▰▰▰▰')
  expect(bar(4, null, 0)).toBe('▰▱▱▱')
  expect(bar(4, null, 2)).toBe('▱▱▰▱')
  expect(bar(4, null, 4)).toBe('▱▱▰▱') // on its way back
  expect(bar(4, null, 5)).toBe('▱▰▱▱')
  expect(bar(4, null, 6)).toBe('▰▱▱▱')
})

test('the projected cost needs a fifth of the work done, and scales what was spent', () => {
  expect(projected(0.5, { done: 2, total: 4, current: null })).toBe(1)
  expect(projected(0.5, { done: 1, total: 10, current: null })).toBeNull()
  expect(projected(0.5, null)).toBeNull()
  expect(projected(0, { done: 2, total: 4, current: null })).toBeNull()
  expect(projected(null, { done: 2, total: 4, current: null })).toBeNull()
})

test('a TodoWrite list is read for done, total and what is in progress', () => {
  const t = todosOf({
    todos: [
      { content: 'a', status: 'completed', activeForm: 'Doing a' },
      { content: 'b', status: 'in_progress', activeForm: 'Doing b' },
      { content: 'c', status: 'pending', activeForm: 'Doing c' },
    ],
  })
  expect(t).toEqual({ done: 1, total: 3, current: 'Doing b' })
  expect(todosOf({ todos: [] })).toBeNull()
  expect(todosOf({ command: 'ls' })).toBeNull()
  expect(todosOf(null)).toBeNull()
})

test('mascots animate while running, rest while waiting, and show how they ended', () => {
  expect(sprite('robot', 0, 'running')).not.toBe(sprite('robot', 1, 'running'))
  expect(sprite('robot', 1, 'waiting')).toBe(sprite('robot', 0, 'waiting'))
  expect(sprite('cat', 0, 'completed')).toBe('[^_^]')
  expect(sprite('cat', 0, 'failed')).toBe('[x_x]')
  expect(sprite('none', 0, 'running')).toBe('')
})

test('time and money read sensibly', () => {
  expect(duration(4_000)).toBe('4s')
  expect(duration(72_000)).toBe('1m 12s')
  expect(duration(60_000)).toBe('1m 00s')
  expect(money(0.004)).toBe('<$0.01')
  expect(money(1.5)).toBe('$1.50')
})

// ── the hooks, over the engine and a clock the test moves ────────────────────

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const SESSION = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'progress', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const done = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as const
const todo = (...s: Array<'completed' | 'in_progress' | 'pending'>) => ({
  todos: s.map((status, i) => ({ content: `step ${i}`, status, activeForm: `Doing step ${i}` })),
})

/** The session figures the test moves between ticks. */
const meter = { usd: 1, tokens: 10_000, reads: 0 }
const usage = () => (meter.reads++, { startedAt: 0, context: { tokens: meter.tokens, window: 1_000_000, percent: 1 }, rateLimits: [], cost: { usd: meter.usd } })
const agentsNow: Array<{ id: string; description: string; type: string; status: 'running' | 'waiting' | 'idle' | 'completed' }> = []

function plumbing(on: On) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.usage', () => ({ value: usage() }))
  on('agent.list', () => ({ value: agentsNow }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  return clock
}

test('while a turn runs the band shows todo progress, time, context and cost with its projection', async ($, on) => {
  meter.usd = 1
  meter.tokens = 10_000
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'build it', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u1', ...todo('completed', 'completed', 'in_progress', 'pending') })
  meter.usd = 1.5
  meter.tokens = 48_000
  await clock.advance(4_000)

  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  const line = (await ui.find({ type: 'Text', text: /2\/4/ }))?.text ?? ''
  expect(line).toContain('▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱')
  expect(line).toContain('4s')
  expect(line).toContain('ctx 48.0k')
  expect(line).toContain('$0.50 (~$1.00 projected)')
  expect(await ui.find({ type: 'Text', text: /Doing step 2/ })).toBeDefined()
  await ui.unmount()
})

test('each running subagent gets a mascot that animates, and one that finished shows it', async ($, on) => {
  meter.usd = 1
  agentsNow.length = 0
  agentsNow.push({ id: 'a1', description: 'map the auth flow', type: 'Explore', status: 'running' })
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1_000)
  let ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  const first = (await ui.find({ type: 'Text', text: /map the auth flow/ }))?.text ?? ''
  expect(first).toContain('[•‿•]')
  expect(first).toContain('running')
  await ui.unmount()

  await clock.advance(1_000)
  ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /map the auth flow/ }))?.text ?? '').toContain('[•_•]')
  await ui.unmount()

  agentsNow[0]!.status = 'completed'
  await clock.advance(1_000)
  ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /map the auth flow/ }))?.text ?? '').toContain('[^_^]')
  await ui.unmount()
})

test('the mascot theme is the person\'s choice', { options: { mascot: 'cat' } }, async ($, on) => {
  agentsNow.length = 0
  agentsNow.push({ id: 'a1', description: 'review', type: 'general-purpose', status: 'running' })
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: /review/ }))?.text ?? '').toContain('=^o^=')
  await ui.unmount()
})

test('a subagent\'s own todo list does not replace the main one', async ($, on) => {
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u1', ...todo('completed', 'pending') })
  // A subagent's call carries its loop's id; `$.tool.call`'s type does not offer the field, the engine honours it.
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u2', agentId: 'sub1', ...todo('pending', 'pending', 'pending') } as never)
  await clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /1\/2/ })).toBeDefined()
  await ui.unmount()
})

test('when the turn ends the band becomes one line saying how long and how much, until the next turn', async ($, on) => {
  meter.usd = 1
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  meter.usd = 1.25
  await clock.advance(72_000)
  await $.turn.complete(done)

  let ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /Done in 1m 12s · \$0\.25/ })).toBeDefined()
  await ui.unmount()

  await $.turn.start({ text: 'again', turnId: 't2' })
  ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeUndefined()
  await ui.unmount()
})

test('/progress hide takes the band away and /progress show brings it back', async ($, on) => {
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1_000)
  expect((await $.command.run({ ...RUN, args: 'hide' })).text).toContain('hidden')
  let ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
  expect((await $.command.run({ ...RUN, args: 'show' })).text).toContain('shown')
  ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeUndefined()
  await ui.unmount()
})

test('with nothing running and nothing to report the engine keeps its own band', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: false } })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  await ui.unmount()
})

test('with no mascot a subagent is a plain dash', { options: { mascot: 'none' } }, async ($, on) => {
  agentsNow.length = 0
  agentsNow.push({ id: 'a1', description: 'review', type: 'general-purpose', status: 'running' })
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  const row = (await ui.find({ type: 'Text', text: /review/ }))?.text ?? ''
  expect(row.startsWith('- general-purpose: review')).toBe(true)
  await ui.unmount()
})

test('idle teammates are not listed as progress', async ($, on) => {
  agentsNow.length = 0
  agentsNow.push({ id: 'a1', description: 'waiting for work', type: 'teammate', status: 'idle' })
  agentsNow.push({ id: 'a2', description: 'writing tests', type: 'general-purpose', status: 'running' })
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /waiting for work/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /writing tests/ })).toBeDefined()
  await ui.unmount()
})

test('nothing is polled while no turn is running', async ($, on) => {
  agentsNow.length = 0
  const clock = plumbing(on)
  meter.reads = 0
  await $.session.start(SESSION)
  await clock.advance(30_000)
  expect(meter.reads).toBe(0)
})

test('a subagent finishing does not end the main turn\'s band', async ($, on) => {
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ ...done, turnId: 'sub', agentId: 'sub1' })
  await clock.advance(1_000)
  const ui = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /▰/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeUndefined()
  await ui.unmount()
})

// ── without the band (a phone draws none): /progress in words, and a toast ───

import { statusText } from './hooks/progress'

test('the status text carries the same facts as the band, in lines', () => {
  const todos = { done: 2, total: 4, current: 'Doing step 2' }
  expect(statusText({ began: null, now: 0, todos: null, turnCost: null, tokens: null, agents: [], summary: null })).toBe('Idle: nothing is running.')
  expect(statusText({ began: null, now: 0, todos: null, turnCost: null, tokens: null, agents: [], summary: 'Done in 3s' })).toBe('Done in 3s')
  expect(
    statusText({ began: 1000, now: 73_000, todos, turnCost: 0.5, tokens: 48_000, agents: [{ label: 'Explore: map auth', status: 'running' }], summary: null }),
  ).toBe('Working 1m 12s · 2/4 todos · ctx 48.0k · $0.50 (~$1.00 projected)\nNow: Doing step 2\n- Explore: map auth (running)')
  expect(statusText({ began: 0, now: 5000, todos: null, turnCost: null, tokens: null, agents: [], summary: null })).toBe('Working 5s · no todo list')
})

test('/progress with no argument reports a running turn; hide and show still work', async ($, on) => {
  meter.usd = 1
  meter.tokens = 10_000
  agentsNow.length = 0
  const clock = plumbing(on)
  await $.session.start(SESSION)
  expect((await $.command.run(RUN)).text).toBe('Idle: nothing is running.')
  await $.turn.start({ text: 'build', turnId: 't1' })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'u1', ...todo('completed', 'in_progress') })
  meter.usd = 1.4
  await clock.advance(5_000)
  const text = (await $.command.run(RUN)).text ?? ''
  expect(text).toContain('Working 5s · 1/2 todos')
  expect(text).toContain('$0.40')
  expect(text).toContain('Now: Doing step 1')
  expect((await $.command.run({ ...RUN, args: 'hide' })).text).toContain('hidden')
  expect((await $.command.run({ ...RUN, args: 'show' })).text).toContain('shown')
})

test('after a turn, /progress says how it went; a long turn toasts, a short one does not', async ($, on) => {
  meter.usd = 1
  agentsNow.length = 0
  const clock = plumbing(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'quick', turnId: 't1' })
  await clock.advance(5_000)
  await $.turn.complete(done)
  expect(toasts).toEqual([])
  await $.turn.start({ text: 'long', turnId: 't2' })
  meter.usd = 1.25
  await clock.advance(72_000)
  await $.turn.complete({ ...done, turnId: 't2' })
  expect(toasts).toEqual(['Done in 1m 12s · $0.25'])
  expect((await $.command.run(RUN)).text).toBe('Done in 1m 12s · $0.25')
})
