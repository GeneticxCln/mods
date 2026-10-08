export type Todos = { done: number; total: number; current: string | null }

export type AgentRow = { id: string; label: string; status: string }

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      /** When the running turn began, in clock milliseconds; null while idle. */
      startedAt: number | null
      /** The clock at the last tick, so elapsed time and the animation redraw. */
      now: number
      frame: number
      todos: Todos | null
      /** Dollars the session had cost when the turn began. */
      costStart: number | null
      /** Dollars the session has cost now. */
      cost: number | null
      /** Tokens in the context window now. */
      tokens: number | null
      agents: AgentRow[]
      /** What the last turn came to, shown until the next prompt. */
      summary: string | null
      isHidden: boolean
    }
  }
}
