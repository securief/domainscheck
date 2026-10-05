/** Domain check results: shape, summary, and result caching. */

import { cacheGetJson, cachePutJson } from './cache.ts'

export type DomainTarget = {
  domain: string
  extension: string
}

export type DomainStatus = 'registered' | 'available' | 'reserved' | 'unsupported' | 'error'

export type DomainResult = {
  domain: string
  extension: string
  registered: boolean | null
  available: boolean | null
  status: DomainStatus
  error?: string
  cachedAt: string
}

export function makeResult(
  target: DomainTarget,
  fields: Pick<DomainResult, 'registered' | 'available' | 'status'> & { error?: string },
): DomainResult {
  return { domain: target.domain, extension: target.extension, cachedAt: new Date().toISOString(), ...fields }
}

/** API result: the stored shape minus its cache metadata, plus a cache flag. */
export type CheckResult = Omit<DomainResult, 'cachedAt'> & { cached: boolean }

/**
 * Project a result for the response: `cachedAt` (the freshness timestamp) stays
 * internal to the cache entry, `cached` reports whether it was served from cache.
 */
export function presentResult(result: DomainResult, cached: boolean): CheckResult {
  const { cachedAt, ...fields } = result
  return { ...fields, cached }
}

export type CheckMeta = {
  total: number
  available: number
  registered: number
  reserved: number
  unsupported: number
  errors: number
  cached: number
}

export function summarize(results: readonly Pick<DomainResult, 'status'>[], cachedCount: number): CheckMeta {
  const meta: CheckMeta = {
    total: results.length,
    available: 0,
    registered: 0,
    reserved: 0,
    unsupported: 0,
    errors: 0,
    cached: cachedCount,
  }
  for (const item of results) {
    if (item.status === 'registered') meta.registered++
    else if (item.status === 'available') meta.available++
    else if (item.status === 'reserved') meta.reserved++
    else if (item.status === 'unsupported') meta.unsupported++
    else meta.errors++
  }
  return meta
}

// --- result caching (KV `DOMAIN_CACHE`, key per domain) ---

const DOMAIN_KEY_PREFIX = 'domain:'

/** Upstream request timeouts (ms). */
export const TIMEOUT = {
  rdap: 3000,
  whois: 5000,
}

/** Fresh windows (seconds): within this age a cached result is served as-is. */
const CACHE_TTL: Record<DomainStatus, number> = {
  available: 600, // 10 minutes
  registered: 3600, // 1 hour
  reserved: 3600, // 1 hour: registry-reserved names flip rarely
  error: 2, // 2 seconds: short error cache so a failing provider is not hammered
  unsupported: 600, // 10 minutes
}

/**
 * Stale-while-revalidate windows (seconds) for successful results. The KV entry
 * lives this long: fresh for CACHE_TTL, then served stale while a background
 * refresh runs, then it expires and the next request does a normal lookup.
 */
const STALE_TTL: Partial<Record<DomainStatus, number>> = {
  available: 1800, // 30 minutes
  registered: 21600, // 6 hours
}

/** Physical KV lifetime: up to the stale boundary for successful results. */
export function ttlForResult(result: DomainResult): number {
  return STALE_TTL[result.status] ?? CACHE_TTL[result.status]
}

/** Fresh = stored within the status fresh window. Older hits are stale. */
export function isFresh(result: DomainResult, now = Date.now()): boolean {
  return now - Date.parse(result.cachedAt) < CACHE_TTL[result.status] * 1000
}

export type CacheHit = { result: DomainResult; stale: boolean }

export function cacheKeyFor(domain: string): string {
  return DOMAIN_KEY_PREFIX + domain
}

export async function getCachedResult(domain: string): Promise<CacheHit | null> {
  const result = await cacheGetJson<DomainResult>(cacheKeyFor(domain))
  if (result === null) return null
  return { result, stale: !isFresh(result) }
}

export async function storeResult(result: DomainResult): Promise<void> {
  await cachePutJson(cacheKeyFor(result.domain), result, ttlForResult(result))
}
