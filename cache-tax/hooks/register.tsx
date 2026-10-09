import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { costs, dollars, minutes, numberOr, phase, pingEveryMs, statusText, thousands } from './tax'

const lastUsedAt = atom({ plugin: 'cache-tax', key: 'lastUsedAt' } as const, null)
const tokens = atom({ plugin: 'cache-tax', key: 'tokens' } as const, null)
const now = atom({ plugin: 'cache-tax', key: 'now' } as const, 0)
const isKeepWarm = atom({ plugin: 'cache-tax', key: 'isKeepWarm' } as const, false)
const pings = atom({ plugin: 'cache-tax', key: 'pings' } as const, 0)
const isDismissed = atom({ plugin: 'cache-tax', key: 'isDismissed' } as const, false)
const isToldCold = atom({ plugin: 'cache-tax', key: 'isToldCold' } as const, false)

const TICK_MS = 30_000

type Settings = { ttl: number; maxPings: number; price: number }

/** Every 30 seconds: move the clock the band reads, say when the cache is about to cool, and ping if asked to. */
async function tick($: EngineInterface, c: Settings): Promise<void> {
  const t = await $.clock.now()
  await update($, now, () => t)
  const last = await read($, lastUsedAt)
  const toks = await read($, tokens)
  const idle = last === null ? null : t - last
  const p = phase(idle, toks, c.ttl)
  $.ui.status(p === 'cooling' ? `cache cools in ${Math.max(1, c.ttl - minutes(idle ?? 0))} min` : undefined)

  // The band above the prompt is not drawn on every surface (a phone has none), so say it once as a toast.
  if (p === 'cold' && toks !== null && idle !== null && !(await read($, isToldCold))) {
    await update($, isToldCold, () => true)
    const { cold, warm } = costs(toks, { ttlMinutes: c.ttl, pricePerMTok: c.price })
    $.ui.toast(`Cache went cold (idle ${minutes(idle)} min). Your next message re-reads ~${thousands(toks)} tokens: ${dollars(cold)} instead of ${dollars(warm)}. /keepwarm on to prevent it.`, { timeoutMs: 15_000 })
  }

  if (!(await read($, isKeepWarm)) || last === null || idle === null || idle < pingEveryMs(c.ttl)) return
  const sent = await read($, pings)
  if (sent >= c.maxPings) {
    await update($, isKeepWarm, () => false)
    $.ui.toast(`Keep-warm stopped after ${sent} pings; the cache will go cold.`)
    return
  }
  const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
  if (!r.isAnswered) {
    await update($, isKeepWarm, () => false)
    $.ui.toast(`Keep-warm stopped: ${r.reason}.`)
    return
  }
  await update($, pings, n => n + 1)
  await update($, lastUsedAt, () => t)
}

export const register: Register = (on, options) => {
  const ttl = numberOr(options.cacheTtlMinutes, 60)
  const price = numberOr(options.inputPricePerMTok, 3)
  const maxPings = numberOr(options.maxKeepWarmPings, 6)
  const config = { ttlMinutes: ttl, pricePerMTok: price }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'keepwarm', description: 'Keep the prompt cache warm while you are away: /keepwarm [on|off]' })
    } catch {
      // A mode with no session bound cannot register a command; the command still answers, and the rest of start-up must still run.
    }
    $.clock.every(TICK_MS, () => void tick($, { ttl, maxPings, price }))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, pings, () => 0)
    await update($, isDismissed, () => false)
    await update($, isToldCold, () => false)
    $.ui.status(undefined)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const usage = await $.session.usage()
    const t = await $.clock.now()
    await update($, lastUsedAt, () => t)
    await update($, now, () => t)
    await update($, isToldCold, () => false)
    await update($, tokens, () => usage.context.tokens ?? null)

    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'status') {
      const last = await read($, lastUsedAt)
      const idleMs = last === null ? null : Math.max(0, (await $.clock.now()) - last)
      return { text: statusText({ idleMs, tokens: await read($, tokens), ttl, price, isKeepWarm: await read($, isKeepWarm), pings: await read($, pings), maxPings }) }
    }
    const was = await read($, isKeepWarm)
    const wants = arg === 'on' ? true : arg === 'off' ? false : !was
    await update($, isKeepWarm, () => wants)
    await update($, pings, () => 0)
    if (!wants) return { text: 'Keep-warm is off. The cache will go cold after ' + ttl + ' minutes without a request.' }
    const toks = await read($, tokens)
    const per = toks === null ? null : costs(toks, config).warm
    const every = Math.round(pingEveryMs(ttl) / 60_000)
    return {
      text:
        `Keep-warm is on: while you are away it sends a one-word request every ${every} minutes (at most ${maxPings} in a row)` +
        (per === null ? '.' : `, about ${dollars(per)} each at the current context size.`),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking || (await read($, isDismissed))) return next(e)
    const last = await read($, lastUsedAt)
    const toks = await read($, tokens)
    const t = await read($, now)
    const idle = last === null ? null : Math.max(0, t - last)
    if (phase(idle, toks, ttl) !== 'cold' || toks === null || idle === null) return next(e)

    const { cold, warm } = costs(toks, config)
    const keep = await read($, isKeepWarm)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>Cache is cold</Text>
          <Text dimColor> (idle {minutes(idle)} min). </Text>
          Your next message re-reads about {thousands(toks)} tokens: {dollars(cold)} instead of {dollars(warm)}.
        </Text>
        <Box>
          {!keep && (
            <Button
              key="warm"
              label="Keep warm from now on"
              variant="primary"
              hotkey="k"
              onPress={() => update($, isKeepWarm, () => true)}
            />
          )}
          {keep && <Text dimColor>Keep-warm is on, but this cache has already lapsed.</Text>}
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" role="dismiss" hotkey="d" onPress={() => update($, isDismissed, () => true)} />
        </Box>
      </Box>
    )
  })
}
