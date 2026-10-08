/** A design system, reduced to what the transcript draws with. Colours are theme keys, names or hex. */
export type Tokens = {
  name: string
  accent: string
  user: string
  assistant: string
  tool: string
  dim: string
  ok: string
  error: string
  /** Added and removed lines of an edit. */
  add: string
  del: string
  userBullet: string
  assistantBullet: string
  toolBullet: string
}

declare module 'claude-code' {
  interface PluginState {
    'transcript-skins': {
      /** The skin in force; null leaves the transcript to Claude Code. */
      skin: Tokens | null
    }
  }
}
