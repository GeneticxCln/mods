import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { CHUNK, audit, decode, devServer, findings, htmlToMarkdown, kb, looksLikeDiff, pageText, resolveHref, target, toPage } from './hooks/page'

// ── pure ─────────────────────────────────────────────────────────────────────

test('an address is a web page, a file, or refused', () => {
  expect(target('https://example.com/a', '/w')).toEqual({ kind: 'http', url: 'https://example.com/a' })
  expect(target('example.com', '/w')).toEqual({ kind: 'http', url: 'https://example.com' })
  expect(target('localhost:3000', '/w')).toEqual({ kind: 'http', url: 'http://localhost:3000' })
  expect(target('127.0.0.1:8080/x', '/w')).toEqual({ kind: 'http', url: 'http://127.0.0.1:8080/x' })
  expect(target('/tmp/a.html', '/w')).toEqual({ kind: 'file', path: '/tmp/a.html' })
  expect(target('./out/index.html', '/w')).toEqual({ kind: 'file', path: '/w/out/index.html' })
  expect(target('README.md', '/w/')).toEqual({ kind: 'file', path: '/w/README.md' })
  expect(target('file:///tmp/a%20b.html', '/w')).toEqual({ kind: 'file', path: '/tmp/a b.html' })
  expect(target('', '/w').kind).toBe('refused')
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://host/x', 'chrome://settings']) {
    expect(target(bad, '/w').kind).toBe('refused')
  }
})

test('entities are decoded, and a bad numeric one is left as written', () => {
  expect(decode('a &amp; b &lt;c&gt; &#65;&#x42; &hellip;')).toBe('a & b <c> AB …')
  expect(decode('&#0; &#99999999999; &unknown;')).toBe('&#0; &#99999999999; &unknown;')
})

test('links resolve against the page and only web or file links survive', () => {
  expect(resolveHref('https://a.test/x/y.html', '../z')).toBe('https://a.test/z')
  expect(resolveHref('https://a.test/', '/abs')).toBe('https://a.test/abs')
  expect(resolveHref('https://a.test/', 'https://b.test/')).toBe('https://b.test/')
  expect(resolveHref('/w/index.html', 'about.html')).toBe('file:///w/about.html')
  expect(resolveHref('https://a.test/', 'javascript:alert(1)')).toBeNull()
  expect(resolveHref('https://a.test/', 'mailto:x@y.z')).toBeNull()
})

const HTML = `<!doctype html><html lang="en"><head><title>Demo &amp; Co</title><meta name="viewport" content="width=device-width">
<style>body{color:red}</style><script>alert('x')</script></head>
<body><h1>Welcome</h1><p>Hello <a href="/docs">the docs</a> and <a href="https://x.test/">x</a>.</p>
<ul><li>one</li><li>two</li></ul><img src="a.png" alt="A logo"><img src="b.png"><img src="c.png" alt="">
<pre>let a = 1;\nlet b = 2;</pre><form><input name="q" placeholder="Search"><button>Go</button></form>
<!-- hidden --><script>document.write('late')</script></body></html>`

test('a page becomes markdown: headings, links made absolute, lists, code, images, fields; scripts and styles gone', () => {
  const md = htmlToMarkdown(HTML, 'https://site.test/index.html')
  expect(md).toContain('# Welcome')
  expect(md).toContain('[the docs](https://site.test/docs)')
  expect(md).toContain('[x](https://x.test/)')
  expect(md).toContain('- one')
  expect(md).toContain('- two')
  expect(md).toContain('```\nlet a = 1;')
  expect(md).toContain('[image: A logo]')
  expect(md).toContain('[image, no alt text]')
  expect(md).toContain('[input: Search]')
  expect(md).toContain('[button: button]')
  expect(md).not.toMatch(/alert|document\.write|color:red|hidden|<h1>/)
})

test('a link that goes nowhere safe loses its target and keeps its words', () => {
  expect(htmlToMarkdown('<a href="javascript:evil()">click</a>', 'https://s.test/')).toBe('click')
})

test('the audit counts what matters and the findings list what is wrong, worst first', () => {
  const a = audit(HTML)
  expect(a).toEqual({ title: 'Demo & Co', links: 2, images: 3, noAlt: 1, h1: 1, forms: 1, hasLang: true, hasViewport: true })
  expect(findings(a)).toEqual(['1 of 3 images with no alt text'])
  const bare = audit('<html><body><p>hi</p><img src=x></body></html>')
  expect(findings(bare)).toEqual(['1 of 1 image with no alt text', 'no h1', 'no lang on <html>', 'no viewport meta', 'no title'])
  expect(findings(audit('<h1>a</h1><h1>b</h1>'))).toContain('2 h1 headings')
})

test('a diff is recognised by its address, its type or its first lines; a body is cut at 60,000 characters', () => {
  expect(looksLikeDiff('x', '', 'https://github.com/o/r/pull/1.diff')).toBe(true)
  expect(looksLikeDiff('x', 'text/x-diff', 'https://a/b')).toBe(true)
  expect(looksLikeDiff('diff --git a/a b/a\n--- a/a', 'text/plain', 'https://a/b')).toBe(true)
  expect(looksLikeDiff('plain text', 'text/plain', 'https://a/b')).toBe(false)
  const big = toPage('https://a/b.txt', 200, 'text/plain', 'x'.repeat(70_000))
  expect(big.isCut).toBe(true)
  expect(big.body.length).toBe(60_000)
  expect(toPage('https://a/b', 200, 'text/html', HTML).kind).toBe('markdown')
  expect(toPage('https://a/b', 200, '', '<!doctype html><p>hi</p>').kind).toBe('markdown')
  expect(toPage('https://a/p.diff', 200, 'text/plain', 'diff --git a b').kind).toBe('diff')
  expect(toPage('/w/README.md', 200, 'text/markdown', '# hi').audit).toBeNull()
  expect(kb(512)).toBe('512 B')
  expect(kb(2048)).toBe('2.0 KB')
})

test('a dev server is found in a command\'s output, with 0.0.0.0 turned into something you can open', () => {
  expect(devServer('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/')
  expect(devServer('Listening on http://0.0.0.0:8000.')).toBe('http://localhost:8000')
  expect(devServer('see https://example.com/docs')).toBeNull()
})

// ── the hooks, over the engine ───────────────────────────────────────────────

const PANE = {
  component: 'Pane',
  requestId: 'terminal-browser',
  props: { title: 'Browser', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SESSION = { cwd: '/w', surface: 'terminal', isInteractive: true } as const
const RUN = (args: string) => ({ command: 'browse', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

const web: Record<string, { status?: number; type?: string; text: string }> = {
  'https://site.test/': { type: 'text/html', text: HTML },
  'https://site.test/docs': { type: 'text/html', text: '<html lang="en"><head><title>Docs</title></head><body><h1>Docs page</h1></body></html>' },
  'https://github.test/p/1.diff': { type: 'text/plain', text: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' },
}
const net = { fetched: [] as string[], toasts: [] as string[] }

function plumbing(on: On, canOpenPane = true) {
  net.fetched.length = 0
  net.toasts.length = 0
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'browse' } }))
  on('session.cwd', () => ({ value: '/w' }))
  on('ui.open', () => {
    if (!canOpenPane) throw new Error('this surface holds no panes')
    return { value: { isPlaced: true } }
  })
  on('http.fetch', (_$, e) => {
    net.fetched.push(e.url)
    const r = web[e.url]
    if (r === undefined) throw new Error(`no route to ${e.url}`)
    return { value: { status: r.status ?? 200, ok: true, headers: { 'content-type': r.type ?? 'text/plain' }, text: r.text } }
  })
  on('fs.read', (_$, e) => {
    if (e.path === '/w/out/index.html') return { value: '<html><body><h1>Local build</h1></body></html>' }
    throw new Error('ENOENT')
  })
  on('ui.toast', (_$, e) => {
    net.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', (_$, e) => ({ result: {}, text: (e as unknown as { command?: string }).command ?? '' }))
}

test('/browse opens the pane, fetches the page and draws it as markdown with an audit line', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  expect((await $.command.run(RUN('https://site.test/'))).text).toContain('# Welcome')
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  const md = await ui.find({ type: 'Markdown' })
  expect(md?.text).toContain('# Welcome')
  expect(md?.text).toContain('[the docs](https://site.test/docs)')
  expect(await ui.find({ type: 'Text', text: /200 · \d+ B · text\/html · "Demo & Co" · 2 links · 3 images · 1 forms/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Audit: 1 of 3 images with no alt text/ })).toBeDefined()
  await ui.unmount()
})

test('pressing a link in the page follows it; Back returns, Forward goes on again', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('https://site.test/'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  await ui.press({ key: 'page', link: { href: '/docs' } })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Docs page')
  expect(net.fetched).toEqual(['https://site.test/', 'https://site.test/docs'])
  await ui.press({ key: 'back' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Welcome')
  await ui.press({ key: 'forward' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Docs page')
  await ui.press({ key: 'forward' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Docs page')
  await ui.unmount()
})

test('typing a new address goes there, and a new page after Back drops the pages that were ahead', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('https://site.test/'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  await ui.press({ key: 'page', link: { href: '/docs' } })
  await ui.press({ key: 'back' })
  await ui.input({ key: 'url', text: 'https://github.test/p/1.diff' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  // The page B that was ahead of A is gone: the trail is A then the diff, and Forward has nowhere to go.
  expect(await ui.find({ type: 'Text', text: ' 2/2' })).toBeDefined()
  await ui.press({ key: 'forward' })
  expect(await ui.find({ type: 'Text', text: ' 2/2' })).toBeDefined()
  expect((await ui.find({ type: 'Code' }))?.text).toContain('+new')
  await ui.unmount()
})

test('a pull request diff is drawn as a diff, not as a page', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('https://github.test/p/1.diff'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  const code = await ui.find({ type: 'Code' })
  expect(code?.props.language).toBe('diff')
  expect(code?.text).toContain('-old')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('a local file is read from the workspace, not fetched', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('./out/index.html'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Local build')
  expect(net.fetched).toEqual([])
  await ui.unmount()
})

test('addresses that are not web pages or files are refused without a request', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('javascript:alert(1)'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /javascript: addresses are not opened here/ })).toBeDefined()
  expect(net.fetched).toEqual([])
  await ui.unmount()
})

test('a page that cannot be reached says so and keeps the last good page', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.command.run(RUN('https://site.test/'))
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'terminal', ...PANE })
  await ui.input({ key: 'url', text: 'https://down.test/' })
  expect(await ui.find({ type: 'Text', text: /Could not load https:\/\/down\.test\//, })).toBeDefined()
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('# Welcome')
  await ui.unmount()
})

test('a dev server in a command\'s output is announced once, with the command to open it', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u1', command: 'Local: http://localhost:5173/' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u2', command: 'Local: http://localhost:5173/' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'u3', command: 'ls' })
  expect(net.toasts).toEqual(['Server at http://localhost:5173/: /browse http://localhost:5173/ to look at it'])
})

test('the mobile app is told where the address bar is', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  const ui = await $.ui.mount({ plugin: 'terminal-browser', surface: 'mobile', ...PANE })
  expect(await ui.find({ type: 'Text', text: /address bar needs the terminal or desktop app/ })).toBeDefined()
  await ui.unmount()
})

// ── without the pane (a phone draws none): the page as text ──────────────────

test('a page as text: its facts, its audit, then the body in stretches', () => {
  const page = toPage('https://a.test/', 200, 'text/html', HTML)
  const text = pageText(page)
  expect(text).toContain('200 · ')
  expect(text).toContain('"Demo & Co" · 2 links · 3 images · 1 forms')
  expect(text).toContain('Audit: 1 of 3 images with no alt text')
  expect(text).toContain('# Welcome')
  expect(text).not.toContain('/browse more')
  const long = toPage('https://a.test/x.txt', 200, 'text/plain', 'x'.repeat(CHUNK * 2 + 10))
  expect(pageText(long, 0)).toContain(`… ${CHUNK + 10} more characters. /browse more continues.`)
  expect(pageText(long, CHUNK * 2)).not.toContain('/browse more')
  expect(pageText(toPage('https://a/b.txt', 200, 'text/plain', 'x'.repeat(70_000)), 60_000 - 10)).toContain('first 60,000 characters')
})

test('/browse prints the page into the chat even where no pane can open, and /browse more reads on', async ($, on) => {
  plumbing(on, false)
  web['https://long.test/'] = { type: 'text/plain', text: `${'a'.repeat(CHUNK)}${'b'.repeat(100)}` }
  await $.session.start(SESSION)
  const first = (await $.command.run(RUN('https://long.test/'))).text ?? ''
  expect(first).toContain('a'.repeat(50))
  expect(first).not.toContain('bbbb')
  expect(first).toContain('… 100 more characters')
  const more = (await $.command.run(RUN('more'))).text ?? ''
  expect(more).toContain('b'.repeat(100))
  expect(more).not.toContain('a'.repeat(50))
  expect((await $.command.run(RUN('more'))).text).toBe('That is the end of the page.')
})

test('/browse with nothing open, /browse more with nothing open, and a failed load each say so', async ($, on) => {
  plumbing(on)
  await $.session.start(SESSION)
  expect((await $.command.run(RUN(''))).text).toBe('Nothing open. /browse <url | file>.')
  expect((await $.command.run(RUN('more'))).text).toBe('Nothing open. /browse <url | file>.')
  expect((await $.command.run(RUN('https://down.test/'))).text).toContain('Could not load https://down.test/')
  expect((await $.command.run(RUN('javascript:alert(1)'))).text).toContain('javascript: addresses are not opened here')
})
