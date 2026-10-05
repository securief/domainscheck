type KvLike = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

// ponytail: unbounded in-memory L1 with TTL, one isolate only — fine for MVP
const memory = new Map<string, { value: string; expiresAt: number }>()
const MEMORY_FALLBACK_TTL = 60

// Dynamic import keeps this module loadable outside the Workers runtime (tests).
async function kv(): Promise<KvLike | null> {
  try {
    const { env } = await import('cloudflare:workers')
    return ((env as unknown as Record<string, KvLike | undefined>).DOMAIN_CACHE) ?? null
  } catch {
    return null
  }
}

/** Cache is an optimization layer: any failure degrades to "miss". */
export async function cacheGet(key: string): Promise<string | null> {
  const hit = memory.get(key)
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.value
    memory.delete(key)
  }
  try {
    const value = (await (await kv())?.get(key)) ?? null
    if (value !== null) {
      memory.set(key, { value, expiresAt: Date.now() + MEMORY_FALLBACK_TTL * 1000 })
    }
    return value
  } catch {
    return null
  }
}

export async function cachePut(key: string, value: string, ttlSeconds: number): Promise<void> {
  // L1 only absorbs short bursts; KV owns the real lifetime (stale windows included).
  memory.set(key, {
    value,
    expiresAt: Date.now() + Math.min(ttlSeconds, MEMORY_FALLBACK_TTL) * 1000,
  })
  try {
    await (await kv())?.put(key, value, { expirationTtl: ttlSeconds })
  } catch {
    // KV unavailable: the in-memory copy still serves this isolate
  }
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const raw = await cacheGet(key)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function cachePutJson(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  await cachePut(key, JSON.stringify(value), ttlSeconds)
}
