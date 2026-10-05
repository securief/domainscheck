import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main>
      <h1>Domain Checker API</h1>
      <p>
        <code>GET /api/domains/check?name=example&amp;extensions=com,net,org</code>
      </p>
    </main>
  )
}
