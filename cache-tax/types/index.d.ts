/** Where the cache stands, as the band and the status line read it. */
export type Phase = 'unknown' | 'warm' | 'cooling' | 'cold'

declare module 'claude-code' {
  interface PluginState {
    'cache-tax': {
      /** When the cache was last used (a turn ended or a keep-warm ping answered), in clock milliseconds. */
      lastUsedAt: number | null
      /** Tokens the last response was answered over: what a cold cache would have to re-read. */
      tokens: number | null
      /** The clock as of the last tick, so the band redraws as idle time grows. */
      now: number
      isKeepWarm: boolean
      /** Keep-warm pings sent since the person last wrote. */
      pings: number
      isDismissed: boolean
      /** The person has been told this stretch of idleness went cold, so the toast is said once. */
      isToldCold: boolean
    }
  }
}
