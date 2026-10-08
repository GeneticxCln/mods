import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { devServer, findings, kb, resolveHref, target, toPage } from './page'

const PANE = 'terminal-browser'
const HISTORY_MAX = 50

const page = atom({ plugin: 'terminal-browser', key: 'page' } as const, null)
const address = atom({ plugin: 'terminal-browser', key: 'address' } as const, '')
const history = atom({ plugin: 'terminal-browser', key: 'history' } as const, [])
const at = atom({ plugin: 'terminal-browser', key: 'at' } as const, -1)
const isLoading = atom({ plugin: 'terminal-browser', key: 'isLoading' } as const, false)
const error = atom({ plugin: 'terminal-browser', key: 'error' } as const, null)

/** Fetch or read `input`, show it, and (unless going back or forward) add it to the history. */
async function go($: EngineInterface, input: string, record: boolean): Promise<void> {
  const cwd = await $.session.cwd()
  const to = target(input, cwd)
  await update($, address, () => input.trim())
  if (to.kind === 'refused') {
    await update($, error, () => to.reason)
    return
  }
  await update($, isLoading, () => true)
  await update($, error, () => null)
  try {
    const where = to.kind === 'http' ? to.url : to.path
    if (to.kind === 'http') {
      const r = await $.http.fetch(to.url)
      await update($, page, () => toPage(to.url, r.status, r.headers['content-type'] ?? '', r.text))
    } else {
      const text = (await $.fs.read(to.path)) as string
      const type = /\.html?$/i.test(to.path) ? 'text/html' : /\.md$/i.test(to.path) ? 'text/markdown' : ''
      await update($, page, () => toPage(to.path, 200, type, text))
    }
    await update($, address, () => where)
    if (record) {
      const i = await read($, at)
      await update($, history, h => [...h.slice(0, i + 1), where].slice(-HISTORY_MAX))
      await update($, at, () => Math.min(i + 1, HISTORY_MAX - 1))
    }
  } catch (e) {
    await update($, error, () => `Could not load ${input.trim()}: ${String(e)}`)
  } finally {
    await update($, isLoading, () => false)
  }
}

async function step($: EngineInterface, by: number): Promise<void> {
  const h = await read($, history)
  const i = (await read($, at)) + by
  if (i < 0 || i >= h.length) return
  await update($, at, () => i)
  await go($, h[i]!, false)
}

export const register: Register = on => {
  const seen = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'browse', description: 'Open a page beside the conversation as text: /browse <url | file | PR .diff url>' })

    return next(e)
  })

  on('command.run', { command: 'browse' }, async ($, e) => {
    const input = e.args.trim()
    await $.ui.open({ id: PANE, title: 'Browser' })
    if (input !== '') await go($, input, true)

    return { text: input === '' ? 'Browser opened. Type an address in the bar.' : `Browsing ${input}.` }
  })

  // A dev server announcing itself is the moment you would want to look at it: say how, once per address.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const url = typeof ran.text === 'string' ? devServer(ran.text) : null
    if (url !== null && !seen.has(url)) {
      seen.add(url)
      $.ui.toast(`Server at ${url}: /browse ${url} to look at it`, { timeoutMs: 8000 })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      // The mobile app has no text field to type an address into.
      const { Text } = $.ui.resolve(e)
      return <Text>Use /browse &lt;url&gt; to open a page; the address bar needs the terminal or desktop app.</Text>
    }
    const { Box, Button, Code, Input, Markdown, Text } = $.ui.resolve(e)
    const p = await read($, page)
    const addr = await read($, address)
    const err = await read($, error)
    const busy = await read($, isLoading)
    const trail = await read($, history)
    const i = await read($, at)
    const notes = p?.audit == null ? [] : findings(p.audit)

    return (
      <Box flexDirection="column">
        <Input key="url" label="Go" value={addr} placeholder="https://… or ./index.html" onSubmit={value => go($, value, true)} />
        <Box>
          <Button key="back" label="Back" hotkey="b" onPress={() => step($, -1)} />
          <Text> </Text>
          <Button key="forward" label="Forward" hotkey="f" onPress={() => step($, 1)} />
          <Text> </Text>
          <Button key="reload" label="Reload" hotkey="r" onPress={() => go($, addr, false)} />
          <Text dimColor>
            {' '}
            {trail.length > 0 ? `${i + 1}/${trail.length}` : ''}
          </Text>
        </Box>
        {busy && <Text dimColor>Loading…</Text>}
        {err !== null && <Text color="red">{err}</Text>}
        {p !== null && (
          <Text dimColor>
            {p.status} · {kb(p.bytes)} · {p.contentType.split(';')[0] || 'unknown type'}
            {p.audit === null ? '' : ` · "${p.audit.title || 'untitled'}" · ${p.audit.links} links · ${p.audit.images} images · ${p.audit.forms} forms`}
          </Text>
        )}
        {notes.length > 0 && <Text color="yellow">Audit: {notes.join('; ')}</Text>}
        {p !== null && p.kind === 'markdown' && (
          <Markdown
            key="page"
            text={p.body}
            onLinkPress={link => {
              const to = resolveHref(p.url, link.href)
              if (to !== null) void go($, to, true)
            }}
          />
        )}
        {p !== null && p.kind === 'diff' && <Code source={p.body} language="diff" />}
        {p !== null && p.kind === 'text' && <Code source={p.body} />}
        {p?.isCut === true && <Text dimColor>Shown up to the first 60,000 characters.</Text>}
        {p === null && err === null && !busy && <Text dimColor>Nothing open. Type an address above, or /browse &lt;url&gt;.</Text>}
      </Box>
    )
  })
}
