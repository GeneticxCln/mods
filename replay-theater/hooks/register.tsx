import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Position, Run } from '../types'
import { MAX_RUNS, MAX_STEPS, clamp, filesTouched, isWorthReplaying, replayText, stepOf, stepText, withOutcome } from './steps'

const PANE = 'replay-theater'

const runs = atom({ plugin: 'replay-theater', key: 'runs' } as const, [])
const pos = atom({ plugin: 'replay-theater', key: 'pos' } as const, { run: 0, step: 0 })

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export const register: Register = on => {
  let startedAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'replay', description: 'Walk through the steps of the last task, one at a time' })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    startedAt = await $.clock.now()
    const run: Run = { id: e.turnId, prompt: cut(e.text.replace(/\s+/g, ' ').trim(), 80), steps: [], isDone: false, seconds: null }
    await update($, runs, list => [...list, run].slice(-MAX_RUNS))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The call's own arguments are on `e`; record the step before it runs so a hang still shows.
    const input: unknown = e
    const index = { value: -1 }
    await update($, runs, list => {
      const last = list[list.length - 1]
      if (last === undefined || last.isDone || last.steps.length >= MAX_STEPS) return list
      index.value = last.steps.length
      const step = stepOf(last.steps.length + 1, e.tool, input, e.agentId)
      return [...list.slice(0, -1), { ...last, steps: [...last.steps, step] }]
    })

    const ran = await next(e)

    if (index.value >= 0) {
      const isError = ran.deny !== undefined || ran.isError === true
      const text = ran.deny ?? ran.text
      await update($, runs, list => {
        const last = list[list.length - 1]
        const step = last?.steps[index.value]
        if (last === undefined || step === undefined) return list
        const steps = last.steps.map((s, i) => (i === index.value ? withOutcome(s, text, isError) : s))
        return [...list.slice(0, -1), { ...last, steps }]
      })
    }

    return ran
  }).catch(($, e, next) => next(e)) // recording is not worth stopping a tool call for

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    let worth = 0
    await update($, runs, list => {
      const last = list[list.length - 1]
      if (last === undefined) return list
      if (!isWorthReplaying(last.steps)) return list.slice(0, -1)
      worth = last.steps.length
      return [...list.slice(0, -1), { ...last, isDone: true, seconds }]
    })
    if (worth > 0) {
      await update($, pos, () => ({ run: -1, step: 0 }))
      $.ui.toast(`Replay ready: /replay walks through ${worth} step${worth === 1 ? '' : 's'}`)
    }

    return next(e)
  })

  on('command.run', { command: 'replay' }, async ($, e) => {
    const list = await read($, runs)
    const run = list[list.length - 1]
    if (run === undefined) return { text: 'Nothing to replay yet. Ask Claude to do something first.' }
    const arg = e.args.trim()
    // `/replay 3`: one step in full, in words, for a surface with no pane.
    if (/^\d+$/.test(arg)) {
      const step = run.steps[Number(arg) - 1]
      return { text: step === undefined ? `No step ${arg}. This task has ${run.steps.length}.` : stepText(step) }
    }
    await update($, pos, () => ({ run: -1, step: 0 }))
    try {
      await $.ui.open({ id: PANE, title: 'Replay' })
    } catch {
      // A surface that cannot hold a pane still gets the text below.
    }

    return { text: replayText(run) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const where: Position = await read($, pos)
    const runIndex = clamp(where.run < 0 ? list.length - 1 : where.run, 0, Math.max(0, list.length - 1))
    const run = list[runIndex]

    if (run === undefined || run.steps.length === 0) return <Text dimColor>Nothing to replay yet.</Text>

    const at = clamp(where.step, 0, run.steps.length - 1)
    const step = run.steps[at]!
    const go = (to: number) => update($, pos, () => ({ run: runIndex, step: clamp(to, 0, run.steps.length - 1) }))
    const goRun = (to: number) => update($, pos, () => ({ run: clamp(to, 0, list.length - 1), step: 0 }))
    const files = filesTouched(run.steps)

    return (
      <Box flexDirection="column">
        <Text bold>{run.prompt || 'Task'}</Text>
        <Text dimColor>
          Step {at + 1} of {run.steps.length}
          {run.seconds === null ? '' : ` · ${run.seconds}s`}
          {files.size === 0 ? '' : ` · ${files.size} file${files.size === 1 ? '' : 's'} changed`}
          {list.length > 1 ? ` · task ${runIndex + 1} of ${list.length}` : ''}
        </Text>
        <Text bold color={step.isError ? 'red' : undefined}>
          {step.isError ? 'failed: ' : ''}
          {step.title}
          {step.agentId === undefined ? '' : ` (agent ${step.agentId.slice(0, 6)})`}
        </Text>
        {step.diff !== undefined && <Code source={step.diff} format="diff" />}
        {step.detail !== undefined && <Text dimColor>{step.detail}</Text>}
        <Box>
          <Button key="first" label="First" hotkey="f" onPress={() => go(0)} />
          <Text> </Text>
          <Button key="prev" label="Prev" hotkey="p" onPress={() => go(at - 1)} />
          <Text> </Text>
          <Button key="next" label="Next" variant="primary" hotkey="n" onPress={() => go(at + 1)} />
          <Text> </Text>
          <Button key="last" label="Last" hotkey="l" onPress={() => go(run.steps.length - 1)} />
        </Box>
        {list.length > 1 && (
          <Box>
            <Button key="older" label="Older task" hotkey="o" onPress={() => goRun(runIndex - 1)} />
            <Text> </Text>
            <Button key="newer" label="Newer task" hotkey="w" onPress={() => goRun(runIndex + 1)} />
          </Box>
        )}
        {files.size > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Files changed:</Text>
            {[...files].map(([file, count]) => (
              <Text key={file}>
                {file}
                {count > 1 ? ` ×${count}` : ''}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
