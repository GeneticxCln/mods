export type Audit = {
  title: string
  links: number
  images: number
  /** Images with no alt text at all. */
  noAlt: number
  h1: number
  forms: number
  hasLang: boolean
  hasViewport: boolean
}

export type Page = {
  /** Where it came from: an http(s) URL or an absolute file path. */
  url: string
  status: number
  contentType: string
  bytes: number
  /** How the body is drawn. */
  kind: 'markdown' | 'diff' | 'text'
  body: string
  isCut: boolean
  /** Only for HTML. */
  audit: Audit | null
}

declare module 'claude-code' {
  interface PluginState {
    'terminal-browser': {
      page: Page | null
      /** What the address bar holds. */
      address: string
      history: string[]
      /** Index into `history` of the page shown. */
      at: number
      /** How far into the page `/browse more` has read, for a surface with no pane to scroll. */
      offset: number
      isLoading: boolean
      error: string | null
    }
  }
}
