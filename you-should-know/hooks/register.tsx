import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Alert } from '../types'
import { MODEL_PROMPT, fromModel, merge, scan } from './alerts'

const alerts = atom({ plugin: 'you-should-know', key: 'alerts' } as const, [])

/** Only an answer this long is worth a model's time; shorter ones the patterns read well enough. */
const MODEL_MIN = 1200
/** Tool output is scanned up to this much per turn, newest first. */
const OUTPUT_BUDGET = 40_000

export const register: Register = (on, options) => {
  let outputSeen = 0

  on('turn.start', async ($, e, next) => {
    outputSeen = 0
    await update($, alerts, () => [])

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash' && typeof ran.text === 'string' && outputSeen < OUTPUT_BUDGET) {
      const text = ran.text.slice(-(OUTPUT_BUDGET - outputSeen))
      outputSeen += text.length
      const found = scan(text, 'output')
      if (found.length > 0) await update($, alerts, list => merge(list, found))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const found = scan(e.answer, 'answer')
    if (found.length > 0) await update($, alerts, list => merge(list, found))

    const high = found.find(a => a.severity === 'high')
    if (high !== undefined) $.ui.toast(`${high.title}: ${high.quote}`.slice(0, 160), { timeoutMs: 10_000 })

    if (options.scanWithModel === true && e.answer.length >= MODEL_MIN) {
      // In the background: the turn is over, and the banner updates when the model has read it.
      void (async () => {
        const r = await $.model.complete({ model: 'haiku', prompt: MODEL_PROMPT(e.answer), maxTokens: 400, effort: 'low' })
        if (r.isAnswered) {
          const more = fromModel(r.text)
          if (more.length > 0) await update($, alerts, list => merge(list, more))
        }
      })().catch(() => undefined)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, alerts)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = list.slice(0, 3)
    const hidden = list.length - shown.length

    return (
      <Box flexDirection="column">
        <Text bold>You should know</Text>
        {shown.map((a: Alert) => (
          <Text key={a.id} color={a.severity === 'high' ? 'red' : 'yellow'}>
            {a.severity === 'high' ? '! ' : '- '}
            {a.title}: <Text dimColor>{a.quote}</Text>
          </Text>
        ))}
        {hidden > 0 && <Text dimColor>and {hidden} more</Text>}
        <Box>
          <Button key="dismiss" label="Dismiss" role="dismiss" hotkey="d" onPress={() => update($, alerts, () => [])} />
        </Box>
      </Box>
    )
  })
}
