import { expect, mock, test } from 'claude-code/testing'

import { costs, dollars, phase, pingEveryMs } from './hooks/tax'

const MIN = 60_000

// ── the arithmetic: pure ─────────────────────────────────────────────────────

test('a cold reload is a write at 2x for the 1-hour cache and 1.25x for the 5-minute one; a warm read is 0.1x', () => {
  const hour = costs(200_000, { ttlMinutes: 60, pricePerMTok: 3 })
  expect(Math.round(hour.cold * 1e6)).toBe(1200000)
  expect(Math.round(hour.warm * 1e6)).toBe(60000)
  expect(Math.round(hour.tax * 1e6)).toBe(1140000)
  const five = costs(200_000, { ttlMinutes: 5, pricePerMTok: 3 })
  expect(Math.round(five.cold * 1e6)).toBe(750000)
})

test('the cache is warm, then cooling for the last five minutes, then cold; small or unknown contexts are never judged', () => {
  expect(phase(10 * MIN, 100_000, 60)).toBe('warm')
  expect(phase(55 * MIN, 100_000, 60)).toBe('cooling')
  expect(phase(60 * MIN, 100_000, 60)).toBe('cold')
  expect(phase(2 * MIN, 100_000, 5)).toBe('warm')
  expect(phase(4 * MIN, 100_000, 5)).toBe('cooling')
  expect(phase(90 * MIN, 1_000, 60)).toBe('unknown')
  expect(phase(null, 100_000, 60)).toBe('unknown')
  expect(phase(90 * MIN, null, 60)).toBe('unknown')
})

test('amounts and ping spacing read sensibly', () => {
  expect(dollars(0.004)).toBe('<$0.01')
  expect(dollars(1.2)).toBe('$1.20')
  expect(pingEveryMs(60)).toBe(55 * MIN)
  expect(pingEveryMs(5)).toBe(4 * MIN)
  expect(pingEveryMs(1)).toBe(MIN)
})

// ── the hooks, over the engine and a clock the test moves ────────────────────

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const SESSION = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const usage = (tokens: number | undefined) => ({
  startedAt: 0,
  context: { tokens, window: 1_000_000, percent: 0 },
  rateLimits: [],
})
const done = { reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' } as const
const RUN = { command: 'keepwarm', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const


test('after an hour idle the band says the cache is cold and what reloading it will cost', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.session.start(SESSION)
  await $.turn.complete(done)

  await clock.advance(30 * MIN)
  let ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeUndefined()
  await ui.unmount()

  await clock.advance(31 * MIN)
  ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  const text = (await ui.find({ type: 'Text', text: /Cache is cold/ }))?.text ?? ''
  expect(text).toContain('idle 61 min')
  expect(text).toContain('200k tokens')
  expect(text).toContain('$1.20 instead of $0.06')
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeUndefined()
  await ui.unmount()
})

test('a small context, or one that is not known, never raises the band', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(2_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await clock.advance(120 * MIN)
  const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeUndefined()
  await ui.unmount()
})

test('the status line warns in the last five minutes and is cleared by the next prompt', async ($, on) => {
  const clock = mock.clock(on)
  const status: (string | undefined)[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await clock.advance(57 * MIN)
  expect(status.at(-1)).toMatch(/cache cools in \d+ min/)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
  expect(status.at(-1)).toBeUndefined()
})

test('/keepwarm pings the cache before it lapses, and the band never appears while it holds', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  on('model.fork', () => {
    forks++
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 } } }
  })
  await $.session.start(SESSION)
  await $.turn.complete(done)
  const on1 = await $.command.run({ ...RUN, args: 'on' })
  expect(on1.text).toContain('Keep-warm is on')
  expect(on1.text).toContain('every 55 minutes')
  expect(on1.text).toContain('$0.06')

  await clock.advance(150 * MIN)
  expect(forks).toBeGreaterThanOrEqual(2)
  expect(forks).toBeLessThanOrEqual(3)
  const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeUndefined()
  await ui.unmount()
})

test('keep-warm stops after the most pings you allow, says so, and lets the cache go cold', { options: { maxKeepWarmPings: 2 } }, async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('model.fork', () => {
    forks++
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0 } } }
  })
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await $.command.run({ ...RUN, args: 'on' })
  await clock.advance(8 * 60 * MIN)
  expect(forks).toBe(2)
  expect(toasts.some(t => /Keep-warm stopped after 2 pings/.test(t))).toBe(true)
  const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeDefined()
  await ui.unmount()
})

test('a ping that fails turns keep-warm off instead of retrying forever', async ($, on) => {
  const clock = mock.clock(on)
  let forks = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.fork', () => {
    forks++
    return { value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await $.command.run({ ...RUN, args: 'on' })
  await clock.advance(5 * 60 * MIN)
  expect(forks).toBe(1)
  // Failure turned it off, so a bare /keepwarm now turns it back on.
  const toggled = await $.command.run({ ...RUN, args: '' })
  expect(toggled.text).toContain('Keep-warm is on')
})

test('/keepwarm off, and a bare /keepwarm, toggle', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  expect((await $.command.run({ ...RUN, args: '' })).text).toContain('Keep-warm is on')
  expect((await $.command.run({ ...RUN, args: '' })).text).toContain('Keep-warm is off')
  expect((await $.command.run({ ...RUN, args: 'on' })).text).toContain('Keep-warm is on')
  expect((await $.command.run({ ...RUN, args: 'off' })).text).toContain('Keep-warm is off')
})

test('a subagent finishing is not a use of the main conversation\'s cache', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await clock.advance(40 * MIN)
  await $.turn.complete({ ...done, turnId: 'sub', agentId: 'sub1' })
  await clock.advance(21 * MIN)
  const ui = await $.ui.mount({ plugin: 'cache-tax', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Cache is cold/ })).toBeDefined()
  await ui.unmount()
})

// ── without the band (a phone draws none): a toast and /keepwarm status ──────

import { statusText } from './hooks/tax'

test('the status sentence covers warm, cooling, cold, tiny and nothing yet', () => {
  const base = { ttl: 60, price: 3, isKeepWarm: false, pings: 0, maxPings: 6 }
  expect(statusText({ ...base, idleMs: null, tokens: null })).toContain('No conversation yet')
  expect(statusText({ ...base, idleMs: 5 * MIN, tokens: 2_000 })).toContain('only 2000 tokens')
  expect(statusText({ ...base, idleMs: 10 * MIN, tokens: 200_000 })).toBe(
    'Cache is warm: idle 10 of 60 min. Reloading ~200k tokens costs $1.20 instead of $0.06. Keep-warm is off. /keepwarm on turns it on.',
  )
  expect(statusText({ ...base, idleMs: 57 * MIN, tokens: 200_000 })).toContain('Cache is cooling: idle 57 of 60 min.')
  expect(statusText({ ...base, idleMs: 90 * MIN, tokens: 200_000, isKeepWarm: true, pings: 2 })).toContain('Cache is cold (idle 90 min).')
  expect(statusText({ ...base, idleMs: 90 * MIN, tokens: 200_000, isKeepWarm: true, pings: 2 })).toContain('Keep-warm is on (2 of 6 pings used).')
})

test('going cold is a toast, said once, with the cost and how to prevent it; the next turn re-arms it', async ($, on) => {
  const clock = mock.clock(on)
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start(SESSION)
  await $.turn.complete(done)
  await clock.advance(59 * MIN)
  expect(toasts).toEqual([])
  await clock.advance(10 * MIN)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('Cache went cold (idle 60 min)')
  expect(toasts[0]).toContain('$1.20 instead of $0.06')
  expect(toasts[0]).toContain('/keepwarm on')
  await clock.advance(60 * MIN)
  expect(toasts.length).toBe(1)
  await $.turn.complete({ ...done, turnId: 't2' })
  await clock.advance(61 * MIN)
  expect(toasts.length).toBe(2)
})

test('/keepwarm status tells you where the cache stands without changing anything', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'keepwarm' } }))
  on('session.usage', () => ({ value: usage(200_000) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  await $.session.start(SESSION)
  expect((await $.command.run({ ...RUN, args: 'status' })).text).toContain('No conversation yet')
  await $.turn.complete(done)
  await clock.advance(10 * MIN)
  const text = (await $.command.run({ ...RUN, args: 'status' })).text ?? ''
  expect(text).toContain('Cache is warm: idle 10 of 60 min.')
  expect(text).toContain('Keep-warm is off')
  expect((await $.command.run({ ...RUN, args: 'status' })).text).toContain('Keep-warm is off')
  expect((await $.command.run({ ...RUN, args: 'on' })).text).toContain('Keep-warm is on')
  expect((await $.command.run({ ...RUN, args: 'status' })).text).toContain('Keep-warm is on (0 of 6 pings used).')
})
