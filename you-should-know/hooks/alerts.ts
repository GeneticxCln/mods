/**
 * What in a piece of text a person would want to be told about. Pure.
 *
 * Patterns, not understanding: each one is a phrase that, when a model or a tool prints it, usually means
 * the person has something to do or something to worry about. A false alarm costs a dismissed banner, so
 * every rule names its own title and is easy to read and to change.
 */
import type { Alert, Severity } from '../types'

type Rule = { kind: string; title: string; severity: Severity; pattern: RegExp; /** Fires on tool output too, not only on what the model wrote. */ inOutput?: boolean }

export const RULES: readonly Rule[] = [
  { kind: 'breaking', title: 'Breaking change', severity: 'high', inOutput: true, pattern: /\bbreaking[- ]changes?\b|\bbackwards?[- ]incompatible\b|\bno longer (works|supported|compatible)\b|\bwill (stop working|break)\b/i },
  { kind: 'data-loss', title: 'Data loss', severity: 'high', inOutput: true, pattern: /\bdata loss\b|\birreversible\b|\b(can(?:no|')t|cannot) be undone\b|\bpermanently (delete|remove|erase)\w*/i },
  { kind: 'secret', title: 'Possible exposed secret', severity: 'high', inOutput: true, pattern: /\b(api[_ -]?keys?|secrets?|tokens?|passwords?|credentials?)\b.{0,40}\b(exposed|leaked|committed|hard-?coded|in plain ?text|checked in)\b|\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,})\b/i },
  { kind: 'security', title: 'Security issue', severity: 'high', inOutput: true, pattern: /\bCVE-\d{4}-\d{4,}\b|\bvulnerabilit(?:y|ies)\b|\bremote code execution\b|\bsql injection\b|\bcross-site scripting\b/i },
  { kind: 'deprecation', title: 'Deprecation', severity: 'medium', inOutput: true, pattern: /\bdeprecated\b|\bwill be removed\b|\bend[- ]of[- ]life\b|\bsunset(?:ting)?\b/i },
  { kind: 'cost', title: 'Cost or quota', severity: 'medium', pattern: /\$\s?\d[\d,.]*\s*(?:\/|per)\s*(?:month|hour|day|request|call|token|gb|seat)\b|\b(?:billed|billing|charged?|pricing)\b.{0,40}\$\s?\d|\bpaid (?:plan|tier)\b|\brate[- ]limit(?:ed|s)?\b|\bquota\b/i },
  { kind: 'action', title: 'Left for you', severity: 'medium', pattern: /\byou(?:'ll| will)? (?:need|have) to (?:run|restart|migrate|update|rotate|set|install|deploy|add)\b|\byou (?:must|should) (?:run|restart|migrate|rotate|deploy)\b|\b(?:don'?t forget|remember) to (?:run|restart|migrate|rotate|deploy|set)\b/i },
  { kind: 'unverified', title: 'Not verified', severity: 'medium', pattern: /\b(?:did not|didn'?t|haven'?t|have not|couldn'?t|could not|was unable to|were unable to) (?:run|verify|test|check|reproduce)\b|\btests? (?:were |was )?(?:skipped|not run)\b/i },
]

const QUOTE = 160

/** The sentence around `at`, trimmed and cut: what the banner shows. */
function sentence(text: string, at: number, length: number): string {
  const start = Math.max(text.lastIndexOf('. ', at), text.lastIndexOf('\n', at), -1) + 1
  const rest = text.slice(at + length)
  const end = rest.search(/[.!?]\s|\n/)
  const stop = end === -1 ? text.length : at + length + end + 1
  const s = text.slice(start, stop).replace(/\s+/g, ' ').trim()
  return s.length > QUOTE ? `${s.slice(0, QUOTE - 1)}…` : s
}

const idOf = (kind: string, quote: string): string => `${kind}:${quote.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`

/** The alerts in `text`, one per rule per sentence. `source` limits which rules apply. */
export function scan(text: string, source: 'answer' | 'output'): Alert[] {
  const out: Alert[] = []
  const seen = new Set<string>()
  for (const rule of RULES) {
    if (source === 'output' && rule.inOutput !== true) continue
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      const quote = sentence(text, m.index, m[0].length)
      const id = idOf(rule.kind, quote)
      if (!seen.has(id)) {
        seen.add(id)
        out.push({ id, severity: rule.severity, title: rule.title, quote, source })
      }
      if (m[0] === '') re.lastIndex++
    }
  }
  return out
}

/** Most severe first, then in the order found; one alert per id; at most `max`. */
export function merge(existing: readonly Alert[], found: readonly Alert[], max = 6): Alert[] {
  const byId = new Map<string, Alert>()
  for (const a of [...existing, ...found]) if (!byId.has(a.id)) byId.set(a.id, a)
  const rank = (a: Alert) => (a.severity === 'high' ? 0 : 1)
  return [...byId.values()].map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map(x => x.a).slice(0, max)
}

/** Parse a model's reply into alerts; anything that is not the expected JSON array gives none. */
export function fromModel(reply: string): Alert[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1))
    if (!Array.isArray(parsed)) return []
    const out: Alert[] = []
    for (const item of parsed.slice(0, 5)) {
      const o = item as { severity?: unknown; title?: unknown; quote?: unknown }
      if (typeof o.title !== 'string' || typeof o.quote !== 'string' || o.title === '') continue
      const quote = o.quote.slice(0, QUOTE)
      out.push({ id: idOf(`model-${o.title.slice(0, 20)}`, quote), severity: o.severity === 'high' ? 'high' : 'medium', title: o.title.slice(0, 40), quote, source: 'model' })
    }
    return out
  } catch {
    return []
  }
}

export const MODEL_PROMPT = (text: string): string =>
  `Below is what an AI coding assistant just told its user. List only things the user would be upset to learn later: breaking changes, data loss, exposed secrets, security problems, costs, or work the assistant left for the user to do. Ignore anything routine. Reply with only a JSON array of at most 3 objects {"severity":"high"|"medium","title":"<4 words","quote":"<the sentence, verbatim>"}, or [] if there is nothing.\n\n---\n${text.slice(-6000)}`
