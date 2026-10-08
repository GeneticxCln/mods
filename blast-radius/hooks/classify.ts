/**
 * What a shell command would do to the machine, read from its text alone.
 *
 * Pure: no engine, no clock, no disk. The hook asks this what a command is, then measures the
 * ones that name a path (`measure` in register.ts), so the rules here can be tested without either.
 *
 * It reads one level of shell: it splits on `;` `&&` `||` `|` and newlines outside quotes and looks at
 * each simple command. It does not expand variables, follow `$(...)` or understand `eval`; a command
 * built at run time gets past it. This is a seatbelt for the usual mistakes, not a sandbox.
 */

export type Kind =
  | 'rm-recursive'
  | 'git-reset-hard'
  | 'git-clean'
  | 'git-discard'
  | 'git-force-push'
  | 'git-delete-branch'
  | 'git-stash-drop'
  | 'disk-write'
  | 'recursive-permissions'
  | 'find-delete'
  | 'truncate'
  | 'sql-destructive'
  | 'pipe-to-shell'
  | 'infra-destroy'
  | 'publish'
  | 'sudo'
  | 'wipe-everything'

export type Finding = {
  kind: Kind
  /** `deny` is for commands with no use but harm; everything else is put to the person. */
  verdict: 'ask' | 'deny'
  /** One line, what the command does. */
  label: string
  /** The paths it names, where the kind has any and they can be measured. */
  targets: string[]
  /** The simple command it was found in. */
  segment: string
}

/** Split on the shell's command separators, outside quotes. */
export function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      current += c
      if (c === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      out.push(current)
      current = ''
      i++
    } else if (c === ';' || c === '\n' || (c === '|' && pair !== '||')) {
      out.push(current)
      current = ''
    } else if (c === '&') {
      out.push(current)
      current = ''
    } else {
      current += c
    }
  }
  out.push(current)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Whitespace-split with quotes honoured and removed: `rm -rf "my dir"` is three words. */
export function words(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null
      else current += c
    } else if (c === '"' || c === "'") {
      quote = c
      started = true
    } else if (/\s/.test(c)) {
      if (started || current) out.push(current)
      current = ''
      started = false
    } else {
      current += c
    }
  }
  if (started || current) out.push(current)
  return out
}

const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'command', 'nohup', 'nice', 'exec', 'builtin'])

/** The words after any `sudo`, `env A=b`, `time` in front, and whether sudo was one of them. */
export function strip(ws: string[]): { rest: string[]; isSudo: boolean } {
  let i = 0
  let isSudo = false
  while (i < ws.length) {
    const w = ws[i] as string
    if (w === 'sudo' || w === 'doas') isSudo = true
    if (WRAPPERS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || (w.startsWith('-') && i > 0 && WRAPPERS.has(ws[i - 1] as string))) {
      i++
      continue
    }
    break
  }
  return { rest: ws.slice(i), isSudo }
}

/** Paths whose loss is the machine's or the person's whole home, not a project. */
const WIPES = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '${HOME}', '$HOME/*', '/home', '/usr', '/etc', '/var', '/bin', '/lib', '/boot', '/root', '*', '.*', '..', '../'])

export function isWipeTarget(path: string): boolean {
  return WIPES.has(path.replace(/\/+$/, '') || '/') || WIPES.has(path)
}

const hasFlag = (ws: string[], short: string, long?: string): boolean =>
  ws.some(w => (long !== undefined && w === long) || (/^-[A-Za-z]+$/.test(w) && w.includes(short)))

const operands = (ws: string[]): string[] => {
  const out: string[] = []
  let isOptionsDone = false
  for (const w of ws) {
    if (!isOptionsDone && w === '--') isOptionsDone = true
    else if (isOptionsDone || !w.startsWith('-')) out.push(w)
  }
  return out
}

function ofSegment(segment: string): Finding[] {
  const { rest, isSudo } = strip(words(segment))
  const [cmd = '', ...args] = rest
  const found: Finding[] = []
  const add = (kind: Kind, label: string, targets: string[] = [], verdict: Finding['verdict'] = 'ask') =>
    found.push({ kind, verdict, label, targets, segment })

  if (isSudo) add('sudo', 'runs with administrator rights')

  const base = cmd.split('/').pop() ?? cmd
  const text = rest.join(' ')

  if (base === 'rm' && (hasFlag(args, 'r', '--recursive') || hasFlag(args, 'R'))) {
    const targets = operands(args)
    if (targets.some(isWipeTarget)) {
      add('wipe-everything', 'deletes a system or home directory recursively', targets, 'deny')
    } else {
      add('rm-recursive', 'deletes directories and everything under them', targets)
    }
  }

  if (base === 'git') {
    const sub = args.find(a => !a.startsWith('-')) ?? ''
    const after = args.slice(args.indexOf(sub) + 1)
    if (sub === 'reset' && after.includes('--hard')) add('git-reset-hard', 'throws away every uncommitted change to tracked files')
    if (sub === 'clean' && (hasFlag(after, 'f', '--force') && !hasFlag(after, 'n', '--dry-run'))) {
      add('git-clean', 'deletes untracked files for good', operands(after))
    }
    if ((sub === 'checkout' || sub === 'restore') && (after.includes('.') || after.includes('--') && after.includes('.'))) {
      add('git-discard', 'discards uncommitted changes in the working tree')
    }
    if (sub === 'push' && (after.some(a => a === '--force' || a.startsWith('--force-with-lease') || a === '--mirror') || hasFlag(after, 'f') || after.some(a => a.startsWith('+') && a.length > 1))) {
      add('git-force-push', 'rewrites the remote branch other people may have pulled')
    }
    if (sub === 'branch' && (hasFlag(after, 'D') || after.includes('--delete') && after.includes('--force'))) {
      add('git-delete-branch', 'deletes a branch even if it is not merged')
    }
    if (sub === 'stash' && (after[0] === 'drop' || after[0] === 'clear')) add('git-stash-drop', 'drops stashed work, which git cannot bring back')
  }

  if (base === 'dd' && args.some(a => a.startsWith('of='))) add('disk-write', 'writes raw bytes over a file or device')
  if (base.startsWith('mkfs') || base === 'wipefs' || base === 'fdisk' || base === 'parted') add('disk-write', 'formats or repartitions a disk')
  if (/>\s*\/dev\/(sd|nvme|vd|hd)/.test(segment)) add('disk-write', 'redirects output onto a disk device')

  if ((base === 'chmod' || base === 'chown' || base === 'chgrp') && (hasFlag(args, 'R', '--recursive'))) {
    add('recursive-permissions', 'changes permissions or ownership of a whole tree', operands(args).slice(1))
  }

  if (base === 'find' && (args.includes('-delete') || (args.includes('-exec') && /\brm\b/.test(text)))) {
    add('find-delete', 'deletes every file find matches', args.filter(a => !a.startsWith('-')).slice(0, 1))
  }
  if (base === 'truncate' || base === 'shred') add('truncate', 'empties or overwrites a file in place', operands(args))

  if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(text) || /\bdelete\s+from\s+\w+\s*(;|$|")/i.test(text)) {
    add('sql-destructive', 'drops or empties database data')
  }

  if (/^(terraform|tofu)$/.test(base) && args.includes('destroy')) add('infra-destroy', 'tears down infrastructure')
  if (base === 'kubectl' && args.includes('delete')) add('infra-destroy', 'deletes cluster resources')
  if (base === 'docker' && args[0] === 'system' && args[1] === 'prune') add('infra-destroy', 'removes unused containers, images and volumes')
  if ((base === 'npm' || base === 'pnpm' || base === 'yarn' || base === 'cargo' || base === 'twine') && args.includes('publish')) {
    add('publish', 'publishes a package to a public registry')
  }
  return found
}

/** What the whole command line would do, one finding per risky simple command. */
export function classify(command: string): Finding[] {
  const found: Finding[] = []
  const pieces = segments(command)
  // `curl … | sh`: the pipe is what makes it risky, and it spans two pieces.
  if (/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(command)) {
    found.push({ kind: 'pipe-to-shell', verdict: 'ask', label: 'runs a script it downloads without showing it first', targets: [], segment: command })
  }
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
    found.push({ kind: 'wipe-everything', verdict: 'deny', label: 'is a fork bomb', targets: [], segment: command })
  }
  for (const piece of pieces) found.push(...ofSegment(piece))
  return found
}

/** Files a write should not touch without the person looking: secrets, shell startup, system config, git hooks. */
const SENSITIVE_PATHS: Array<[RegExp, string]> = [
  [/(^|\/)\.env(\.|$)/, 'an environment file that usually holds secrets'],
  [/(^|\/)\.ssh\//, 'SSH keys or config'],
  [/(^|\/)\.aws\/|(^|\/)\.gnupg\//, 'cloud or GPG credentials'],
  [/(^|\/)\.git\/(hooks|config)(\/|$)/, 'git hooks or config, which run code or change where history goes'],
  [/^\/etc\//, 'system configuration'],
  [/(^|\/)\.(bashrc|zshrc|profile|bash_profile|zprofile)$/, 'shell startup, which runs on every new terminal'],
  [/(^|\/)\.github\/workflows\//, 'CI workflows, which run with the repository\'s secrets'],
]

export function sensitivePath(path: string): string | undefined {
  return SENSITIVE_PATHS.find(([re]) => re.test(path))?.[1]
}
