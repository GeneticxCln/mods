import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'
import { TOAST_AFTER_MS, bar, duration, isTheme, money, projected, sprite, statusText, thousands, todosOf } from './progress'
import type { Theme } from './progress'

const startedAt = atom({ plugin: 'savvy-progress', key: 'startedAt' } as const, null)
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const frame = atom({ plugin: 'savvy-progress', key: 'frame' } as const, 0)
const todos = atom({ plugin: 'savvy-progress', key: 'todos' } as const, null)
const costStart = atom({ plugin: 'savvy-progress', key: 'costStart' } as const, null)
const cost = atom({ plugin: 'savvy-progress', key: 'cost' } as const, null)
const tokens = atom({ plugin: 'savvy-progress', key: 'tokens' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const summary = atom({ plugin: 'savvy-progress', key: 'summary' } as const, null)
const isHidden = atom({ plugin: 'savvy-progress', key: 'isHidden' } as const, false)

const TICK_MS = 1000
const BAR_WIDTH = 16
const MAX_AGENTS = 4

/** While a turn runs, once a second: move the clock and the animation, and read the cost, context and subagents. */
async function tick($: EngineInterface): Promise<void> {
  if ((await read($, startedAt)) === null) return
  const t = await $.clock.now()
  await update($, now, () => t)
  await update($, frame, n => n + 1)
  const usage = await $.session.usage()
  await update($, cost, () => usage.cost?.usd ?? null)
  await update($, tokens, () => usage.context.tokens ?? null)
  const list = await $.agent.list()
  const rows: AgentRow[] = list
    .filter(a => a.status !== 'idle')
    .slice(-MAX_AGENTS)
    .map(a => ({ id: a.id, label: `${a.type}: ${a.description}`.slice(0, 48), status: a.status }))
  await update($, agents, () => rows)
}

export const register: Register = (on, options) => {
  const theme: Theme = isTheme(options.mascot) ? options.mascot : 'robot'

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: 'What Claude is doing now, and the band above the prompt: /progress [show|hide]' })
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    const usage = await $.session.usage()
    await update($, startedAt, () => t)
    await update($, now, () => t)
    await update($, frame, () => 0)
    await update($, todos, () => null)
    await update($, agents, () => [])
    await update($, summary, () => null)
    await update($, costStart, () => usage.cost?.usd ?? null)
    await update($, cost, () => usage.cost?.usd ?? null)
    await update($, tokens, () => usage.context.tokens ?? null)

    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const list = todosOf(e)
    if (list !== null && e.agentId === undefined) await update($, todos, () => list)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const t = await $.clock.now()
    const began = await read($, startedAt)
    const usage = await $.session.usage()
    const was = await read($, costStart)
    const spent = usage.cost !== undefined && was !== null ? usage.cost.usd - was : null
    const parts = [`${e.isAborted ? 'Stopped' : 'Done'} in ${duration(began === null ? e.durationMs : t - began)}`]
    if (spent !== null && spent > 0) parts.push(money(spent))
    await update($, startedAt, () => null)
    await update($, agents, () => [])
    await update($, summary, () => parts.join(' · '))
    // The band is not drawn on every surface (a phone has none): a long turn's end is a toast as well.
    if (began !== null && t - began >= TOAST_AFTER_MS) $.ui.toast(parts.join(' · '), { timeoutMs: 8000 })

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      await update($, isHidden, () => arg === 'hide')
      return { text: arg === 'hide' ? 'Progress band hidden. /progress show brings it back.' : 'Progress band shown.' }
    }
    // No argument: say it in words, for the surfaces that draw no band.
    const spent = await read($, cost)
    const first = await read($, costStart)

    return {
      text: statusText({
        began: await read($, startedAt),
        now: await $.clock.now(),
        todos: await read($, todos),
        turnCost: spent !== null && first !== null ? Math.max(0, spent - first) : null,
        tokens: await read($, tokens),
        agents: await read($, agents),
        summary: await read($, summary),
      }),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const began = await read($, startedAt)
    const done = await read($, summary)
    if (began === null && done === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)

    if (began === null) {
      return (
        <Box>
          <Text dimColor>{done}</Text>
        </Box>
      )
    }

    const t = await read($, now)
    const f = await read($, frame)
    const list = await read($, todos)
    const spent = await read($, cost)
    const first = await read($, costStart)
    const toks = await read($, tokens)
    const rows = await read($, agents)
    const turnCost = spent !== null && first !== null ? Math.max(0, spent - first) : null
    const total = projected(turnCost, list)

    const facts = [duration(Math.max(0, t - began))]
    if (toks !== null) facts.push(`ctx ${thousands(toks)}`)
    if (turnCost !== null) facts.push(total === null ? money(turnCost) : `${money(turnCost)} (~${money(total)} projected)`)

    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">{bar(BAR_WIDTH, list, f)}</Text>
          {list === null ? '' : ` ${list.done}/${list.total}`}
          <Text dimColor>
            {' · '}
            {facts.join(' · ')}
          </Text>
        </Text>
        {list?.current != null && <Text dimColor>{list.current}</Text>}
        {rows.map(a => (
          <Text key={a.id} dimColor={a.status !== 'running'}>
            {theme === 'none' ? '-' : sprite(theme, f, a.status)} {a.label} <Text dimColor>{a.status}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
