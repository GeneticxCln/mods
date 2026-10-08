import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Rule } from '../types'
import { addRule, detect } from './feedback'

const pending = atom({ plugin: 'reflect', key: 'pending' } as const, null)
const notice = atom({ plugin: 'reflect', key: 'notice' } as const, null)

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    // A new prompt ends whatever the band was showing; a correction in it starts a new offer.
    await update($, notice, () => null)
    const found = detect(e.text)
    await update($, pending, () => found)

    return next(e)
  }).catch(($, e, next) => next(e)) // a bug here must never swallow the person's prompt

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

    const save = async (rule: Rule) => {
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

    return (
      <Box flexDirection="column">
        <Text dimColor>Reflect: save this as a rule for the project?</Text>
        <Text>{offer.text}</Text>
        <Box>
          <Button key="save" label="Save to CLAUDE.md" variant="primary" hotkey="s" onPress={() => save(offer)} />
          <Text> </Text>
          <Button key="dismiss" label="Dismiss" role="dismiss" hotkey="d" onPress={() => update($, pending, () => null)} />
        </Box>
      </Box>
    )
  })
}
