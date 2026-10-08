import type { Register } from 'claude-code'

import { classify, sensitivePath } from './classify'
import type { Finding } from './classify'

/** How long to spend counting what a command would touch. The command is waiting on it. */
const MEASURE_MS = 3000
/** Paths listed in the prompt; the rest are counted. */
const SHOWN = 4

type Run = (argv: readonly string[], init?: { timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string }>

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

const bytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`

/** Files and bytes under a path, or undefined when it could not be counted in time. */
async function sizeOf(run: Run, path: string): Promise<{ files: number; size: number } | undefined> {
  try {
    const r = await run(['find', path, '-type', 'f', '-printf', '%s\\n'], { timeoutMs: MEASURE_MS })
    if (r.exitCode !== 0 && r.stdout === '') return undefined
    const lines = r.stdout.split('\n').filter(Boolean)
    return { files: lines.length, size: lines.reduce((sum, l) => sum + (Number(l) || 0), 0) }
  } catch {
    return undefined
  }
}

/** What the finding would reach, in a sentence, measured where it can be. */
async function measure(run: Run, f: Finding): Promise<string> {
  if (f.kind === 'rm-recursive' || f.kind === 'find-delete' || f.kind === 'recursive-permissions') {
    const shown = f.targets.slice(0, SHOWN)
    const parts: string[] = []
    let files = 0
    let size = 0
    let isPartial = false
    for (const t of shown) {
      const s = await sizeOf(run, t)
      if (s === undefined) isPartial = true
      else {
        files += s.files
        size += s.size
      }
    }
    if (shown.length > 0) parts.push(`${shown.join(' ')}${f.targets.length > SHOWN ? ` and ${f.targets.length - SHOWN} more` : ''}`)
    if (shown.length > 0 && !isPartial) parts.push(`${plural(files, 'file')}, ${bytes(size)}`)
    else if (isPartial) parts.push('size not counted')
    return parts.join(': ')
  }
  if (f.kind === 'git-clean') {
    try {
      const r = await run(['git', 'clean', '-n', '-d', ...f.targets], { timeoutMs: MEASURE_MS })
      const n = r.stdout.split('\n').filter(l => l.startsWith('Would remove')).length
      return `${plural(n, 'untracked path')} would be removed`
    } catch {
      return 'untracked files, not counted'
    }
  }
  if (f.kind === 'git-reset-hard' || f.kind === 'git-discard') {
    try {
      const r = await run(['git', 'status', '--porcelain'], { timeoutMs: MEASURE_MS })
      const lines = r.stdout.split('\n').filter(Boolean)
      const tracked = lines.filter(l => !l.startsWith('??')).length
      return tracked === 0 ? 'no uncommitted changes to lose' : `${plural(tracked, 'file')} with uncommitted changes`
    } catch {
      return 'uncommitted changes, not counted'
    }
  }
  return ''
}

const describe = (f: Finding, measured: string): string => `• ${f.label}${measured ? ` (${measured})` : ''}`

/** A guard that crashed must not become a pass: ask the person instead of trusting the call. */
const failClosed = async (
  _$: unknown,
  e: unknown,
  next: { called: boolean; (e: never): Promise<{ decision: 'allow' | 'ask' | 'deny' }> },
) => {
  if (next.called) return next(e as never)
  return { decision: 'ask' as const, reason: 'Blast Radius could not check this call, so it asks you.' }
}

export const register: Register = on => {
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const base = await next(e)
    const command = (e.input as { command?: unknown } | null)?.command
    if (base.decision === 'deny' || typeof command !== 'string') return base

    const findings = classify(command)
    if (findings.length === 0) return base

    const run: Run = (argv, init) => $.process.run(argv, init)
    const lines = await Promise.all(findings.map(async f => describe(f, await measure(run, f))))
    const isDenied = findings.some(f => f.verdict === 'deny')
    const reason = isDenied
      ? `Blast Radius refused this command:\n${lines.join('\n')}`
      : `Blast Radius: this command\n${lines.join('\n')}`

    return { ...base, decision: isDenied ? 'deny' : 'ask', reason }
  }).catch(failClosed)

  for (const tool of ['Write', 'Edit'] as const) {
    on('tool.check', { tool }, async ($, e, next) => {
      const base = await next(e)
      const path = (e.input as { file_path?: unknown } | null)?.file_path
      if (base.decision === 'deny' || typeof path !== 'string') return base
      const why = sensitivePath(path)
      if (why === undefined) return base
      return { ...base, decision: 'ask', reason: `Blast Radius: ${path} is ${why}.` }
    }).catch(failClosed)
  }
}
