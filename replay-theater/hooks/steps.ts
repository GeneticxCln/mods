/**
 * Turning a tool call into one step of a replay. Pure.
 */
import type { Run, Step } from '../types'

export const MAX_RUNS = 10
export const MAX_STEPS = 200
const DETAIL = 600

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const lines = (s: string): string[] => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

/**
 * A unified diff of replacing `before` with `after`: one hunk, every old line removed and every new line
 * added. The model's Edit names exactly the text it replaced, so this is that edit and not a guess at a
 * minimal diff of the whole file.
 */
export function unified(path: string, before: string, after: string): string {
  const old = lines(before)
  const added = lines(after)
  const body = [...old.map(l => `-${l}`), ...added.map(l => `+${l}`)]
  return `--- ${path}\n+++ ${path}\n@@ -1,${old.length} +1,${added.length} @@\n${body.join('\n')}\n`
}

const field = (input: unknown, key: string): string | undefined => {
  const v = (input as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' ? v : undefined
}

/** The step a call starts. `isError` is filled in when the call returns. */
export function stepOf(n: number, tool: string, input: unknown, agentId?: string): Step {
  const base = { n, tool, isError: false, ...(agentId === undefined ? {} : { agentId }) }
  const file = field(input, 'file_path') ?? field(input, 'notebook_path')
  if (tool === 'Edit' && file !== undefined) {
    const before = field(input, 'old_string') ?? ''
    const after = field(input, 'new_string') ?? ''
    return { ...base, title: `Edit ${file}`, file, diff: unified(file, before, after) }
  }
  if (tool === 'Write' && file !== undefined) {
    const content = field(input, 'content') ?? ''
    return { ...base, title: `Write ${file} (${lines(content).length} lines)`, file, diff: unified(file, '', content) }
  }
  if (tool === 'Bash') {
    const command = field(input, 'command') ?? ''
    return { ...base, title: `$ ${clip(command.split('\n')[0] ?? '', 100)}`, detail: command.includes('\n') ? clip(command, DETAIL) : undefined }
  }
  if (file !== undefined) return { ...base, title: `${tool} ${file}` }
  const pattern = field(input, 'pattern') ?? field(input, 'query') ?? field(input, 'url') ?? field(input, 'description')
  return { ...base, title: pattern === undefined ? tool : `${tool}: ${clip(pattern, 80)}` }
}

/** Add what a call printed to its step, for the ones whose output is the point. */
export function withOutcome(step: Step, text: string | undefined, isError: boolean): Step {
  const keeps = step.tool === 'Bash' || isError
  const out = text === undefined || text === '' || !keeps ? step.detail : clip(text.trim(), DETAIL)
  return { ...step, isError, detail: out }
}

export const filesTouched = (steps: readonly Step[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const s of steps) if (s.file !== undefined && !s.isError) out.set(s.file, (out.get(s.file) ?? 0) + 1)
  return out
}

/** Only turns that changed or ran something are worth a replay. */
export const isWorthReplaying = (steps: readonly Step[]): boolean => steps.some(s => s.tool !== 'Read' && s.tool !== 'Grep' && s.tool !== 'Glob')

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

export const LIST_MAX = 30

/** The whole task as plain lines, for surfaces that draw no pane: what was asked, then every step. */
export function replayText(run: Run): string {
  const files = filesTouched(run.steps)
  const head = [`"${run.prompt || 'Task'}"`]
  if (run.seconds !== null) head.push(`${run.seconds}s`)
  head.push(`${run.steps.length} step${run.steps.length === 1 ? '' : 's'}`)
  if (files.size > 0) head.push(`${files.size} file${files.size === 1 ? '' : 's'} changed`)
  const lines = [head.join(' · ')]
  for (const s of run.steps.slice(0, LIST_MAX)) lines.push(`${s.n}. ${s.isError ? 'failed: ' : ''}${s.title}`)
  if (run.steps.length > LIST_MAX) lines.push(`… ${run.steps.length - LIST_MAX} more`)
  lines.push('/replay <n> shows one step in full.')
  return lines.join('\n')
}

/** One step in full: its title, the diff of an edit, and what a command printed. */
export function stepText(step: Step): string {
  const lines = [`Step ${step.n}: ${step.isError ? 'failed: ' : ''}${step.title}`]
  if (step.diff !== undefined) lines.push('```diff', clip(step.diff.trimEnd(), 3000), '```')
  if (step.detail !== undefined) lines.push(step.detail)
  return lines.join('\n')
}
