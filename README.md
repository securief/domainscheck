# Domain Checker API

Check one domain name against multiple TLD extensions via RDAP/WHOIS.
Built with **TanStack Start + TypeScript**, deployed on **Cloudflare Workers** with **KV** caching and a local **D1** TLD registry.

## Installation

```bash
npm install
npx wrangler kv namespace create DOMAIN_CACHE   # paste the returned id into wrangler.jsonc
npx wrangler d1 create tld-registry             # paste the returned id into wrangler.jsonc
npm run cf-typegen                              # regenerate worker-configuration.d.ts
npm run build:tlds                              # build data/tlds.* from IANA
npm run import:tlds                             # import the dataset into local D1
```

## Development

```bash
npm run dev     # http://localhost:3000
npm run check   # self-check: parsing, extensions, limiter, TLD dataset, routing, WHOIS classification
```

## GET examples

```bash
# name without extension
curl 'http://localhost:3000/api/domains/check?name=example&extensions=com,net,org'
# -> example.com, example.net, example.org

# name already contains an extension: com is included automatically, first
curl 'http://localhost:3000/api/domains/check?name=example.com&extensions=net,org'
# -> example.com, example.net, example.org

# no extensions param: all supported extensions, com first
curl 'http://localhost:3000/api/domains/check?name=acme.com'
# -> acme.com, acme.net, acme.org, acme.io, acme.dev, acme.app, acme.id

# declared order is preserved
curl 'http://localhost:3000/api/domains/check?name=acme&extensions=net,org,dev'
# -> acme.net, acme.org, acme.dev
```

## POST examples

```bash
curl -X POST http://localhost:3000/api/domains/check \
  -H 'Content-Type: application/json' \
  -d '{"name": "example", "extensions": ["com", "net", "org"]}'

curl -X POST http://localhost:3000/api/domains/check \
  -H 'Content-Type: application/json' \
  -d '{"name": "example.com", "extensions": ["net", "org"]}'

# extensions omitted -> all supported extensions
curl -X POST http://localhost:3000/api/domains/check \
  -H 'Content-Type: application/json' \
  -d '{"name": "example"}'
```

Response (real example from `?name=obstatic&extensions=com,net,io,sh`):

```json
{
  "name": "obstatic",
  "results": [
    {
      "domain": "obstatic.com",
      "extension": "com",
      "cached": false,
      "registered": true,
      "available": false,
      "status": "registered"
    },
    {
      "domain": "obstatic.io",
      "extension": "io",
      "cached": false,
      "registered": false,
      "available": true,
      "status": "available"
    }
  ],
  "meta": {
    "total": 4,
    "available": 3,
    "registered": 1,
    "reserved": 0,
    "unsupported": 0,
    "errors": 0,
    "cached": 0
  }
}
```

(results trimmed to two of four; `meta` covers the full batch.) A TLD with no lookup
route, e.g. `.al`, reports:

```json
{
  "domain": "testdomain.al",
  "extension": "al",
  "registered": null,
  "available": null,
  "status": "unsupported",
  "error": "no RDAP or WHOIS server registered for .al",
  "cached": false
}
```

`status` is one of:

- `registered` — RDAP or WHOIS confirmed the domain is registered
- `available` — RDAP or WHOIS confirmed the domain is available
- `reserved` — the registry holds the name back: `registered: false`, `available: false`
  (e.g. brand names on `.sh` — "This name is reserved by the Registry")
- `unsupported` — the TLD has neither a RDAP nor a WHOIS server in the local registry
- `error` — a lookup source exists but the request failed or was inconclusive

On `error`/`unsupported`, `registered`/`available` are `null` and `error` explains why.
`cached` is `true` when served from cache instead of a lookup (counted in `meta.cached`),
`false` when just looked up. `meta` summarizes the batch — `total`, `available`,
`registered`, `reserved`, `unsupported`, `errors` and `cached` (results served from
cache instead of a lookup). Invalid input returns `400` with `{ "error": "..." }`.

## Extension behavior

- `SUPPORTED_EXTENSIONS` lives in `src/lib/extensions.ts` — the default list when `extensions` is omitted.
- The extension found inside `name` is always included and placed **first**.
- Requested extensions follow in their declared order, deduplicated.
- Normalization: lowercase, trim, leading/trailing dots stripped (`.com` == `com`).
- Malformed names or extensions are rejected with `400`, never cached.

## TLD registry dataset

The runtime never performs IANA metadata discovery. A build script resolves TLD
metadata once into `data/`, and the API reads it from Cloudflare D1.

| Source | Gives |
| --- | --- |
| `https://data.iana.org/TLD/tlds-alpha-by-domain.txt` | authoritative TLD list, normalized to lowercase |
| `https://data.iana.org/rdap/dns.json` | TLD → RDAP URL, `NULL` when the TLD has no RDAP entry |
| `https://www.iana.org/whois?q=.<tld>` | TLD → WHOIS server (IANA WHOIS record), `NULL` when absent |
| `https://www.iana.org/domains/root/db/<tld>.html` | WHOIS fallback when the record is empty or transient |

A TLD present in the list is a recognized TLD even when `dns.json` has no entry for
it — a missing RDAP entry is `rdap = NULL`, never a reason to drop or reject the TLD.
WHOIS is a secondary source; verified extra mappings go in `REGISTRY_WHOIS` /
`MANUAL_WHOIS` inside the build script (source `registry` / `manual`).

```bash
npm run build:tlds    # bun run build:tlds — reproducible rebuild
npm run import:tlds   # wrangler d1 execute tld-registry --local --file=data/tlds.sql
npx wrangler d1 execute tld-registry --remote --file=data/tlds.sql   # production
```

Generated output (kept out of `src/` and `scripts/`):

```text
data/
├── tlds.json        # { "com": { "whois": "whois.verisign-grs.com", "rdap": "https://rdap.verisign.com/com/v1/" } }
├── tlds.sql         # D1 schema + rows
└── tlds.report.json # validation report
```

D1 schema:

```sql
CREATE TABLE tlds (
  tld TEXT PRIMARY KEY,
  whois_server TEXT,
  rdap_url TEXT,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`source` is the most specific provenance of the row:
`manual` > `registry` > `iana-whois` > `iana-rdap` > `iana`.

The build validates duplicate TLDs, malformed TLDs, invalid RDAP URLs, invalid WHOIS
hostnames, RDAP mappings for unknown TLDs, missing TLD entries and conflicting
WHOIS/RDAP data — conflicts are recorded in the report, never silently discarded.

```text
TLDs: 1437
RDAP: 1203
WHOIS: 874
Missing RDAP: 234
Missing WHOIS: 563
Conflicts: 0
```

## Architecture

```text
data/                       # generated TLD registry dataset
scripts/
├── build-tld-database.ts   # downloads IANA data, merges, validates, writes data/*
└── selfcheck.ts            # runnable self-check (npm run check)
src/
├── routes/api/domains/check.ts   # GET/POST handling, cache-first bulk flow
├── lib/
│   ├── domain.ts           # parse and normalize name
│   ├── extensions.ts       # SUPPORTED_EXTENSIONS + extension resolution
│   ├── tlds.ts             # D1 TLD registry lookup + routing (RDAP / WHOIS / unsupported)
│   ├── rdap.ts             # RDAP lookup against a known service URL
│   ├── whois.ts            # WHOIS lookup (port 43) + response classification
│   ├── results.ts          # result shape, summary (meta), result caching
│   ├── limiter.ts          # concurrency limiter (mapLimit)
│   └── cache.ts            # Cloudflare KV wrapper (graceful when unavailable)
└── server.ts               # Cloudflare Workers server entry
```

Flow per request: normalize → resolve extensions → per-domain cache lookup → one D1
query (`WHERE tld IN (...)`) → `Map<tld, TldConfig>` → route each uncached domain:

```text
TLD config
   ├── rdap_url     → RDAP lookup
   └── rdap_url missing
          └── whois_server → WHOIS lookup
          └── both missing → unsupported
```

Only uncached domains enter the concurrency limiter (`LOOKUP_CONCURRENCY`, default 5).

## Bulk performance

- **One D1 query per bulk request** — unique TLDs of the request go into a single
  `SELECT … WHERE tld IN (…)`; the resulting `Map<tld, TldConfig>` drives routing.
- **Concurrent KV reads** — one `KV GET` per domain via `Promise.allSettled`; a failed
  read counts as a miss. A cached domain never produces an upstream request.
- **Concurrent upstream lookups** — uncached domains run through the concurrency
  limiter (`LOOKUP_CONCURRENCY`, default 5), and so do background stale-while-revalidate
  refreshes: no unbounded upstream fan-out anywhere. Tasks never reject: a failing or
  timed-out provider yields an `error` result for that domain alone, and the response
  always contains one result per requested domain.
- **Per-request timeouts** — RDAP 3 s, WHOIS 5 s (`TIMEOUT` in `src/lib/results.ts`);
  a timeout aborts only that lookup.
- **Provider isolation** — RDAP and WHOIS run independently per domain: bulk latency
  is bounded by the slowest provider, not the sum of all providers.
- **Deterministic ordering** — results always follow the requested extension order,
  regardless of upstream completion order.

## Caching

Single KV namespace `DOMAIN_CACHE` (see `wrangler.jsonc`), one entry per domain — never
one entry per bulk request. A small in-memory layer fronts KV (60 s), and every KV
failure degrades to a miss — the API stays functional with KV down.

| Status | Fresh window | Served stale until |
| --- | --- | --- |
| `registered` | 1 h | 6 h |
| `reserved` | 1 h | — |
| `available` | 10 min | 30 min |
| `unsupported` | 10 min | — |
| `error` | 2 s | — |

Stale-while-revalidate for successful results:

```text
Fresh (within fresh window)   → return cached result
Stale (within stale window)   → return cached result immediately
                                + refresh upstream in the background (waitUntil)
Beyond the stale window       → normal upstream lookup (entry already expired)
```

A stale result is counted as cached data (`meta.cached` and per-result `cached`). The KV
entry stores `cachedAt` internally to decide freshness and staleness — it is cache
metadata, not part of the response. Error results use a deliberately short 2 s cache so
a failing WHOIS/RDAP provider is not hammered but recovers quickly.

## Deployment

```bash
npm run deploy
```
