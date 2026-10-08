export type Step = {
  /** Position in the run, from 1. */
  n: number
  tool: string
  /** One line: "Edit src/a.ts", "$ npm test". */
  title: string
  /** The file the step changed, for Edit and Write. */
  file?: string
  /** A unified diff to draw, for an edit. */
  diff?: string
  /** Output or content to show under the title, cut short. */
  detail?: string
  isError: boolean
  /** The subagent that made the call; absent on the main loop. */
  agentId?: string
}

export type Run = {
  id: string
  /** What the person asked, cut short. */
  prompt: string
  steps: Step[]
  isDone: boolean
  seconds: number | null
}

export type Position = { run: number; step: number }

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      /** The last few turns that did anything, oldest first. */
      runs: Run[]
      /** Which run and step the pane is showing. */
      pos: Position
    }
  }
}
