import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry } from '../types'
import { dirMark, fileMark, flatten, folderArg, hasRecent, listing, parseNames, parseStatus, pruned, relative, tidy } from './tree'

const PANE = 'file-tree'

const root = atom({ plugin: 'file-tree', key: 'root' } as const, null)
const children = atom({ plugin: 'file-tree', key: 'children' } as const, {})
const expanded = atom({ plugin: 'file-tree', key: 'expanded' } as const, [])
const active = atom({ plugin: 'file-tree', key: 'active' } as const, {})
const status = atom({ plugin: 'file-tree', key: 'status' } as const, {})
const committed = atom({ plugin: 'file-tree', key: 'committed' } as const, [])
const base = atom({ plugin: 'file-tree', key: 'base' } as const, null)
const now = atom({ plugin: 'file-tree', key: 'now' } as const, 0)
const frame = atom({ plugin: 'file-tree', key: 'frame' } as const, 0)
const selected = atom({ plugin: 'file-tree', key: 'selected' } as const, null)

const SHIMMER_MS = 400

async function listDir($: EngineInterface, cwd: string, dir: string): Promise<Entry[]> {
  try {
    return tidy(await $.fs.list(dir === '' ? cwd : `${cwd}/${dir}`))
  } catch {
    return []
  }
}

/** Re-read git: what is dirty now and what was committed since the session began. */
async function refreshGit($: EngineInterface, cwd: string): Promise<void> {
  try {
    const st = await $.process.run(['git', 'status', '--porcelain'], { cwd, timeoutMs: 5000 })
    await update($, status, () => (st.exitCode === 0 ? parseStatus(st.stdout) : {}))
    let from = await read($, base)
    if (from === null) {
      const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd, timeoutMs: 5000 })
      if (head.exitCode === 0) {
        from = head.stdout.trim()
        await update($, base, () => from)
      }
    }
    if (from !== null) {
      const diff = await $.process.run(['git', 'diff', '--name-only', `${from}..HEAD`], { cwd, timeoutMs: 5000 })
      await update($, committed, () => (diff.exitCode === 0 ? parseNames(diff.stdout) : []))
    }
  } catch {
    // Not a repository, or git is missing: the tree still works, without the colours.
  }
}

async function loadTree($: EngineInterface): Promise<void> {
  const cwd = await $.session.cwd()
  await update($, root, () => cwd)
  await update($, children, c => ({ ...c, '': c[''] ?? [] }))
  const top = await listDir($, cwd, '')
  await update($, children, c => ({ ...c, '': top }))
  await refreshGit($, cwd)
}

async function toggle($: EngineInterface, dir: string): Promise<void> {
  const cwd = await read($, root)
  if (cwd === null) return
  const isOpen = (await read($, expanded)).includes(dir)
  if (isOpen) {
    await update($, expanded, list => list.filter(d => d !== dir))
    return
  }
  const known = (await read($, children))[dir]
  if (known === undefined) {
    const entries = await listDir($, cwd, dir)
    await update($, children, c => ({ ...c, [dir]: entries }))
  }
  await update($, expanded, list => [...list, dir])
}

async function shimmer($: EngineInterface): Promise<void> {
  const t = await $.clock.now()
  const files = await read($, active)
  // One tick past the end as well: that is the redraw that lets the last shimmering file settle.
  if (!hasRecent(files, t) && !hasRecent(files, await read($, now))) return
  await update($, now, () => t)
  await update($, frame, n => n + 1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'tree', description: 'Open the file tree pane: /tree [refresh]' })
    $.clock.every(SHIMMER_MS, () => void shimmer($))

    return next(e)
  })

  on('command.run', { command: 'tree' }, async ($, e) => {
    const arg = e.args.trim()
    const isRefresh = arg === 'refresh'
    const dir = isRefresh ? '' : folderArg(arg)
    if (dir === null) return { text: 'Only folders inside the workspace: /tree <folder>.' }
    if ((await read($, root)) === null || isRefresh) await loadTree($)
    try {
      await $.ui.open({ id: PANE, title: 'Files' })
    } catch {
      // A surface that cannot hold a pane still gets the text below.
    }
    const cwd = (await read($, root)) ?? (await $.session.cwd())
    let entries = (await read($, children))[dir]
    if (entries === undefined) {
      entries = await listDir($, cwd, dir)
      const loaded = entries
      await update($, children, c => ({ ...c, [dir]: loaded }))
    }

    return {
      text: listing({ root: cwd, dir, entries, status: await read($, status), committed: await read($, committed), active: await read($, active), now: await $.clock.now() }),
    }
  })

  on('tool.call', async ($, e, next) => {
    const input: unknown = e
    const file = (input as { file_path?: unknown }).file_path
    const cwd = await read($, root)
    if (typeof file === 'string' && cwd !== null && e.agentId === undefined) {
      const rel = relative(cwd, file)
      if (rel !== null) {
        const t = await $.clock.now()
        await update($, active, a => ({ ...pruned(a, t), [rel]: t }))
        await update($, now, () => t)
      }
    }
    const ran = await next(e)
    if (cwd !== null && (e.tool === 'Bash' || e.tool === 'Write' || e.tool === 'Edit')) await refreshGit($, cwd)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const cwd = await read($, root)
    if (cwd !== null) await refreshGit($, cwd)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const cwd = await read($, root)
    const kids = await read($, children)
    const openDirs = await read($, expanded)
    const files = await read($, active)
    const dirty = await read($, status)
    const done = await read($, committed)
    const t = await read($, now)
    const f = await read($, frame)
    const picked = await read($, selected)

    if (cwd === null) return <Text dimColor>Run /tree to load the file tree.</Text>
    const rows = flatten(kids, openDirs)

    return (
      <Box flexDirection="column">
        <Text bold>{cwd.split('/').pop() || cwd}</Text>
        <Text dimColor>
          <Text color="green">committed</Text> <Text color="yellow">changed</Text> <Text color="cyan">active</Text>
        </Text>
        {rows.length === 0 && <Text dimColor>Nothing to show here.</Text>}
        {rows.map((r, i) => {
          const mark = r.kind === 'dir' ? dirMark(r.path, dirty, done, files, t) : fileMark(r.path, dirty, done, files, t)
          const color = mark === 'committed' ? 'green' : mark === 'dirty' ? 'yellow' : mark === 'active' ? 'cyan' : undefined
          const glint = mark === 'active' && (f + i) % 2 === 0
          const label = `${'  '.repeat(r.depth)}${r.kind === 'dir' ? (r.isOpen ? '▾ ' : '▸ ') : '  '}${r.name}${r.kind === 'dir' ? '/' : ''}`
          const flag = r.kind === 'file' && dirty[r.path] !== undefined ? ` ${dirty[r.path]}` : mark === 'committed' && r.kind === 'file' ? ' ●' : ''
          return (
            <Button
              key={r.path}
              plain
              onPress={() => (r.kind === 'dir' ? toggle($, r.path) : copy($, cwd, r.path))}
            >
              <Text color={color} bold={glint} dimColor={mark === null && r.kind === 'file'}>
                {label}
                {flag}
              </Text>
            </Button>
          )
        })}
        {picked !== null && <Text dimColor>Copied {picked}</Text>}
        <Box>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => loadTree($)} />
        </Box>
      </Box>
    )
  })
}

async function copy($: EngineInterface, cwd: string, path: string): Promise<void> {
  await update($, selected, () => path)
  await $.ui.copy({ text: `${cwd}/${path}` })
}
