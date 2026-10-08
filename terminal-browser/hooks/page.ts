/**
 * Turning an address, and what it answered, into something a terminal pane can show. Pure.
 *
 * This is a text-mode view: the page's structure (headings, links, lists, code, images' alt text) as
 * markdown, not its pixels. It does not run scripts, so a page that builds itself in the browser shows
 * what the server sent, which for a single-page app is usually little. That is also why it is safe to
 * point at a page you do not trust.
 */
import type { Audit, Page } from '../types'

export const MAX_BODY = 60_000

export type Target = { kind: 'http'; url: string } | { kind: 'file'; path: string } | { kind: 'refused'; reason: string }

/** What a person typed into the address bar, as somewhere to go. */
export function target(input: string, cwd: string): Target {
  const raw = input.trim()
  if (raw === '') return { kind: 'refused', reason: 'Type a URL or a file path.' }
  if (/^file:\/\//i.test(raw)) return { kind: 'file', path: decodeURIComponent(raw.replace(/^file:\/\//i, '')) }
  if (/^https?:\/\//i.test(raw)) return { kind: 'http', url: raw }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)
  if (scheme !== null && !/^(localhost|\d{1,3}(\.\d{1,3}){3})$/i.test(scheme[1]!) && !/^[a-z0-9.-]+:\d+/i.test(raw)) {
    return { kind: 'refused', reason: `${scheme[1]}: addresses are not opened here (only http, https and files).` }
  }
  if (raw.startsWith('/')) return { kind: 'file', path: raw }
  if (raw.startsWith('./') || raw.startsWith('../') || /\.(html?|md|diff|patch|txt)$/i.test(raw)) return { kind: 'file', path: `${cwd.replace(/\/$/, '')}/${raw.replace(/^\.\//, '')}` }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(raw)) return { kind: 'http', url: `http://${raw}` }
  return { kind: 'http', url: `https://${raw}` }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', rarr: '→', larr: '←' }

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  const v = m?.[1] ?? m?.[2] ?? m?.[3]
  return v === undefined ? undefined : decode(v)
}

/** Resolve `href` against `base`; anything that is not http(s) or a file is returned as null. */
export function resolveHref(base: string, href: string): string | null {
  try {
    const u = new URL(href, base.startsWith('/') ? `file://${base}` : base)
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.href : null
  } catch {
    return null
  }
}

export function audit(html: string): Audit {
  const count = (re: RegExp) => (html.match(re) ?? []).length
  const imgs = html.match(/<img\b[^>]*>/gi) ?? []
  return {
    title: decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()),
    links: count(/<a\b[^>]*\shref\s*=/gi),
    images: imgs.length,
    noAlt: imgs.filter(t => attr(t, 'alt') === undefined).length,
    h1: count(/<h1\b/gi),
    forms: count(/<form\b/gi),
    hasLang: /<html\b[^>]*\slang\s*=/i.test(html),
    hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html),
  }
}

/** The page's text and structure as markdown. */
export function htmlToMarkdown(html: string, base: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => `\n\n\`\`\`\n${decode(inner.replace(/<[^>]+>/g, ''))}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, a: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const href = attr(` ${a}`, 'href')
      const abs = href === undefined ? null : resolveHref(base, href)
      return abs === null ? text : `[${text || abs}](${abs})`
    })
    .replace(/<img\b([^>]*)>/gi, (_m, a: string) => {
      const alt = attr(` ${a}`, 'alt')
      return alt === undefined ? '[image, no alt text]' : alt === '' ? '' : `[image: ${alt}]`
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|header|footer|main|nav|ul|ol|table|tr|form|blockquote)>/gi, '\n\n')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<(input|button|select|textarea)\b([^>]*)>/gi, (_m, tag: string, a: string) => {
      const label = attr(` ${a}`, 'value') ?? attr(` ${a}`, 'placeholder') ?? attr(` ${a}`, 'name') ?? tag
      return `[${tag}: ${label}]`
    })
    .replace(/<[^>]+>/g, '')
  s = decode(s)
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return s
}

export const looksLikeDiff = (text: string, contentType: string, url: string): boolean =>
  /\.(diff|patch)(\?|$)/i.test(url) || /x-diff|x-patch/i.test(contentType) || /^diff --git /m.test(text.slice(0, 2000))

/** Build the page a response makes. */
export function toPage(url: string, status: number, contentType: string, text: string): Page {
  const bytes = new TextEncoder().encode(text).length
  const isHtml = /html/i.test(contentType) || (contentType === '' && /^\s*<(!doctype|html)/i.test(text))
  const cut = (s: string) => (s.length > MAX_BODY ? { body: s.slice(0, MAX_BODY), isCut: true } : { body: s, isCut: false })
  if (looksLikeDiff(text, contentType, url)) return { url, status, contentType, bytes, kind: 'diff', ...cut(text), audit: null }
  if (isHtml) return { url, status, contentType, bytes, kind: 'markdown', ...cut(htmlToMarkdown(text, url)), audit: audit(text) }
  if (/markdown/i.test(contentType) || /\.md$/i.test(url)) return { url, status, contentType, bytes, kind: 'markdown', ...cut(text), audit: null }
  return { url, status, contentType, bytes, kind: 'text', ...cut(text), audit: null }
}

export const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** The audit as the findings worth a glance, worst first. */
export function findings(a: Audit): string[] {
  const out: string[] = []
  if (a.noAlt > 0) out.push(`${a.noAlt} of ${a.images} image${a.images === 1 ? '' : 's'} with no alt text`)
  if (a.h1 === 0) out.push('no h1')
  if (a.h1 > 1) out.push(`${a.h1} h1 headings`)
  if (!a.hasLang) out.push('no lang on <html>')
  if (!a.hasViewport) out.push('no viewport meta')
  if (a.title === '') out.push('no title')
  return out
}

/** A dev server's address in a command's output, if it printed one. */
export function devServer(output: string): string | null {
  const m = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b[^\s]*/i.exec(output)
  return m === null ? null : m[0].replace('0.0.0.0', 'localhost').replace(/[).,;]+$/, '')
}
