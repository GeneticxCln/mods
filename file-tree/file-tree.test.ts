import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ACTIVE_MS, dirMark, fileMark, flatten, folderArg, listing, parseStatus, relative, tidy } from './hooks/tree'

// ── pure ─────────────────────────────────────────────────────────────────────

const e = (name: string, kind: 'file' | 'dir' | 'other') => ({ name, kind })

test('noise directories are dropped and directories sort before files', () => {
  const got = tidy([e('zeta.ts', 'file'), e('node_modules', 'dir'), e('src', 'dir'), e('.git', 'dir'), e('alpha.ts', 'file'), e('link', 'other'), e('app', 'dir')])
  expect(got.map(x => x.name)).toEqual(['app', 'src', 'alpha.ts', 'zeta.ts'])
})

test('only open directories are walked, and rows carry their depth', () => {
  const kids = {
    '': [{ name: 'src', kind: 'dir' as const }, { name: 'README.md', kind: 'file' as const }],
    src: [{ name: 'ui', kind: 'dir' as const }, { name: 'main.ts', kind: 'file' as const }],
    'src/ui': [{ name: 'App.tsx', kind: 'file' as const }],
  }
  expect(flatten(kids, []).map(r => r.path)).toEqual(['src', 'README.md'])
  expect(flatten(kids, ['src']).map(r => `${r.depth}:${r.path}`)).toEqual(['0:src', '1:src/ui', '1:src/main.ts', '0:README.md'])
  expect(flatten(kids, ['src', 'src/ui']).map(r => r.path)).toContain('src/ui/App.tsx')
  expect(flatten(kids, ['src', 'src/ui'], 3).length).toBe(3)
})

test('git status becomes one letter per path, renames take the new name', () => {
  const s = parseStatus(' M src/a.ts\n?? new.txt\nA  added.ts\n D gone.ts\nR  old.ts -> renamed.ts\n')
  expect(s).toEqual({ 'src/a.ts': 'M', 'new.txt': '?', 'added.ts': 'A', 'gone.ts': 'D', 'renamed.ts': 'M' })
})

test('a file is active while Claude is working on it, then dirty, then committed; a folder carries what is under it', () => {
  const none = {}
  expect(fileMark('a.ts', none, [], { 'a.ts': 1000 }, 1000 + ACTIVE_MS - 1)).toBe('active')
  expect(fileMark('a.ts', none, [], { 'a.ts': 1000 }, 1000 + ACTIVE_MS)).toBeNull()
  expect(fileMark('a.ts', { 'a.ts': 'M' }, ['a.ts'], none, 0)).toBe('dirty')
  expect(fileMark('a.ts', none, ['a.ts'], none, 0)).toBe('committed')
  expect(fileMark('b.ts', none, ['a.ts'], none, 0)).toBeNull()
  expect(dirMark('src', { 'src/a.ts': 'M' }, [], none, 0)).toBe('dirty')
  expect(dirMark('src', none, ['src/a.ts'], none, 0)).toBe('committed')
  expect(dirMark('src', { 'src/a.ts': 'M' }, [], { 'src/b.ts': 5 }, 6)).toBe('active')
  expect(dirMark('srcx', { 'src/a.ts': 'M' }, [], none, 0)).toBeNull()
})

test('a path is made relative to the root, or dropped when outside it', () => {
  expect(relative('/w', '/w/src/a.ts')).toBe('src/a.ts')
  expect(relative('/w/', '/w/a.ts')).toBe('a.ts')
  expect(relative('/w', '/etc/passwd')).toBeNull()
  expect(relative('/w', '/work2/a.ts')).toBeNull()
  expect(relative('/w', './a.ts')).toBe('a.ts')
})

// ── the hooks, over the engine ───────────────────────────────────────────────

const PANE = {
  component: 'Pane',
  requestId: 'file-tree',
  props: { title: 'Files', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SESSION = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'tree', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const
const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })

const disk: Record<string, ReturnType<typeof entry>[]> = {
  '/w': [entry('src', 'dir'), entry('node_modules', 'dir'), entry('README.md', 'file')],
  '/w/src': [entry('main.ts', 'file'), entry('util.ts', 'file')],
}
const git = { status: ' M src/main.ts\n', diff: 'src/util.ts\n', head: 'abc123\n' }
const calls = { lists: [] as string[], copied: [] as string[], runs: [] as string[][] }

function plumbing(on: On, hasGit = true, canOpenPane = true) {
  calls.lists.length = 0
  calls.copied.length = 0
  calls.runs.length = 0
  const clock = mock.clock(on)
  const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.start', ($, ev) => ({ cwd: ev.cwd }))
  on('command.register', () => ({ value: { command: 'tree' } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.list', (_$, ev) => {
    calls.lists.push(ev.path)
    return { value: disk[ev.path] ?? [] }
  })
  on('process.run', (_$, ev) => {
    calls.runs.push([...ev.argv])
    if (!hasGit) throw new Error('not a git repository')
    if (ev.argv[1] === 'status') return out(git.status)
    if (ev.argv[1] === 'rev-parse') return out(git.head)
    if (ev.argv[1] === 'diff') return out(git.diff)
    return out('')
  })
  on('ui.open', () => {
    if (!canOpenPane) throw new Error('this surface holds no panes')
    return { value: { isPlaced: true } }
  })
  on('ui.copy', (_$, ev) => {
    calls.copied.push(ev.text)
    return { value: { isCopied: true } }
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', ($, ev) => ({ text: ev.answer }))
  return clock
}


test('/tree lists the root, hides noise, and shows committed and changed files in their colours once opened', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  const out = await $.command.run(RUN)
  expect(out.text).toContain('w/')
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /node_modules/ })).toBeUndefined()
  expect(await ui.find({ key: 'src' })).toBeDefined()
  expect(await ui.find({ key: 'README.md' })).toBeDefined()
  // src holds a changed file and a committed one: the folder carries the louder mark, yellow.
  const folder = (await ui.findAll({ type: 'Text', text: /src\// }))[0]
  expect(folder?.props.color).toBe('yellow')
  await ui.press({ key: 'src' })
  const main = (await ui.findAll({ type: 'Text', text: /main\.ts/ }))[0]
  const util = (await ui.findAll({ type: 'Text', text: /util\.ts/ }))[0]
  expect(main?.props.color).toBe('yellow')
  expect(main?.text).toContain(' M')
  expect(util?.props.color).toBe('green')
  expect(util?.text).toContain('●')
  // "Committed this session" is measured from the HEAD the session began on, and only the first sight of it.
  expect(calls.runs).toContainEqual(['git', 'diff', '--name-only', 'abc123..HEAD'])
  expect(calls.runs.filter(a => a[1] === 'rev-parse').length).toBe(1)
  await ui.unmount()
})

test('pressing a folder opens and closes it, loading it only the first time', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  await ui.press({ key: 'src' })
  expect(await ui.find({ key: 'src/main.ts' })).toBeDefined()
  await ui.press({ key: 'src' })
  expect(await ui.find({ key: 'src/main.ts' })).toBeUndefined()
  await ui.press({ key: 'src' })
  expect(await ui.find({ key: 'src/main.ts' })).toBeDefined()
  expect(calls.lists.filter(p => p === '/w/src').length).toBe(1)
  await ui.unmount()
})

test('pressing a file copies its full path', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  await ui.press({ key: 'README.md' })
  expect(calls.copied).toEqual(['/w/README.md'])
  expect(await ui.find({ type: 'Text', text: /Copied README\.md/ })).toBeDefined()
  await ui.unmount()
})

test('a file Claude touches shimmers for a few seconds and then settles', async ($, on) => {
  const clock = plumbing(on)
  git.status = ''
  git.diff = ''
  await $.session.start(SESSION)
  await $.command.run(RUN)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/w/README.md' })
  let ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  const shown = async () => (await ui.findAll({ type: 'Text', text: /README\.md/ }))[0]
  expect((await shown())?.props.color).toBe('cyan')
  const first = (await shown())?.props.bold
  await clock.advance(400)
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect((await shown())?.props.bold).not.toBe(first)
  await clock.advance(ACTIVE_MS)
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect((await shown())?.props.color).toBeUndefined()
  await ui.unmount()
  git.status = ' M src/main.ts\n'
  git.diff = 'src/util.ts\n'
})

test('a path outside the workspace, or a subagent\'s, is not shown as active', async ($, on) => {
  plumbing(on)
  git.status = ''
  git.diff = ''
  await $.session.start(SESSION)
  await $.command.run(RUN)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u1', file_path: '/etc/hosts' })
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', agentId: 'sub1', file_path: '/w/README.md' } as never)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect((await ui.findAll({ type: 'Text', text: /README\.md/ }))[0]?.props.color).toBeUndefined()
  await ui.unmount()
  git.status = ' M src/main.ts\n'
  git.diff = 'src/util.ts\n'
})

test('git is re-read when a turn ends, so a file committed meanwhile turns green', async ($, on) => {
  plumbing(on)
  git.status = ' M src/main.ts\n'
  git.diff = ''
  await $.session.start(SESSION)
  await $.command.run(RUN)
  let ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  await ui.press({ key: 'src' })
  expect((await ui.findAll({ type: 'Text', text: /main\.ts/ }))[0]?.props.color).toBe('yellow')
  await ui.unmount()

  git.status = ''
  git.diff = 'src/main.ts\n'
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect((await ui.findAll({ type: 'Text', text: /main\.ts/ }))[0]?.props.color).toBe('green')
  await ui.unmount()
  git.status = ' M src/main.ts\n'
  git.diff = 'src/util.ts\n'
})

test('outside a repository the tree still lists files, without colours', async ($, on) => {
  plumbing(on, false)
  await $.session.start(SESSION)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ plugin: 'file-tree', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'README.md' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /src\// }))[0]?.props.color).toBeUndefined()
  await ui.unmount()
})

// ── without the pane (a phone draws none): /tree in words ────────────────────

const ent = (name: string, kind: 'file' | 'dir') => ({ name, kind })

test('a folder as lines: folders with what is inside them, files with their flag, and the totals', () => {
  const text = listing({
    root: '/work/app',
    dir: '',
    entries: [ent('src', 'dir'), ent('docs', 'dir'), ent('README.md', 'file'), ent('notes.txt', 'file')],
    status: { 'src/main.ts': 'M', 'notes.txt': '?' },
    committed: ['docs/a.md', 'README.md'],
    active: {},
    now: 0,
  })
  expect(text).toBe(
    [
      'app/',
      '▸ src/  (changes inside)',
      '▸ docs/  (committed inside)',
      '  README.md ●',
      '  notes.txt ?',
      '',
      '2 changed, 2 committed this session',
      'Changed: src/main.ts M, notes.txt ?',
      '/tree <folder> lists a folder. ● committed, M/A/D/? changed.',
    ].join('\n'),
  )
  expect(listing({ root: '/work/app', dir: 'src', entries: [], status: {}, committed: [], active: {}, now: 0 })).toContain('app/src/\n  (empty)')
  const many = Array.from({ length: 70 }, (_, i) => ent(`f${i}.ts`, 'file'))
  expect(listing({ root: '/w', dir: '', entries: many, status: {}, committed: [], active: {}, now: 0 })).toContain('… 10 more')
})

test('a long list of changes is cut at ten names with a count of the rest', () => {
  const status = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}.ts`, 'M']))
  const text = listing({ root: '/w', dir: '', entries: [], status, committed: [], active: {}, now: 0 })
  expect(text).toContain('12 changed, 0 committed this session')
  expect(text).toContain('f9.ts M, … 2 more')
  expect(text).not.toContain('f10.ts')
})

test('a folder argument must stay inside the workspace', () => {
  expect(folderArg('src/ui/')).toBe('src/ui')
  expect(folderArg('./src')).toBe('src')
  expect(folderArg('')).toBe('')
  expect(folderArg('/etc')).toBeNull()
  expect(folderArg('../secrets')).toBeNull()
  expect(folderArg('src/../../x')).toBeNull()
})

test('/tree prints the root as text even where no pane can open; /tree src prints that folder; /tree .. is refused', async ($, on) => {
  plumbing(on, true, false)
  await $.session.start(SESSION)
  const root = (await $.command.run(RUN)).text ?? ''
  expect(root).toContain('▸ src/  (changes inside)')
  expect(root).toContain('  README.md')
  expect(root).not.toContain('node_modules')
  const src = (await $.command.run({ ...RUN, args: 'src' })).text ?? ''
  expect(src).toContain('w/src/')
  expect(src).toContain('  main.ts M')
  expect(src).toContain('  util.ts ●')
  expect((await $.command.run({ ...RUN, args: '../x' })).text).toBe('Only folders inside the workspace: /tree <folder>.')
})
