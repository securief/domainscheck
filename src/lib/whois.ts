import { makeResult, TIMEOUT, type DomainResult, type DomainTarget } from './results.ts'

const WHOIS_PORT = 43
const WHOIS_MAX_CHARS = 64 * 1024

/** The seam: the minimum socket shape the WHOIS protocol needs. */
export type SocketLike = {
  readable: ReadableStream<Uint8Array>
  writable: {
    getWriter(): {
      write(chunk: Uint8Array): Promise<void>
      close(): Promise<void>
      releaseLock(): void
    }
  }
  close(): void
}

// ponytail: heuristic classification of registry WHOIS text — explicit availability
// phrasings win because some registries (e.g. DENIC) print `domain:` + `status: free`
// for available names. Upgrade path: per-registry parsers if a TLD misreads.
const REGISTERED_PATTERNS = [
  /^\s*domain:\s*\S/im,
  /\bregistry domain id\b/i,
  /\bdomain name:\s*\S/i,
  /\bregistrar:\s*\S/i,
  /\bcreation date\b/i,
  /\bcreated (on|at)\b/i,
  /^\s*nserver:\s*\S/im,
]
const AVAILABLE_PATTERNS = [
  /no match for/i,
  /not found/i,
  /no data found/i,
  /no entries found/i,
  /does not exist/i,
  /available for registration/i,
  /^\s*status:\s*(available|free)\b/im,
]

// Registry-reserved names (e.g. facebook.sh): nobody registered them and they
// cannot be registered. The explicit phrasing wins over the generic patterns.
const RESERVED_PATTERN = /\bthis (?:domain|name) (?:has been |is )?reserved\b/i

/** Pure heuristic: classify a WHOIS response body, null when inconclusive. */
export function classifyWhois(text: string): 'registered' | 'available' | 'reserved' | null {
  if (RESERVED_PATTERN.test(text)) return 'reserved'
  if (AVAILABLE_PATTERNS.some((pattern) => pattern.test(text))) return 'available'
  if (REGISTERED_PATTERNS.some((pattern) => pattern.test(text))) return 'registered'
  return null
}

/** WHOIS lookup against a known server (from the local TLD registry). Never throws. */
export async function lookupWhois(target: DomainTarget, whoisServer: string): Promise<DomainResult> {
  try {
    // Dynamic import keeps this module loadable outside the Workers runtime (tests);
    // the structural cast sidesteps the generated "cloudflare:sockets" declaration.
    const { connect } = (await import('cloudflare:sockets')) as unknown as {
      connect(address: { hostname: string; port: number }): SocketLike
    }
    const socket = connect({ hostname: whoisServer, port: WHOIS_PORT })
    const status = classifyWhois(await querySocket(socket, target.domain, TIMEOUT.whois))
    if (status === 'registered') {
      return makeResult(target, { registered: true, available: false, status })
    }
    if (status === 'available') {
      return makeResult(target, { registered: false, available: true, status })
    }
    if (status === 'reserved') {
      // Registry holds the name back: nobody registered it, and it cannot be registered.
      return makeResult(target, { registered: false, available: false, status })
    }
    return makeResult(target, {
      registered: null,
      available: null,
      status: 'error',
      error: 'WHOIS response could not be classified',
    })
  } catch (err) {
    return makeResult(target, {
      registered: null,
      available: null,
      status: 'error',
      error: err instanceof Error ? err.message : 'WHOIS lookup failed',
    })
  }
}

/**
 * The WHOIS protocol seam: write `name\r\n`, release the write lock without
 * closing it, read to EOF (or the 64KB cap). Owns teardown for the socket it is
 * handed — exactly one socket.close() on every path (success, error, timeout)
 * plus timer cleanup.
 */
export async function querySocket(
  socket: SocketLike,
  name: string,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`WHOIS timeout after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    const exchange = (async () => {
      const writer = socket.writable.getWriter()
      await writer.write(new TextEncoder().encode(`${name}\r\n`))
      // Do NOT close the writable side: on cloudflare:sockets that tears down the
      // socket before the server answers (responses come back empty). Just release.
      writer.releaseLock()

      const reader = socket.readable.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
        if (text.length > WHOIS_MAX_CHARS) break
      }
      return text
    })()
    return await Promise.race([exchange, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
}
