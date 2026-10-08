/**
 * Skins as data. Pure.
 *
 * A skin is a handful of tokens. The presets are below; a person's own are a JSON file with the same
 * keys (any it leaves out come from the preset named in its `extends`, `tokyo` if none), read through
 * `parseSkin`, which refuses anything that is not a short colour or a short bullet so that a file from a
 * cloned repository cannot put arbitrary text into the transcript's styling.
 */
import type { Tokens } from '../types'

export const PRESETS: Readonly<Record<string, Tokens>> = {
  // Tokyo Night's own palette.
  tokyo: { name: 'tokyo', accent: '#7aa2f7', user: '#bb9af7', assistant: '#c0caf5', tool: '#7dcfff', dim: '#565f89', ok: '#9ece6a', error: '#f7768e', add: '#9ece6a', del: '#f7768e', userBullet: '❯', assistantBullet: '●', toolBullet: '▸' },
  // A warm, low-contrast dark palette of this mod's own.
  noah: { name: 'noah', accent: '#d97757', user: '#e8c39e', assistant: '#ece3d6', tool: '#a8b5a2', dim: '#8a8175', ok: '#a8b5a2', error: '#d9534f', add: '#a8b5a2', del: '#d9534f', userBullet: '›', assistantBullet: '◆', toolBullet: '·' },
  // For light terminals.
  paper: { name: 'paper', accent: '#1a56db', user: '#6b21a8', assistant: '#111827', tool: '#0e7490', dim: '#6b7280', ok: '#15803d', error: '#b91c1c', add: '#15803d', del: '#b91c1c', userBullet: '>', assistantBullet: '*', toolBullet: '-' },
  // No colour at all: structure only.
  mono: { name: 'mono', accent: 'white', user: 'white', assistant: 'white', tool: 'white', dim: 'gray', ok: 'white', error: 'white', add: 'white', del: 'white', userBullet: '>', assistantBullet: '*', toolBullet: '-' },
}

export const PRESET_NAMES = Object.keys(PRESETS)

const COLOR = /^[#a-zA-Z0-9(),.%\- ]{1,32}$/
const COLOR_KEYS = ['accent', 'user', 'assistant', 'tool', 'dim', 'ok', 'error', 'add', 'del'] as const
const BULLET_KEYS = ['userBullet', 'assistantBullet', 'toolBullet'] as const

export type Parsed = { ok: true; skin: Tokens } | { ok: false; error: string }

export function parseSkin(text: string): Parsed {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'not valid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'expected a JSON object' }
  const o = raw as Record<string, unknown>
  const from = typeof o.extends === 'string' ? o.extends : 'tokyo'
  const base = PRESETS[from]
  if (base === undefined) return { ok: false, error: `extends "${from}", which is not a preset (${PRESET_NAMES.join(', ')})` }
  const out: Tokens = { ...base, name: typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim().slice(0, 24) : 'custom' }
  for (const k of COLOR_KEYS) {
    const v = o[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || !COLOR.test(v)) return { ok: false, error: `${k} must be a colour name or hex value` }
    out[k] = v
  }
  for (const k of BULLET_KEYS) {
    const v = o[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || [...v].length < 1 || [...v].length > 2) return { ok: false, error: `${k} must be one or two characters` }
    out[k] = v
  }
  return { ok: true, skin: out }
}

/** What `/skin <arg>` means. A path is anything ending in .json. */
export type Choice = { kind: 'list' } | { kind: 'off' } | { kind: 'preset'; skin: Tokens } | { kind: 'file'; path: string } | { kind: 'unknown'; arg: string }

export function choose(arg: string): Choice {
  const a = arg.trim()
  if (a === '') return { kind: 'list' }
  if (a === 'off' || a === 'default') return { kind: 'off' }
  const preset = PRESETS[a.toLowerCase()]
  if (preset !== undefined) return { kind: 'preset', skin: preset }
  if (a.endsWith('.json')) return { kind: 'file', path: a }
  return { kind: 'unknown', arg: a }
}

export type DiffLine = { sign: '+' | '-'; text: string }

/** The lines an edit removes then adds, cut at `max` with a count of what was left out. */
export function diffLines(before: string, after: string, max = 10): { lines: DiffLine[]; more: number } {
  const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))
  const all: DiffLine[] = [...split(before).map(text => ({ sign: '-' as const, text })), ...split(after).map(text => ({ sign: '+' as const, text }))]
  return { lines: all.slice(0, max), more: Math.max(0, all.length - max) }
}

const str = (input: unknown, key: string): string | undefined => {
  const v = (input as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' ? v : undefined
}

export const HANDLED = new Set(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'])

/** The one-line summary of a call the row shows after the tool's name. */
export function toolSummary(tool: string, input: unknown): string {
  const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  if (tool === 'Bash') return clip((str(input, 'command') ?? '').split('\n')[0] ?? '')
  if (tool === 'Grep' || tool === 'Glob') return clip(str(input, 'pattern') ?? '')
  return clip(str(input, 'file_path') ?? '')
}

export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
