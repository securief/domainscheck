import { makeResult, TIMEOUT, type DomainResult, type DomainTarget } from './results.ts'

/**
 * RDAP lookup against a known service URL (from the local TLD registry).
 * Never throws: unknown outcomes come back as status "error".
 */
export async function lookupRdap(target: DomainTarget, rdapUrl: string): Promise<DomainResult> {
  try {
    const base = rdapUrl.endsWith('/') ? rdapUrl : rdapUrl + '/'
    const res = await fetch(new URL(`domain/${target.domain}`, base), {
      signal: AbortSignal.timeout(TIMEOUT.rdap),
      headers: { Accept: 'application/rdap+json' },
    })

    if (res.ok) {
      return makeResult(target, { registered: true, available: false, status: 'registered' })
    }
    if (res.status === 404) {
      return makeResult(target, { registered: false, available: true, status: 'available' })
    }
    return makeResult(target, {
      registered: null,
      available: null,
      status: 'error',
      error: `RDAP responded with HTTP ${res.status}`,
    })
  } catch (err) {
    return makeResult(target, {
      registered: null,
      available: null,
      status: 'error',
      error: err instanceof Error ? err.message : 'RDAP lookup failed',
    })
  }
}
