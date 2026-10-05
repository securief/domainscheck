# Glossary

- **querySocket** — the WHOIS protocol seam in [`src/lib/whois.ts`](src/lib/whois.ts). Half-close discipline: write `name\r\n`, release the write lock but never close the writable side (on cloudflare:sockets that tears down the socket before the server answers — responses come back empty), then read to EOF (64KB cap). It owns teardown for the socket it is handed: exactly one `close()` on every path (success, error, timeout) plus timer cleanup. Driven through a Web Streams fake socket in [`scripts/selfcheck.ts`](scripts/selfcheck.ts).
