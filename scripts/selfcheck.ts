import assert from 'node:assert/strict'
import {
  isTransientWhoisResponse,
  isValidWhoisHost,
  normalizeRdapUrl,
  parseRdapBootstrap,
  parseTldList,
  parseWhoisFromDbPage,
  parseWhoisRecord,
} from '../scripts/build-tld-database.ts'
import { parseName } from '../src/lib/domain.ts'
import { resolveExtensions, SUPPORTED_EXTENSIONS } from '../src/lib/extensions.ts'
import { mapLimit } from '../src/lib/limiter.ts'
import {
  isFresh,
  makeResult,
  presentResult,
  summarize,
  ttlForResult,
  type DomainResult,
} from '../src/lib/results.ts'
import { routeTld, type TldConfig } from '../src/lib/tlds.ts'
import { classifyWhois, querySocket, type SocketLike } from '../src/lib/whois.ts'

// --- domain parsing ---
assert.deepEqual(parseName('example.com'), { name: 'example', extension: 'com' })
assert.deepEqual(parseName('  Example.COM. '), { name: 'example', extension: 'com' })
assert.deepEqual(parseName('example'), { name: 'example', extension: null })
assert.deepEqual(parseName('foo.bar.com'), { name: 'foo.bar', extension: 'com' })
assert.equal(parseName(''), null)
assert.equal(parseName('.'), null)
assert.equal(parseName('bad_name.com'), null)
assert.equal(parseName('-bad.com'), null)
assert.equal(parseName('a'.repeat(64) + '.com'), null)

// --- extension resolution ---
assert.deepEqual(resolveExtensions('com', ['net', 'org']), {
  extensions: ['com', 'net', 'org'],
  invalid: [],
})
assert.deepEqual(resolveExtensions(null, ['net', 'org', 'dev']).extensions, ['net', 'org', 'dev'])
assert.deepEqual(resolveExtensions('com', ['net', 'com', 'net']).extensions, ['com', 'net'])
assert.deepEqual(resolveExtensions(null, ['.com', '.NET']).extensions, ['com', 'net'])
assert.deepEqual(resolveExtensions('com', null).extensions, [
  'com',
  ...SUPPORTED_EXTENSIONS.filter((e) => e !== 'com'),
])
assert.deepEqual(resolveExtensions(null, null).extensions, SUPPORTED_EXTENSIONS)
assert.deepEqual(resolveExtensions(null, ['co!m', 'net']), {
  extensions: ['net'],
  invalid: ['co!m'],
})

// --- concurrency limiter ---
let active = 0
let maxActive = 0
const limited = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
  active++
  maxActive = Math.max(maxActive, active)
  await new Promise((resolve) => setTimeout(resolve, 10))
  active--
  return n * 2
})
assert.deepEqual(limited, [2, 4, 6, 8, 10, 12])
assert.ok(maxActive <= 2, `concurrency exceeded: ${maxActive}`)

// --- result summary (meta) ---
const mk = (domain: string, status: DomainResult['status']): DomainResult =>
  makeResult(
    { domain, extension: domain.split('.').pop()! },
    { registered: null, available: null, status },
  )
assert.deepEqual(
  summarize(
    [
      mk('obstatic.dev', 'available'),
      mk('obstatic.net', 'registered'),
      mk('facebook.sh', 'reserved'),
      mk('obstatic.sh', 'unsupported'),
      mk('obstatic.io', 'unsupported'),
      mk('obstatic.com', 'error'),
    ],
    3,
  ),
  { total: 6, available: 1, registered: 1, reserved: 1, unsupported: 2, errors: 1, cached: 3 },
)

// --- result caching policy (fresh window vs stale-while-revalidate window) ---
const registered = mk('x.com', 'registered')
assert.equal(isFresh(registered), true)
assert.equal(isFresh({ ...registered, cachedAt: new Date(Date.now() - 4000_000).toISOString() }), false) // past 1h fresh
assert.equal(ttlForResult(registered), 21600) // kept up to the stale boundary (6h)

const available = mk('y.sh', 'available')
assert.equal(isFresh({ ...available, cachedAt: new Date(Date.now() - 700_000).toISOString() }), false) // past 10min fresh
assert.equal(ttlForResult(available), 1800) // stale boundary 30min

assert.equal(ttlForResult(mk('z.com', 'error')), 2) // short error cache, no stale window
assert.equal(ttlForResult(mk('z.al', 'unsupported')), 600)
assert.equal(ttlForResult(mk('fb.sh', 'reserved')), 3600) // reserved names flip rarely

// --- response shape: `cachedAt` is cache metadata, the response exposes `cached` ---
const presented = presentResult(mk('obstatic.com', 'registered'), true)
assert.equal(presented.cached, true)
assert.ok(!('cachedAt' in presented), 'cachedAt must not leak into the response')
assert.equal(presentResult(mk('obstatic.com', 'registered'), false).cached, false)

// --- TLD routing (RDAP first, then WHOIS, else unsupported) ---
const config = (tld: string, over: Partial<TldConfig>): TldConfig => ({
  tld,
  whoisServer: null,
  rdapUrl: null,
  ...over,
})
assert.deepEqual(routeTld(config('com', { rdapUrl: 'https://rdap.verisign.com/com/v1/', whoisServer: 'whois.verisign-grs.com' }), 'com'), {
  kind: 'rdap',
  url: 'https://rdap.verisign.com/com/v1/',
})
assert.deepEqual(routeTld(config('io', { whoisServer: 'whois.nic.io' }), 'io'), {
  kind: 'whois',
  server: 'whois.nic.io',
})
assert.equal(routeTld(config('xx', {}), 'xx').kind, 'unsupported')
assert.equal(routeTld(undefined, 'zzz').kind, 'unsupported')

// --- WHOIS response classification ---
assert.equal(
  classifyWhois('No match for "MYNEWDOMAIN.COM".\n>>> Last update of WHOIS database <<<'),
  'available',
)
assert.equal(classifyWhois('Domain not found.'), 'available')
assert.equal(classifyWhois('domain:       EXAMPLE.DE\nstatus:       free'), 'available')
assert.equal(
  classifyWhois(
    'Domain Name: EXAMPLE.COM\nRegistry Domain ID: 1\nRegistrar: Example Registrar\nCreation Date: 1995-08-14',
  ),
  'registered',
)
assert.equal(classifyWhois('domain:       example.de\nnserver:       ns.example.de'), 'registered')
assert.equal(classifyWhois('Quota exceeded, try again later'), null)
// regression: registry-reserved names are a third state, not "could not be classified"
assert.equal(
  classifyWhois('This name is reserved by the Registry.\n>>> Last update of WHOIS database <<<'),
  'reserved',
)
assert.equal(classifyWhois('This domain has been reserved by the registry.'), 'reserved')

// --- WHOIS socket protocol (querySocket): write discipline, read to EOF, teardown once ---
function fakeSocket() {
  const encode = new TextEncoder()
  const written: string[] = []
  let writerClosed = false
  let closeCalls = 0
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      ctrl = controller
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => void written.push(new TextDecoder().decode(chunk)),
    close: () => void (writerClosed = true),
  })
  const socket: SocketLike = {
    readable,
    writable,
    close: () => {
      closeCalls++
      try {
        ctrl.close()
      } catch {
        // already closed
      }
    },
  }
  return {
    socket,
    written,
    get writerClosed() {
      return writerClosed
    },
    get closeCalls() {
      return closeCalls
    },
    push: (text: string) => void ctrl.enqueue(encode.encode(text)),
    end: () => void ctrl.close(),
  }
}

const echo = fakeSocket()
echo.push('No match for "EXAMPLE.COM".\r\n')
echo.push('>>> Last update of WHOIS database <<<\r\n')
echo.end()
assert.equal(
  await querySocket(echo.socket, 'example.com', 500),
  'No match for "EXAMPLE.COM".\r\n>>> Last update of WHOIS database <<<\r\n',
) // accumulate until the server closes
assert.deepEqual(echo.written, ['example.com\r\n']) // query written as `name\r\n`
assert.equal(echo.writerClosed, false) // regression: closing writable = empty responses
assert.equal(echo.closeCalls, 1) // teardown owner closes exactly once

const flood = fakeSocket()
for (let i = 0; i < 200; i++) flood.push('x'.repeat(1024))
const capped = await querySocket(flood.socket, 'big.com', 500)
assert.ok(capped.length > 65536 && capped.length <= 65536 + 1024, `cap overshoot: ${capped.length}`)

const hang = fakeSocket() // never enqueues, never closes
await assert.rejects(querySocket(hang.socket, 'slow.com', 50), /WHOIS timeout after 50ms/)
assert.equal(hang.closeCalls, 1) // old code double-closed here (timer + finally)

// --- build: IANA TLD list parsing ---
assert.deepEqual(parseTldList('# Version 2026-10-04\nCOM\nNET\nXN--P1AI\ncom\nbad_tld\n'), {
  tlds: ['com', 'net', 'xn--p1ai'],
  duplicates: ['com'],
  malformed: ['bad_tld'],
})

// --- build: RDAP bootstrap parsing ---
assert.deepEqual(normalizeRdapUrl('https://rdap.verisign.com/com/v1'), 'https://rdap.verisign.com/com/v1/')
assert.equal(normalizeRdapUrl('http://rdap.nic.mg/'), 'http://rdap.nic.mg/') // plain http is valid
assert.equal(normalizeRdapUrl('ftp://x.example/'), null)
assert.equal(normalizeRdapUrl('not a url'), null)
assert.ok(isValidWhoisHost('whois.verisign-grs.com'))
assert.ok(!isValidWhoisHost('whois'))
assert.ok(!isValidWhoisHost('bad host!.com'))

const parsed = parseRdapBootstrap(
  {
    services: [
      [['net', 'com'], ['https://rdap.verisign.com/com/v1/']],
      [['dev'], ['https://www.registry.google/rdap/']],
      [['sh'], ['not a url']],
      [['zzz'], ['https://rdap.example.com/']],
    ],
  },
  new Set(['com', 'net', 'dev', 'sh']),
)
assert.deepEqual(parsed.rdap.get('com'), 'https://rdap.verisign.com/com/v1/')
assert.deepEqual(parsed.rdap.get('dev'), 'https://www.registry.google/rdap/')
assert.deepEqual(parsed.unknownTlds, ['zzz'])
assert.equal(parsed.invalidUrls.length, 1)

const conflicting = parseRdapBootstrap(
  { services: [[['io'], ['https://a.example/']], [['io'], ['https://b.example/']]] },
  new Set(['io']),
)
assert.equal(conflicting.conflicts.length, 1)
assert.equal(conflicting.conflicts[0].kept, 'https://a.example/')

// --- build: IANA WHOIS record parsing ---
assert.deepEqual(
  parseWhoisRecord(
    `<pre>% IANA WHOIS server
% This query returned 1 object

domain:       SH

organisation: Government of St. Helena

whois:        whois.nic.sh
status:       ACTIVE
source:       IANA
</pre>`,
  ),
  { tld: 'sh', whoisServer: 'whois.nic.sh' },
)
assert.deepEqual(
  parseWhoisRecord('<pre>% This query returned 0 objects\n% No entries found for the selected source\n</pre>'),
  { tld: null, whoisServer: null },
)
// regression: an empty "whois:" line must not swallow the following "status:" line
assert.deepEqual(parseWhoisRecord('<pre>domain:       ACADEMY\nwhois:\nstatus:       ACTIVE\n</pre>'), {
  tld: 'academy',
  whoisServer: null,
})

// --- build: root DB page fallback parsing ---
assert.equal(
  parseWhoisFromDbPage('<b>URL for registration services:</b> <a href="http://www.nic.sh/">x</a><br/><b>WHOIS Server:</b> whois.nic.sh <br/>'),
  'whois.nic.sh',
)
assert.equal(
  parseWhoisFromDbPage('<b>WHOIS Server:</b> <a href="whois://x">Whois.NIC.Uk</a>'),
  'whois.nic.uk',
)
assert.equal(parseWhoisFromDbPage('<b>URL for registration services:</b> http://www.nic.sh/'), null)

// --- build: transient upstream responses (HTTP 200 with an error message) ---
assert.ok(isTransientWhoisResponse('<pre>WHOIS server is temporarily unavailable. Please try again later.</pre>'))
assert.ok(!isTransientWhoisResponse('<pre>domain: SH\nwhois: whois.nic.sh</pre>'))

console.log('selfcheck ok')
