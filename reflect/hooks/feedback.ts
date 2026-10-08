/**
 * Is this prompt a correction, and what rule would it be if written down?
 *
 * Pure. The hook decides what to do with the answer. A false positive costs one dismissed banner and a
 * false negative costs nothing, so the patterns are specific rather than clever, and a long prompt
 * (a pasted log, a spec) is never read as a correction at all.
 */

export const MAX_PROMPT = 400
export const MAX_RULE = 180

/** Said at the start of a sentence, they mark the reply as a correction. */
const OPENERS = /^(no|nope|nah|wrong|stop|wait|actually|ugh)\b[\s,.!:;-]*/i

const PATTERNS: RegExp[] = [
  // "don't <verb>": any verb but the ones people say to reassure ("don't worry") or to describe themselves.
  /\b(don'?t|do not|dont|never|stop|quit)\s+(?!worry|forget|bother|hesitate|mind|know|think|understand|get|have|need|want|see|like|care|stress|panic|rush|be\b|you\b|it\b|that\b)[a-z]{3,}/i,
  /\bnot like that\b/i,
  /\bthat'?s not what i (asked|wanted|meant|said)\b/i,
  /\bi (told|asked|said) you\b/i,
  /\b(always|from now on|next time|going forward)\b.{3,}/i,
  /\binstead of (that|this|using|doing)\b/i,
  /\bwhy (did|would) you\b/i,
]

/** The sentence of `text` that holds the match, so a rule is one thought and not the whole message. */
function sentenceWith(text: string, at: number): string {
  const before = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('?', at - 1), text.lastIndexOf('\n', at - 1))
  const rest = text.slice(at)
  const end = rest.search(/[.!?\n]/)
  return text.slice(before + 1, end === -1 ? text.length : at + end + 1).trim()
}

const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/** The rule a correction states, cleaned of the interjection in front of it and the "please" behind. */
export function toRule(sentence: string): string {
  let s = sentence.trim().replace(OPENERS, '')
  s = s.replace(/\b(please|pls|thanks|thank you)\b[\s,.!]*$/i, '').replace(/^(and|but|so)\s+/i, '')
  s = s.replace(/\s+/g, ' ').replace(/[\s,;:-]+$/, '').trim()
  if (s.length > MAX_RULE) s = s.slice(0, MAX_RULE - 1).replace(/\s+\S*$/, '') + '…'
  s = capitalize(s)
  return /[.!?…]$/.test(s) ? s : `${s}.`
}

export type Detected = { text: string; said: string }

export function detect(prompt: string): Detected | null {
  const said = prompt.trim()
  if (said === '' || said.length > MAX_PROMPT || said.startsWith('/')) return null
  for (const pattern of PATTERNS) {
    const m = pattern.exec(said)
    if (m === null) continue
    const rule = toRule(sentenceWith(said, m.index))
    // "No." alone, or a question, is a reaction and not a rule.
    if (rule.length < 8 || rule.endsWith('?')) continue
    return { text: rule, said }
  }
  return null
}

export const HEADING = '## Rules from feedback'

/** `existing` with the rule added under the heading, or null when it is already there. */
export function addRule(existing: string, rule: string): string | null {
  const line = `- ${rule}`
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (existing.split('\n').some(l => norm(l.replace(/^[-*]\s*/, '')) === norm(rule))) return null
  if (existing.trim() === '') return `# CLAUDE.md\n\n${HEADING}\n\n${line}\n`
  const at = existing.indexOf(HEADING)
  if (at === -1) return `${existing.replace(/\n*$/, '\n')}\n${HEADING}\n\n${line}\n`
  // Append to the end of the section: just before the next heading, or at the end of the file.
  const after = at + HEADING.length
  const next = existing.slice(after).search(/\n#{1,6} /)
  const stop = next === -1 ? existing.length : after + next
  const head = existing.slice(0, stop).replace(/\n*$/, '\n')
  return `${head}${line}\n${stop < existing.length ? '\n' + existing.slice(stop).replace(/^\n+/, '') : ''}`
}
