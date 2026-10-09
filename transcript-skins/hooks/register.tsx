import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tokens } from '../types'
import { HANDLED, PRESETS, PRESET_NAMES, choose, diffLines, duration, parseSkin, toolSummary } from './skins'

const skin = atom({ plugin: 'transcript-skins', key: 'skin' } as const, null)
const STORE_KEY = 'skin'


export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'skin', description: 'Re-theme the transcript: /skin [tokyo|noah|paper|mono|off|<file.json>]' })
    } catch {
      // A mode with no session bound cannot register a command; the command still answers, and the rest of start-up must still run.
    }
    const saved = (await $.store.get(STORE_KEY)) as Tokens | 'off' | null | undefined
    if (saved === 'off') await update($, skin, () => null)
    else if (saved !== undefined && saved !== null && typeof saved === 'object') await update($, skin, () => saved)
    else {
      const initial = typeof options.defaultSkin === 'string' ? PRESETS[options.defaultSkin] : undefined
      await update($, skin, () => initial ?? null)
    }

    return next(e)
  })

  on('command.run', { command: 'skin' }, async ($, e) => {
    const pick = choose(e.args)
    const current = await read($, skin)
    if (pick.kind === 'list') {
      return { text: `Skin: ${current?.name ?? 'off'}. Presets: ${PRESET_NAMES.join(', ')}. /skin off restores Claude Code's own drawing; /skin path/to/skin.json loads your own.` }
    }
    if (pick.kind === 'unknown') return { text: `No skin called "${pick.arg}". Presets: ${PRESET_NAMES.join(', ')}, or a path to a .json file.` }
    let next: Tokens | null = null
    if (pick.kind === 'preset') next = pick.skin
    if (pick.kind === 'file') {
      const cwd = await $.session.cwd()
      const path = pick.path.startsWith('/') ? pick.path : `${cwd}/${pick.path}`
      let text: string
      try {
        text = (await $.fs.read(path)) as string
      } catch (error) {
        return { text: `Could not read ${path}: ${String(error)}` }
      }
      const parsed = parseSkin(text)
      if (!parsed.ok) return { text: `${pick.path}: ${parsed.error}.` }
      next = parsed.skin
    }
    await update($, skin, () => next)
    await $.store.set(STORE_KEY, next ?? 'off')

    return { text: next === null ? "Skin off: the transcript is Claude Code's own." : `Skin: ${next.name}.` }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const s = await read($, skin)
    if (s === null || e.props.origin.kind !== 'composer') return next(e)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text bold color={s.user}>
          {s.userBullet}{' '}
        </Text>
        <Text color={s.user}>{e.props.text}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const s = await read($, skin)
    if (s === null || e.props.isSummary === true) return next(e)
    const { Box, Markdown, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={s.assistant}>{e.props.isFirstOfReply ? `${s.assistantBullet} ` : '  '}</Text>
        <Markdown text={e.props.text} />
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const s = await read($, skin)
    const p = e.props
    if (s === null || !HANDLED.has(p.tool)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const input = p.input as { old_string?: unknown; new_string?: unknown; content?: unknown } | null
    const diff =
      p.tool === 'Edit'
        ? diffLines(typeof input?.old_string === 'string' ? input.old_string : '', typeof input?.new_string === 'string' ? input.new_string : '')
        : p.tool === 'Write'
          ? diffLines('', typeof input?.content === 'string' ? input.content : '')
          : null
    const status = p.isRunning ? '…' : p.isInterrupted ? 'interrupted' : p.isErrored ? '✗' : '✓'
    const statusColor = p.isErrored || p.isInterrupted ? s.error : p.isRunning ? s.dim : s.ok

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={s.tool}>{s.toolBullet} </Text>
          <Text bold color={p.isErrored ? s.error : s.tool}>
            {p.tool}
          </Text>
          <Text color={s.dim}> {toolSummary(p.tool, p.input)} </Text>
          <Text color={statusColor}>{status}</Text>
        </Box>
        {diff !== null &&
          diff.lines.map((l, i) => (
            <Text key={`${i}`} color={l.sign === '+' ? s.add : s.del}>
              {'  '}
              {l.sign} {l.text}
            </Text>
          ))}
        {diff !== null && diff.more > 0 && <Text color={s.dim}>{`  … ${diff.more} more line${diff.more === 1 ? '' : 's'}`}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const s = await read($, skin)
    if (s === null || e.props.isErrored || (e.props.tool !== 'Edit' && e.props.tool !== 'Write')) return next(e)
    const { Text } = $.ui.resolve(e)

    return <Text color={s.dim}>{'  '}↳ applied</Text>
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const s = await read($, skin)
    if (s === null) return next(e)
    const { Text } = $.ui.resolve(e)

    return (
      <Text color={s.dim}>
        ✻ {e.props.word} for {duration(e.props.durationMs)}
      </Text>
    )
  })
}
