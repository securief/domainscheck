import { createFileRoute } from '@tanstack/react-router'
import { env, waitUntil } from 'cloudflare:workers'
import { parseName } from '../../../lib/domain.ts'
import { resolveExtensions } from '../../../lib/extensions.ts'
import { mapLimit } from '../../../lib/limiter.ts'
import { lookupRdap } from '../../../lib/rdap.ts'
import {
  getCachedResult,
  makeResult,
  presentResult,
  storeResult,
  summarize,
  type DomainResult,
  type DomainTarget,
} from '../../../lib/results.ts'
import { loadTldConfigs, routeTld, type TldConfig, type TldRoute } from '../../../lib/tlds.ts'
import { lookupWhois } from '../../../lib/whois.ts'

const DEFAULT_CONCURRENCY = 5

export const Route = createFileRoute('/api/domains/check')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams
        return handleCheck(params.get('name'), params.getAll('extensions'))
      },
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'invalid JSON body' }, { status: 400 })
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          return Response.json({ error: 'JSON body must be an object' }, { status: 400 })
        }
        const { name, extensions } = body as { name?: unknown; extensions?: unknown }
        return handleCheck(name, extensions)
      },
    },
  },
})

async function handleCheck(rawName: unknown, rawExtensions: unknown): Promise<Response> {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return Response.json({ error: 'name is required' }, { status: 400 })
  }
  const parsed = parseName(rawName)
  if (!parsed) {
    return Response.json({ error: 'invalid domain name' }, { status: 400 })
  }

  const parts: unknown[] =
    rawExtensions == null ? [] : Array.isArray(rawExtensions) ? rawExtensions : [rawExtensions]
  const requested: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') {
      return Response.json(
        { error: 'extensions must be a comma-separated string or an array of strings' },
        { status: 400 },
      )
    }
    for (const ext of part.split(',')) {
      const trimmed = ext.trim()
      if (trimmed) requested.push(trimmed)
    }
  }

  const { extensions, invalid } = resolveExtensions(
    parsed.extension,
    requested.length > 0 ? requested : null,
  )
  if (invalid.length > 0) {
    return Response.json({ error: `invalid extension: ${invalid.join(', ')}` }, { status: 400 })
  }

  const targets: DomainTarget[] = extensions.map((extension) => ({
    domain: `${parsed.name}.${extension}`,
    extension,
  }))
  const limit = Number(env.LOOKUP_CONCURRENCY) || DEFAULT_CONCURRENCY

  // Read KV for every domain concurrently; a failed read degrades to a miss.
  const hits = await Promise.allSettled(targets.map((target) => getCachedResult(target.domain)))
  const cachedByDomain = new Map<string, DomainResult>()
  const staleTargets: DomainTarget[] = []
  const misses: DomainTarget[] = []
  hits.forEach((settled, i) => {
    const hit = settled.status === 'fulfilled' ? settled.value : null
    const target = targets[i]
    if (hit === null) {
      misses.push(target)
      return
    }
    // Fresh and stale hits alike are cached data: returned as-is (stale refreshes below).
    cachedByDomain.set(target.domain, hit.result)
    if (hit.stale) staleTargets.push(target)
  })

  // Single D1 query for every TLD in this bulk request.
  const lookups = [...misses, ...staleTargets]
  const configs = await loadTldConfigs([...new Set(lookups.map((target) => target.extension))])

  // Uncached domains concurrently (bounded, one slow provider never blocks another),
  // each cached individually. Tasks never reject, so every domain gets a result.
  const fetched = await mapLimit(misses, limit, (target) => checkAndStore(target, configs))

  // Stale-while-revalidate: serve the stale result now, refresh upstream in the
  // background through the same concurrency limiter (no unbounded upstream fan-out).
  if (staleTargets.length > 0) {
    refreshInBackground(mapLimit(staleTargets, limit, (target) => checkAndStore(target, configs)))
  }

  // Merge cached + fresh and restore the requested extension order. `cached` is
  // true exactly for cache hits (fresh or stale) — the set `meta.cached` counts.
  const fetchedByDomain = new Map(misses.map((target, i) => [target.domain, fetched[i]]))
  const results = targets.map((target) => {
    const hit = cachedByDomain.get(target.domain)
    return presentResult(hit ?? fetchedByDomain.get(target.domain)!, hit !== undefined)
  })

  return Response.json({ name: parsed.name, results, meta: summarize(results, cachedByDomain.size) })
}

async function checkAndStore(
  target: DomainTarget,
  configs: Map<string, TldConfig> | null,
): Promise<DomainResult> {
  try {
    const result =
      configs === null
        ? makeResult(target, {
            registered: null,
            available: null,
            status: 'error',
            error: 'TLD registry (D1) unavailable',
          })
        : await checkOne(target, routeTld(configs.get(target.extension), target.extension))
    await storeResult(result)
    return result
  } catch (err) {
    // Isolation: one domain must never fail the bulk request or lose its result slot.
    return makeResult(target, {
      registered: null,
      available: null,
      status: 'error',
      error: err instanceof Error ? err.message : 'lookup failed',
    })
  }
}

function refreshInBackground(refresh: Promise<unknown>): void {
  try {
    waitUntil(refresh)
  } catch {
    void refresh // outside a Workers context (tests): best effort
  }
}

function checkOne(target: DomainTarget, route: TldRoute): Promise<DomainResult> {
  if (route.kind === 'rdap') return lookupRdap(target, route.url)
  if (route.kind === 'whois') return lookupWhois(target, route.server)
  return Promise.resolve(
    makeResult(target, { registered: null, available: null, status: 'unsupported', error: route.reason }),
  )
}
