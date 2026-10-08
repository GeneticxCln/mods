import { expect, mock, test } from 'claude-code/testing'

import { fromModel, merge, scan } from './hooks/alerts'

// ── the scanner: pure ────────────────────────────────────────────────────────

const titles = (text: string, source: 'answer' | 'output' = 'answer') => scan(text, source).map(a => a.title)

test('each kind of thing worth hearing about is found, with the sentence that holds it', () => {
  expect(titles('I renamed the export. This is a breaking change for anyone importing it.')).toEqual(['Breaking change'])
  expect(titles('The migration drops the column, so there is data loss if you roll back.')).toEqual(['Data loss'])
  expect(titles('The API key is hard-coded in config.ts.')).toEqual(['Possible exposed secret'])
  expect(titles('I found sk-abcdefghijklmnopqrstuvwx in the repo')).toEqual(['Possible exposed secret'])
  expect(titles('This version has CVE-2024-12345 so I pinned the last good one.')).toEqual(['Security issue'])
  expect(titles('Note: left() is deprecated and will be removed in v3.')).toEqual(['Deprecation'])
  expect(titles('That tier costs $20 per month per seat.')).toEqual(['Cost or quota'])
  expect(titles('You will need to run the migration before deploying.')).toEqual(['Left for you'])
  expect(titles("I couldn't run the integration tests here.")).toEqual(['Not verified'])
  const [a] = scan('Fine. This is a breaking change for importers. Done.', 'answer')
  expect(a?.quote).toBe('This is a breaking change for importers.')
})

test('ordinary text raises nothing, and the same sentence is reported once', () => {
  expect(scan('I added a retry to the fetch helper and updated its tests. All 41 pass.', 'answer')).toEqual([])
  expect(scan('breaking change here. breaking change here.', 'answer').length).toBe(1)
})

test('tool output is only read for the serious kinds: a deprecation warning yes, a price or an apology no', () => {
  expect(titles('npm warn deprecated left-pad@1.0.0: use String.prototype.padStart', 'output')).toEqual(['Deprecation'])
  expect(titles('quota exceeded, you will need to run again', 'output')).toEqual([])
})

test('merge puts high severity first, drops repeats and keeps at most six', () => {
  const med = scan('That costs $5 per month.', 'answer')
  const high = scan('This is a breaking change.', 'answer')
  expect(merge(med, high).map(a => a.severity)).toEqual(['high', 'medium'])
  expect(merge(high, high).length).toBe(1)
  const many = Array.from({ length: 10 }, (_, i) => ({ ...high[0]!, id: `x${i}` }))
  expect(merge([], many).length).toBe(6)
})

test('a model reply is read only if it is the JSON asked for', () => {
  const ok = fromModel('Here: [{"severity":"high","title":"Data loss","quote":"This drops the table."}]')
  expect(ok.length).toBe(1)
  expect(ok[0]).toMatchObject({ severity: 'high', title: 'Data loss', source: 'model' })
  expect(fromModel('nothing to report')).toEqual([])
  expect(fromModel('[not json]')).toEqual([])
  expect(fromModel('[{"title":5}]')).toEqual([])
})

// ── the hooks, over the engine ───────────────────────────────────────────────

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const done = (answer: string, turnId = 't1') => ({ reason: 'answer', answer, durationMs: 100, isAborted: false, turnId }) as const


test('a turn that ends on a warning puts a banner above the prompt, and Dismiss clears it', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.turn.start({ text: 'upgrade the lib', turnId: 't1' })
  await $.turn.complete(done('Upgraded. This is a breaking change: init() now takes an object.'))

  const ui = await $.ui.mount({ plugin: 'you-should-know', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Breaking change/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /init\(\) now takes an object/ })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ type: 'Text', text: /Breaking change/ })).toBeUndefined()
  await ui.unmount()
})

test('a quiet turn leaves the band to the engine, and a new turn clears the last turn\'s alerts', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.turn.complete(done('There is data loss risk here.'))
  await $.turn.start({ text: 'b', turnId: 't2' })
  await $.turn.complete(done('Renamed a variable.', 't2'))
  const ui = await $.ui.mount({ plugin: 'you-should-know', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /You should know/ })).toBeUndefined()
  await ui.unmount()
})

test('a warning in a command\'s output reaches the banner before the answer does', async ($, on) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {}, text: 'npm warn deprecated request@2.88.2: request has been deprecated' }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  await $.turn.start({ text: 'install', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'npm install' })
  const ui = await $.ui.mount({ plugin: 'you-should-know', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Deprecation/ })).toBeDefined()
  await ui.unmount()
})

const flush = async () => {
  for (let i = 0; i < 1000; i++) await Promise.resolve()
}

const reply = { isAnswered: true, text: '[]', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as const

test('the small model is never asked while the option is off, however long the answer', async ($, on) => {
  const asked: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    return { value: reply }
  })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(done('long '.repeat(400)))
  await flush()
  expect(asked.length).toBe(0)
})

test('with the option on, a short answer is not worth a model call and a subagent\'s turn is not scanned', { options: { scanWithModel: true } }, async ($, on) => {
  const asked: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    return { value: reply }
  })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(done('short answer'))
  await $.turn.complete({ ...done('filler '.repeat(300), 'sub'), agentId: 'sub1' })
  await flush()
  expect(asked.length).toBe(0)
})

test('with the option on, a long answer is read by the model and its finding shows', { options: { scanWithModel: true } }, async ($, on) => {
  const asked: string[] = []
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.render', () => ({ type: 'Text', children: ['engine band'] }))
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    return {
      value: {
        isAnswered: true,
        text: '[{"severity":"high","title":"Silent failure","quote":"The retry swallows errors."}]',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete(done('filler '.repeat(300)))
  // The scan runs after the turn, unawaited; give it room to finish.
  await flush()
  expect(asked.length).toBe(1)
  const ui = await $.ui.mount({ plugin: 'you-should-know', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: /Silent failure/ })).toBeDefined()
  await ui.unmount()
})
