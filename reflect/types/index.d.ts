export type Rule = {
  /** The rule as it would be written into CLAUDE.md: one sentence. */
  text: string
  /** What the person said, for the banner to quote. */
  said: string
}

declare module 'claude-code' {
  interface PluginState {
    reflect: {
      /** The correction waiting for a yes or a no; null when nothing is offered. */
      pending: Rule | null
      /** The line the band shows after a click ("Saved to CLAUDE.md"), cleared by the next prompt. */
      notice: string | null
    }
  }
}
