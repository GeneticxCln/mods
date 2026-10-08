/**
 * What the progress band shows, as plain functions. Pure.
 */
import type { Todos } from '../types'

export type Theme = 'invader' | 'cat' | 'ghost' | 'robot' | 'blocks' | 'none'

const SPRITES: Record<Exclude<Theme, 'none'>, readonly [string, string]> = {
  invader: ['<o_o>', '>o_o<'],
  cat: ['=^.^=', '=^o^='],
  ghost: ['(o o)', '(o_o)'],
  robot: ['[•_•]', '[•‿•]'],
  blocks: ['▙▟', '▛▜'],
}

/** The mascot for an agent in a state: it animates while running, rests while waiting, and shows how it ended. */
export function sprite(theme: Theme, frame: number, status: string): string {
  if (theme === 'none') return ''
  if (status === 'completed') return theme === 'blocks' ? '▀▀' : '[^_^]'
  if (status === 'failed' || status === 'killed') return theme === 'blocks' ? '▚▞' : '[x_x]'
  const frames = SPRITES[theme]
  return status === 'running' ? frames[Math.abs(frame) % 2]! : frames[0]
}

const FULL = '▰'
const EMPTY = '▱'

/** `done` of `total` as a bar; with no total, a marker that sweeps along so the band is visibly alive. */
export function bar(width: number, todos: Todos | null, frame: number): string {
  if (todos === null || todos.total === 0) {
    const at = Math.abs(frame) % (width * 2 - 2 || 1)
    const pos = at < width ? at : width * 2 - 2 - at
    return Array.from({ length: width }, (_, i) => (i === pos ? FULL : EMPTY)).join('')
  }
  const filled = Math.round((todos.done / todos.total) * width)
  return FULL.repeat(filled) + EMPTY.repeat(width - filled)
}

/** What the whole task will cost if the rest costs what the done part did; null until there is enough to go on. */
export function projected(spent: number | null, todos: Todos | null): number | null {
  if (spent === null || spent <= 0 || todos === null || todos.total === 0) return null
  const fraction = todos.done / todos.total
  return fraction >= 0.2 ? spent / fraction : null
}

export const money = (n: number): string => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const thousands = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n))

/** Read a TodoWrite call's list; anything that is not that list gives null. */
export function todosOf(input: unknown): Todos | null {
  const list = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(list) || list.length === 0) return null
  let done = 0
  let current: string | null = null
  for (const t of list) {
    const o = t as { status?: unknown; content?: unknown; activeForm?: unknown }
    if (o.status === 'completed') done++
    else if (o.status === 'in_progress' && current === null) current = typeof o.activeForm === 'string' ? o.activeForm : typeof o.content === 'string' ? o.content : null
  }
  return { done, total: list.length, current }
}

export const isTheme = (v: unknown): v is Theme => v === 'invader' || v === 'cat' || v === 'ghost' || v === 'robot' || v === 'blocks' || v === 'none'
