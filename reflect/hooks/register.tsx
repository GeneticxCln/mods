import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Rule } from '../types'
import { addRule, detect } from './feedback'

const pending = atom({ plugin: 'reflect', key: 'pending' } as const, null)
const notice = atom({ plugin: 'reflect', key: 'notice' } as const, null)

/** Write the rule into CLAUDE.md in the session directory and say what happened. The band's button and /reflect save both use it. */
async function saveRule($: EngineInterface, rule: Rule): Promise<void> {
  const path = `${await $.session.cwd()}/CLAUDE.md`
  try {
    const existing = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
    const updated = addRule(existing, rule.text)
    if (updated === null) {
      await update($, notice, () => 'Already in CLAUDE.md.')
    } else {
      await $.fs.write(path, updated)
      await update($, notice, () => `Saved to CLAUDE.md: ${rule.text}`)
    }
  } catch (error) {
    await update($, notice, () => `Could not write CLAUDE.md: ${String(error)}`)
  }
  await update($, pending, () => null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'reflect', description: 'Save the correction Reflect noticed as a rule: /reflect [save|dismiss]' })
    } catch {
      // A mode with no session bound cannot register a command; the command still answers, and the rest of start-up must still run.
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A slash command is not a correction, and must not wipe the offer it is about to answer.
    if (e.text.trimStart().startsWith('/')) return next(e)
    // A new prompt ends whatever the band was showing; a correction in it starts a new offer.
    await update($, notice, () => null)
    const found = detect(e.text)
    await update($, pending, () => found)
    // The band above the prompt is not drawn on every surface (a phone has none), so say it as a toast too.
    if (found !== null) $.ui.toast(`Reflect: save "${found.text}" as a rule? Type /reflect save`, { timeoutMs: 15_000 })

    return next(e)
  }).catch(($, e, next) => next(e)) // a bug here must never swallow the person's prompt

  on('command.run', { command: 'reflect' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const offer = await read($, pending)
    if (arg === 'dismiss') {
      await update($, pending, () => null)
      return { text: offer === null ? 'Nothing was waiting.' : 'Dropped. Nothing was written.' }
    }
    if (arg === 'save') {
      if (offer === null) return { text: 'Nothing to save. Reflect offers a rule when you correct Claude.' }
      await saveRule($, offer)
      return { text: (await read($, notice)) ?? 'Saved.' }
    }
    if (offer !== null) return { text: `Rule waiting: "${offer.text}"\n/reflect save writes it to CLAUDE.md. /reflect dismiss drops it.` }

    return { text: (await read($, notice)) ?? 'No correction waiting. Reflect offers a rule when you correct Claude.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const offer = await read($, pending)
    const note = await read($, notice)
    if (e.props.hasSurvey || (offer === null && note === null)) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    if (offer === null) {
      return (
        <Box>
          <Text dimColor>{note}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>Reflect: save this as a rule for the project?</Text>
        <Text>{offer.text}</Text>
        <Box>
          <Button key="save" label="Save to CLAUDE.md" variant="primary" hotkey="s" onPress={() => saveRule($, offer)} />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" role="dismiss" hotkey="d" onPress={() => update($, pending, () => null)} />
        </Box>
      </Box>
    )
  })
}
