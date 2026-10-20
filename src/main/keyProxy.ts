import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'

/**
 * Keeps the real Anthropic API key out of the agents' reach.
 *
 * Each agent run gets its own random token instead of the key, with ANTHROPIC_BASE_URL pointing here.
 * The proxy checks the token and forwards the request to Anthropic with the real key added. When the
 * run ends its token is revoked. Anything an agent can read (environment, commands, tool servers)
 * only ever contains a token that is worthless off this machine and dies with the run.
 *
 * Hardening: 127.0.0.1 only; constant-time token check; Host must match (DNS rebinding); requests
 * with an Origin header (web pages) are refused; only the two endpoints the engine needs
 * (POST /v1/messages and /v1/messages/count_tokens) — not batches, files or anything else; request
 * and response headers are allowlisted; a request cap per run; body size and time limits.
 */
const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const REQUEST_HEADERS = new Set(['content-type', 'content-length', 'accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta', 'user-agent'])
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'cache-control', 'retry-after', 'request-id', 'x-should-retry'
])
const MAX_BODY = 32 * 1024 * 1024
const TIMEOUT_MS = 15 * 60 * 1000

interface TokenInfo {
  requests: number
  maxRequests: number
}

export class KeyProxy {
  private server: Server | null = null
  private port = 0
  private tokens = new Map<string, TokenInfo>()

  constructor(
    private readonly getKey: () => string | null,
    private readonly upstreamHost = 'api.anthropic.com'
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.handle(req, res))
    server.requestTimeout = TIMEOUT_MS
    await new Promise<void>((resolveStart, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolveStart())
    })
    this.port = (server.address() as AddressInfo).port
    this.server = server
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** A new token for one run. `maxRequests` caps how many API calls the run can make through it. */
  issueToken(maxRequests = 400): string {
    const token = `hangar-run-${randomBytes(24).toString('hex')}`
    this.tokens.set(token, { requests: 0, maxRequests })
    return token
  }

  revokeToken(token: string): void {
    this.tokens.delete(token)
  }

  stop(): void {
    this.tokens.clear()
    this.server?.close()
    this.server = null
  }

  private findToken(req: IncomingMessage): TokenInfo | null {
    const header = req.headers['x-api-key']
    const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '') : undefined
    const given = typeof header === 'string' ? header : bearer
    if (!given) return null
    const a = Buffer.from(given)
    for (const [token, info] of this.tokens) {
      const b = Buffer.from(token)
      if (a.length === b.length && timingSafeEqual(a, b)) return info
    }
    return null
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const deny = (code: number, msg: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'hangar_proxy_error', message: msg } }))
    }
    if (req.headers.host !== `127.0.0.1:${this.port}`) return deny(421, 'Wrong host')
    if (req.headers.origin !== undefined) return deny(403, 'Browser requests are not allowed')
    const url = req.url ?? ''
    const path = url.split('?')[0] ?? ''
    if (req.method !== 'POST' || !ALLOWED_PATHS.has(path)) return deny(404, 'Not available through Hangar')
    const info = this.findToken(req)
    if (!info) return deny(401, 'Invalid session token')
    if (++info.requests > info.maxRequests) return deny(429, 'This run reached its request limit')
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > MAX_BODY) return deny(413, 'Request too large')
    const key = this.getKey()
    if (!key) return deny(401, 'No API key saved in Hangar')

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && REQUEST_HEADERS.has(name)) headers[name] = value
    }
    headers['x-api-key'] = key
    headers.host = this.upstreamHost

    const upstream = httpsRequest({ host: this.upstreamHost, port: 443, method: 'POST', path: url, headers, timeout: TIMEOUT_MS }, (up) => {
      const out: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(up.headers)) {
        if (value !== undefined && (RESPONSE_HEADERS.has(name) || name.startsWith('anthropic-ratelimit-'))) out[name] = value
      }
      res.writeHead(up.statusCode ?? 502, out)
      up.pipe(res)
    })
    upstream.on('timeout', () => upstream.destroy(new Error('timed out')))
    upstream.on('error', (e) => {
      if (!res.headersSent) deny(502, `Could not reach Anthropic: ${e.message}`)
      else res.destroy()
    })
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        upstream.destroy()
        if (!res.headersSent) deny(413, 'Request too large')
        req.destroy()
      }
    })
    req.on('aborted', () => upstream.destroy())
    req.pipe(upstream)
  }
}
