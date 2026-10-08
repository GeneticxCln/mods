/**
 * The tree as data. Pure.
 */
import type { Entry } from '../types'

/** Directories that are noise in a tree: never listed. */
export const IGNORED = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target', '.cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea'])

/** A file is "active" for this long after Claude touches it. */
export const ACTIVE_MS = 6000
export const MAX_ROWS = 400

/** Entries worth showing, directories first, then by name. */
export function tidy(entries: ReadonlyArray<{ name: string; kind: 'file' | 'dir' | 'other' }>): Entry[] {
  return entries
    .filter(e => e.kind !== 'other' && !(e.kind === 'dir' && IGNORED.has(e.name)))
    .map(e => ({ name: e.name, kind: e.kind as 'dir' | 'file' }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
}

export type Row = { path: string; name: string; depth: number; kind: 'dir' | 'file'; isOpen: boolean }

/** The rows to draw: the open directories expanded, depth first. Stops at `max` rows. */
export function flatten(children: Readonly<Record<string, Entry[]>>, expanded: readonly string[], max = MAX_ROWS): Row[] {
  const open = new Set(expanded)
  const rows: Row[] = []
  const walk = (dir: string, depth: number) => {
    for (const e of children[dir] ?? []) {
      if (rows.length >= max) return
      const path = dir === '' ? e.name : `${dir}/${e.name}`
      const isOpen = e.kind === 'dir' && open.has(path)
      rows.push({ path, name: e.name, depth, kind: e.kind, isOpen })
      if (isOpen) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return rows
}

/** `git status --porcelain` -> relative path -> its one-letter state. */
export function parseStatus(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ').pop()!
    path = path.replace(/^"|"$/g, '')
    const letter = code === '??' ? '?' : code.includes('D') ? 'D' : code.includes('A') ? 'A' : 'M'
    out[path] = letter
  }
  return out
}

export const parseNames = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(Boolean)

/** A directory carries the mark of the loudest thing under it: so a collapsed folder still shows there is a change inside. */
export function dirMark(dir: string, status: Readonly<Record<string, string>>, committed: readonly string[], active: Readonly<Record<string, number>>, now: number): 'active' | 'dirty' | 'committed' | null {
  const prefix = `${dir}/`
  if (Object.entries(active).some(([p, t]) => p.startsWith(prefix) && now - t < ACTIVE_MS)) return 'active'
  if (Object.keys(status).some(p => p.startsWith(prefix))) return 'dirty'
  if (committed.some(p => p.startsWith(prefix))) return 'committed'
  return null
}

export function fileMark(path: string, status: Readonly<Record<string, string>>, committed: readonly string[], active: Readonly<Record<string, number>>, now: number): 'active' | 'dirty' | 'committed' | null {
  const t = active[path]
  if (t !== undefined && now - t < ACTIVE_MS) return 'active'
  if (status[path] !== undefined) return 'dirty'
  return committed.includes(path) ? 'committed' : null
}

/** Make a path from a tool call relative to the root; null when it is outside it. */
export function relative(root: string, path: string): string | null {
  if (!path.startsWith('/')) return path.replace(/^\.\//, '')
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : null
}

export const hasRecent = (active: Readonly<Record<string, number>>, now: number): boolean => Object.values(active).some(t => now - t < ACTIVE_MS)

/** Drop entries that have long since stopped shimmering. */
export function pruned(active: Readonly<Record<string, number>>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(active).filter(([, t]) => now - t < ACTIVE_MS * 10))
}
