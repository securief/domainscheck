/**
 * Local TLD registry (Cloudflare D1, table `tlds`).
 * The runtime asks D1 for TLD config and never performs IANA metadata discovery.
 */

type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> }
  }
}

export type TldConfig = {
  tld: string
  whoisServer: string | null
  rdapUrl: string | null
}

export type TldRoute =
  | { kind: 'rdap'; url: string }
  | { kind: 'whois'; server: string }
  | { kind: 'unsupported'; reason: string }

/**
 * Route one TLD: RDAP first, then WHOIS, otherwise unsupported.
 * A TLD missing from the registry (or with both fields NULL) is "unsupported".
 */
export function routeTld(config: TldConfig | undefined, tld: string): TldRoute {
  if (config?.rdapUrl) return { kind: 'rdap', url: config.rdapUrl }
  if (config?.whoisServer) return { kind: 'whois', server: config.whoisServer }
  return {
    kind: 'unsupported',
    reason: config
      ? `no RDAP or WHOIS server registered for .${tld}`
      : `unknown TLD .${tld} (not in the local registry)`,
  }
}

/** Single D1 query for a bulk request. Returns null when the registry is unavailable. */
export async function loadTldConfigs(
  tlds: readonly string[],
): Promise<Map<string, TldConfig> | null> {
  if (tlds.length === 0) return new Map()
  try {
    // Dynamic import keeps this module loadable outside the Workers runtime (tests).
    const { env } = await import('cloudflare:workers')
    const db = (env as unknown as Record<string, D1Like | undefined>).TLD_DB
    if (!db) return null

    const marks = tlds.map(() => '?').join(', ')
    const { results } = await db
      .prepare(`SELECT tld, whois_server, rdap_url FROM tlds WHERE tld IN (${marks})`)
      .bind(...tlds)
      .all<{ tld: string; whois_server: string | null; rdap_url: string | null }>()

    const configs = new Map<string, TldConfig>()
    for (const row of results) {
      configs.set(row.tld, {
        tld: row.tld,
        whoisServer: row.whois_server || null,
        rdapUrl: row.rdap_url || null,
      })
    }
    return configs
  } catch {
    return null
  }
}
