import { lookup } from 'node:dns/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BlockList, connect, isIP, type AddressInfo, type Socket } from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The web researcher's only way out to the internet (its HTTPS_PROXY).
 *
 * Checking the URL's host name isn't enough: names like `127.0.0.1.nip.io` resolve to this computer.
 * This proxy resolves every name itself, refuses if any address is on this computer, your local
 * network, your tailnet or other private ranges, and then connects to the exact address it checked
 * (so the answer can't change between check and connect). HTTPS only, ports 443 and 80.
 *
 * It adds no credentials and only ever reaches public addresses, so it gives nothing to anything else
 * on this computer that happens to use it.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['2001:db8::', 32], ['100::', 64]
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) {
    // Normalised (lower-case, compressed, hex only), so ::ffff:127.0.0.1 and ::ffff:7f00:1 look the same.
    const v6 = new URL(`http://[${address}]`).hostname.slice(1, -1)
    // Addresses that embed an IPv4 one: IPv4-mapped (::ffff:a.b.c.d) is judged as that IPv4 address;
    // the old IPv4-compatible form (::a.b.c.d, including :: and ::1) is never public.
    const embedded = /^::(ffff:)?(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,4})?$/.exec(v6)
    if (embedded) {
      if (!embedded[1]) return false
      const hi = parseInt(embedded[2] ?? '0', 16)
      const lo = parseInt(embedded[3] ?? '0', 16)
      return !blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4')
    }
    return !blocked.check(v6, 'ipv6')
  }
  return false
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>

export class WebEgressProxy {
  private server: Server | null = null
  private port = 0
  private sockets = new Set<Socket>()
  /** Per-run credentials: only a running researcher can use the tunnel, and only until its run ends. */
  private tokens = new Set<string>()

  /** A proxy URL for one researcher run (credentials included). Call the returned release when the run ends. */
  async issue(): Promise<{ url: string; release: () => void }> {
    await this.start()
    const token = randomBytes(24).toString('hex')
    this.tokens.add(token)
    return { url: `http://run:${token}@127.0.0.1:${this.port}`, release: () => this.tokens.delete(token) }
  }

  private authorized(req: IncomingMessage): boolean {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers['proxy-authorization'] ?? '')
    if (!m) return false
    const pass = Buffer.from(m[1]!, 'base64').toString('utf8').split(':').slice(1).join(':')
    const given = Buffer.from(pass)
    for (const t of this.tokens) {
      const want = Buffer.from(t)
      if (want.length === given.length && timingSafeEqual(want, given)) return true
    }
    return false
  }

  constructor(private readonly resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true })) {}

  async start(): Promise<string> {
    if (!this.server) {
      const server = createServer((req, res) => this.plain(req, res))
      server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => void this.tunnel(req, client, head))
      await new Promise<void>((ok, fail) => {
        server.once('error', fail)
        server.listen(0, '127.0.0.1', () => ok())
      })
      this.port = (server.address() as AddressInfo).port
      this.server = server
    }
    return `http://127.0.0.1:${this.port}`
  }

  stop(): void {
    for (const s of this.sockets) s.destroy()
    this.server?.close()
    this.server = null
  }

  /** Plain-HTTP proxy requests are refused: the researcher only reads pages over HTTPS. */
  private plain(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end('Hangar only lets the researcher open https:// pages.')
  }

  /** The public address to connect to for `host`, or null if the name is local or resolves anywhere private. */
  async check(host: string): Promise<string | null> {
    const name = host.replace(/^\[|\]$/g, '').toLowerCase()
    if (isIP(name)) return null // bare IP addresses are never needed for reading web pages
    if (!name.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp|intranet|ts\.net|home\.arpa)$/.test(name)) return null
    let addrs: { address: string }[]
    try {
      addrs = await this.resolve(name)
    } catch {
      return null
    }
    if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) return null
    return addrs[0]!.address
  }

  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    this.sockets.add(client)
    client.on('close', () => this.sockets.delete(client))
    client.on('error', () => client.destroy())
    if (!this.authorized(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="hangar"\r\nconnection: close\r\n\r\n')
      return
    }
    const m = /^([^:\s]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i.exec(req.url ?? '')
    const port = m ? Number(m[2]) : 0
    const deny = (why: string): void => {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${why}`)
    }
    if (!m || (port !== 443 && port !== 80)) return deny('Only web ports are allowed.')
    const address = await this.check(m[1]!)
    if (!address) return deny('That address is on this computer or a private network.')
    const upstream = connect({ host: address, port, timeout: 30_000 })
    this.sockets.add(upstream)
    upstream.on('close', () => this.sockets.delete(upstream))
    let established = false
    upstream.once('connect', () => {
      established = true
      upstream.setTimeout(0)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => {
      if (!established && !client.destroyed) deny('Could not connect.')
      else client.destroy()
    })
    client.on('close', () => upstream.destroy())
  }
}
