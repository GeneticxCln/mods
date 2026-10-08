/**
 * The arithmetic of a cold prompt cache. Pure.
 *
 * A cache entry lives for a time after its last use. After that the next request writes the whole prompt
 * to the cache again, which costs more than reading it: a write is billed at 1.25x the base input price
 * for the 5-minute cache and 2x for the 1-hour cache; a read at 0.1x. The "tax" is the difference.
 */

export const MIN_TOKENS = 5_000
export const READ = 0.1

export type Config = { ttlMinutes: number; pricePerMTok: number }

export const writeMultiplier = (ttlMinutes: number): number => (ttlMinutes <= 5 ? 1.25 : 2)

export function costs(tokens: number, c: Config): { cold: number; warm: number; tax: number } {
  const base = (tokens / 1_000_000) * c.pricePerMTok
  const cold = base * writeMultiplier(c.ttlMinutes)
  const warm = base * READ
  return { cold, warm, tax: cold - warm }
}

export type Phase = 'unknown' | 'warm' | 'cooling' | 'cold'

/** Where the cache stands: cooling is the last five minutes (or a fifth of the lifetime, if shorter). */
export function phase(idleMs: number | null, tokens: number | null, ttlMinutes: number): Phase {
  if (idleMs === null || tokens === null || tokens < MIN_TOKENS) return 'unknown'
  const ttl = ttlMinutes * 60_000
  if (idleMs >= ttl) return 'cold'
  const margin = Math.min(5 * 60_000, ttl / 5)
  return idleMs >= ttl - margin ? 'cooling' : 'warm'
}

export const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000))

export const dollars = (n: number): string => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

export const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** How often a keep-warm ping is due while idle: a margin before the entry would lapse. */
export const pingEveryMs = (ttlMinutes: number): number => Math.max(60_000, ttlMinutes * 60_000 - Math.min(5 * 60_000, (ttlMinutes * 60_000) / 5))

export const numberOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback)

export type StatusInput = { idleMs: number | null; tokens: number | null; ttl: number; price: number; isKeepWarm: boolean; pings: number; maxPings: number }

/** What `/keepwarm status` prints: where the cache stands, what a reload costs, and whether keep-warm is on. */
export function statusText(i: StatusInput): string {
  if (i.idleMs === null || i.tokens === null) return 'No conversation yet, so there is no cache to keep warm.'
  if (i.tokens < MIN_TOKENS) return `The conversation is only ${i.tokens} tokens, too small for the cache to matter.`
  const idle = minutes(i.idleMs)
  const p = phase(i.idleMs, i.tokens, i.ttl)
  const { cold, warm } = costs(i.tokens, { ttlMinutes: i.ttl, pricePerMTok: i.price })
  const head =
    p === 'cold'
      ? `Cache is cold (idle ${idle} min).`
      : p === 'cooling'
        ? `Cache is cooling: idle ${idle} of ${i.ttl} min.`
        : `Cache is warm: idle ${idle} of ${i.ttl} min.`
  const cost = `Reloading ~${thousands(i.tokens)} tokens costs ${dollars(cold)} instead of ${dollars(warm)}.`
  const keep = i.isKeepWarm ? `Keep-warm is on (${i.pings} of ${i.maxPings} pings used).` : 'Keep-warm is off. /keepwarm on turns it on.'
  return `${head} ${cost} ${keep}`
}
