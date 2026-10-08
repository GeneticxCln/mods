export type Severity = 'high' | 'medium'

export type Alert = {
  /** Stable per kind and quote, so the same finding is never shown twice. */
  id: string
  severity: Severity
  /** "Breaking change", "Data loss", ... */
  title: string
  /** The sentence that triggered it, cut short. */
  quote: string
  source: 'answer' | 'output' | 'model'
}

declare module 'claude-code' {
  interface PluginState {
    'you-should-know': {
      /** What the last turn turned up, most severe first. */
      alerts: Alert[]
    }
  }
}
