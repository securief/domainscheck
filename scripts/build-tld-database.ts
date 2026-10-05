/**
 * Builds the local TLD registry dataset from IANA sources.
 *
 *   1. https://data.iana.org/TLD/tlds-alpha-by-domain.txt  authoritative TLD list
 *   2. https://data.iana.org/rdap/dns.json                 TLD -> RDAP URL
 *   3. https://www.iana.org/whois?q=.<tld>                 IANA WHOIS record (whois: server)
 *
 * Output:  data/tlds.json (dataset), data/tlds.sql (D1 import), data/tlds.report.json
 * Run:     bun run build:tlds
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValidLabel } from '../src/lib/domain.ts'
import { mapLimit } from '../src/lib/limiter.ts'

export const TLD_LIST_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt'
export const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json'
export const IANA_WHOIS_URL = (tld: string): string =>
  `https://www.iana.org/whois?q=${encodeURIComponent('.' + tld)}`
export const IANA_DB_PAGE_URL = (tld: string): string =>
  `https://www.iana.org/domains/root/db/${tld}.html`

const WHOIS_CONCURRENCY = 4
const USER_AGENT = 'domainscheck-tld-build/1.0'
const SQL_BATCH = 100
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')

/**
 * Verified registry WHOIS servers, used when the IANA record has none. source: registry.
 * uk: Nominet publishes no WHOIS field in its IANA record; verified against whois.nic.uk:43.
 */
export const REGISTRY_WHOIS: Record<string, string> = {
  uk: 'whois.nic.uk',
}
/** Last-resort mappings maintained by hand. source: manual */
export const MANUAL_WHOIS: Record<string, string> = {}

export type Source = 'iana' | 'iana-rdap' | 'iana-whois' | 'registry' | 'manual'

export type TldListParse = {
  tlds: string[]
  duplicates: string[]
  malformed: string[]
}

export type RdapParse = {
  rdap: Map<string, string>
  unknownTlds: string[]
  malformed: string[]
  invalidUrls: string[]
  conflicts: Array<{ tld: string; kept: string; dropped: string }>
}

export type WhoisRecord = { tld: string | null; whoisServer: string | null }

export type Row = { tld: string; whois: string | null; rdap: string | null; source: Source }

export type BuildReport = {
  generatedAt: string
  counts: {
    tlds: number
    rdap: number
    whois: number
    missingRdap: number
    missingWhois: number
    conflicts: number
  }
  sourceCounts: Record<string, number>
  duplicates: string[]
  malformed: string[]
  invalidUrls: string[]
  invalidWhois: string[]
  unknownRdapTlds: string[]
  missingTlds: string[]
  fetchFailures: string[]
  conflicts: Array<{ tld: string; field: 'whois' | 'rdap'; kept: string; dropped: string }>
}

// --- pure parsers (also used by the self-check) ---

/** Parse the IANA TLD list: comments out, lowercase, one TLD per line. */
export function parseTldList(text: string): TldListParse {
  const tlds: string[] = []
  const duplicates: string[] = []
  const malformed: string[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    const tld = raw.toLowerCase()
    if (!isValidLabel(tld)) {
      malformed.push(raw)
      continue
    }
    if (seen.has(tld)) {
      duplicates.push(tld)
      continue
    }
    seen.add(tld)
    tlds.push(tld)
  }
  return { tlds, duplicates, malformed }
}

export function normalizeRdapUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null
    return url.href.endsWith('/') ? url.href : url.href + '/'
  } catch {
    return null
  }
}

export function isValidWhoisHost(value: string): boolean {
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    value,
  )
}

/** Parse the IANA RDAP Bootstrap Registry into TLD -> RDAP URL. */
export function parseRdapBootstrap(data: unknown, known: ReadonlySet<string>): RdapParse {
  const rdap = new Map<string, string>()
  const unknownTlds: string[] = []
  const malformed: string[] = []
  const invalidUrls: string[] = []
  const conflicts: RdapParse['conflicts'] = []

  const services = (data as { services?: unknown })?.services
  if (!Array.isArray(services)) return { rdap, unknownTlds, malformed, invalidUrls, conflicts }

  for (const entry of services) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const [tlds, urls] = entry as [unknown, unknown]
    if (!Array.isArray(tlds) || !Array.isArray(urls) || urls.length === 0) continue

    const rawUrl = urls[0]
    const url = typeof rawUrl === 'string' ? normalizeRdapUrl(rawUrl) : null
    if (!url) {
      invalidUrls.push(String(rawUrl))
      continue
    }

    for (const rawTld of tlds) {
      const tld = String(rawTld).toLowerCase()
      if (!isValidLabel(tld)) {
        malformed.push(String(rawTld))
        continue
      }
      if (!known.has(tld)) unknownTlds.push(tld)
      const existing = rdap.get(tld)
      if (existing && existing !== url) {
        conflicts.push({ tld, kept: existing, dropped: url })
        continue
      }
      rdap.set(tld, url)
    }
  }
  return { rdap, unknownTlds, malformed, invalidUrls, conflicts }
}

/** Parse one IANA WHOIS record page (the record body sits in a <pre> block). */
export function parseWhoisRecord(html: string): WhoisRecord {
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html)
  const body = decodeEntities(pre ? pre[1] : html)
  // [ \t]* — never cross lines, or an empty "whois:" would swallow the next "status:" line.
  const domain = /^[ \t]*domain:[ \t]*(\S+)/im.exec(body)
  const whois = /^[ \t]*whois:[ \t]*(\S+)/im.exec(body)
  return {
    tld: domain ? domain[1].toLowerCase() : null,
    whoisServer: whois ? whois[1].toLowerCase() : null,
  }
}

/** IANA serves transient failures with HTTP 200 and a message in the record body. */
export function isTransientWhoisResponse(html: string): boolean {
  return /temporarily unavailable|try again later|rate limit|quota exceeded/i.test(html)
}

/**
 * Fallback source: the per-TLD root DB page (…/domains/root/db/<tld>.html),
 * used when the WHOIS record has no server (empty field or transient failure).
 */
export function parseWhoisFromDbPage(html: string): string | null {
  const match = /<b>\s*WHOIS Server:\s*<\/b>\s*(?:<a[^>]*>)?\s*([^<\r\n]+)/i.exec(html)
  return match ? match[1].trim().toLowerCase() || null : null
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

// --- D1 import file ---

function sqlLiteral(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`
}

export function toSql(rows: readonly Row[], updatedAt: number): string {
  const lines = [
    'CREATE TABLE IF NOT EXISTS tlds (',
    '  tld TEXT PRIMARY KEY,',
    '  whois_server TEXT,',
    '  rdap_url TEXT,',
    '  source TEXT NOT NULL,',
    '  updated_at INTEGER NOT NULL',
    ');',
    '',
    'DELETE FROM tlds;',
    '',
  ]
  for (let i = 0; i < rows.length; i += SQL_BATCH) {
    lines.push('INSERT INTO tlds (tld, whois_server, rdap_url, source, updated_at) VALUES')
    lines.push(
      rows
        .slice(i, i + SQL_BATCH)
        .map(
          (row) =>
            `  (${sqlLiteral(row.tld)}, ${sqlLiteral(row.whois)}, ${sqlLiteral(row.rdap)}, ${sqlLiteral(row.source)}, ${updatedAt})`,
        )
        .join(',\n') + ';',
    )
    lines.push('')
  }
  return lines.join('\n')
}

// --- build ---

const RETRY_DELAYS_MS = [1_000, 3_000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fetch with retry/backoff — transient upstream failures must not corrupt the dataset. */
async function fetchText(url: string): Promise<string> {
  let lastError = new Error(`fetch failed for ${url}`)
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1])
    let retryable = true
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (res.ok) {
        const text = await res.text()
        if (!isTransientWhoisResponse(text)) return text
        lastError = new Error(`transient upstream response for ${url}`)
      } else {
        retryable = res.status === 429 || res.status >= 500
        lastError = new Error(`HTTP ${res.status} for ${url}`)
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
    if (!retryable) throw lastError
  }
  throw lastError
}

async function main(): Promise<void> {
  const report: BuildReport = {
    generatedAt: new Date().toISOString(),
    counts: { tlds: 0, rdap: 0, whois: 0, missingRdap: 0, missingWhois: 0, conflicts: 0 },
    sourceCounts: {},
    duplicates: [],
    malformed: [],
    invalidUrls: [],
    invalidWhois: [],
    unknownRdapTlds: [],
    missingTlds: [],
    fetchFailures: [],
    conflicts: [],
  }

  // 1-2. authoritative TLD list
  const list = parseTldList(await fetchText(TLD_LIST_URL))
  report.duplicates.push(...list.duplicates)
  report.malformed.push(...list.malformed)
  const known = new Set(list.tlds)

  // 3-4. RDAP bootstrap
  const rdapParse = parseRdapBootstrap(
    JSON.parse(await fetchText(RDAP_BOOTSTRAP_URL)),
    known,
  )
  report.invalidUrls.push(...rdapParse.invalidUrls)
  report.malformed.push(...rdapParse.malformed)
  report.unknownRdapTlds.push(...rdapParse.unknownTlds)
  report.conflicts.push(...rdapParse.conflicts.map((c) => ({ ...c, field: 'rdap' as const })))

  // 5. WHOIS mappings: IANA WHOIS record first, root DB page as fallback
  const whoisFromIana = new Map<string, string>()
  await mapLimit(list.tlds, WHOIS_CONCURRENCY, async (tld) => {
    let server: string | null = null
    try {
      server = parseWhoisRecord(await fetchText(IANA_WHOIS_URL(tld))).whoisServer
    } catch {
      // transient record failure — fall back to the root DB page
    }
    if (!server) {
      try {
        server = parseWhoisFromDbPage(await fetchText(IANA_DB_PAGE_URL(tld)))
      } catch (err) {
        report.fetchFailures.push(`${tld}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    }
    if (!server) return
    if (!isValidWhoisHost(server)) {
      report.invalidWhois.push(`${tld}: ${server}`)
      return
    }
    whoisFromIana.set(tld, server)
  })

  // 6-7. merge by TLD (most specific source wins) + validate
  const rows: Row[] = []
  for (const tld of list.tlds) {
    let whois: string | null = whoisFromIana.get(tld) ?? null
    let source: Source = whois ? 'iana-whois' : rdapParse.rdap.has(tld) ? 'iana-rdap' : 'iana'

    const applyOverride = (override: string | undefined, overrideSource: 'registry' | 'manual') => {
      if (!override) return
      if (!isValidWhoisHost(override)) {
        report.invalidWhois.push(`${tld}: ${override}`)
        return
      }
      if (whois && whois !== override) {
        report.conflicts.push({ tld, field: 'whois', kept: override, dropped: whois })
      }
      whois = override
      source = overrideSource
    }
    applyOverride(REGISTRY_WHOIS[tld], 'registry')
    applyOverride(MANUAL_WHOIS[tld], 'manual')

    rows.push({ tld, whois, rdap: rdapParse.rdap.get(tld) ?? null, source })
  }

  const rowTlds = new Set(rows.map((row) => row.tld))
  report.missingTlds.push(...list.tlds.filter((tld) => !rowTlds.has(tld)))

  for (const row of rows) {
    if (row.rdap) report.counts.rdap++
    if (row.whois) report.counts.whois++
    report.sourceCounts[row.source] = (report.sourceCounts[row.source] ?? 0) + 1
  }
  report.counts.tlds = rows.length
  report.counts.missingRdap = rows.length - report.counts.rdap
  report.counts.missingWhois = rows.length - report.counts.whois
  report.counts.conflicts = report.conflicts.length

  // 8-9. generate dataset + D1 import file
  const updatedAt = Math.floor(Date.now() / 1000)
  const dataset: Record<string, { whois: string | null; rdap: string | null }> = {}
  for (const row of rows) dataset[row.tld] = { whois: row.whois, rdap: row.rdap }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(path.join(OUT_DIR, 'tlds.json'), JSON.stringify(dataset, null, 2) + '\n')
  await writeFile(path.join(OUT_DIR, 'tlds.sql'), toSql(rows, updatedAt))
  await writeFile(path.join(OUT_DIR, 'tlds.report.json'), JSON.stringify(report, null, 2) + '\n')

  console.log(`TLDs: ${report.counts.tlds}`)
  console.log(`RDAP: ${report.counts.rdap}`)
  console.log(`WHOIS: ${report.counts.whois}`)
  console.log(`Missing RDAP: ${report.counts.missingRdap}`)
  console.log(`Missing WHOIS: ${report.counts.missingWhois}`)
  console.log(`Conflicts: ${report.counts.conflicts}`)
  console.log(`Sources: ${JSON.stringify(report.sourceCounts)}`)
  console.log(`Duplicates: ${report.duplicates.length}  Malformed: ${report.malformed.length}`)
  console.log(`Invalid URLs: ${report.invalidUrls.length}  Invalid WHOIS: ${report.invalidWhois.length}`)
  console.log(`RDAP for unknown TLDs: ${report.unknownRdapTlds.length}  Missing TLDs: ${report.missingTlds.length}`)
  console.log(`Fetch failures: ${report.fetchFailures.length}`)
  if (report.conflicts.length) console.log(JSON.stringify(report.conflicts, null, 2))
  console.log(`Written: data/tlds.json, data/tlds.sql, data/tlds.report.json`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
