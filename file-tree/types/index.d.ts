export type Entry = { name: string; kind: 'dir' | 'file' }

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      /** The session's working directory the tree is rooted at; null until first opened. */
      root: string | null
      /** Directory path (relative to root, '' for the root) -> its entries, loaded when first opened. */
      children: Record<string, Entry[]>
      /** Directories shown open. */
      expanded: string[]
      /** File path (relative) -> clock time Claude last touched it. */
      active: Record<string, number>
      /** File path (relative) -> its `git status` code (M, A, D, ?). */
      status: Record<string, string>
      /** Files committed since the session began (relative paths). */
      committed: string[]
      /** HEAD when the session began; what "committed this session" is measured from. */
      base: string | null
      now: number
      frame: number
      /** The row last pressed; its path was copied. */
      selected: string | null
    }
  }
}
