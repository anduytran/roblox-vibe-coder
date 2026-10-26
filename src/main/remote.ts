import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolveCommand } from './testPlace'
import { execFile } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { RemoteStatus } from '@shared/ipc'
import type { AgentEvent, ApprovalRequest, Review } from '@shared/types'
import type { AgentRunner } from './agentRunner'
import type { CostTracker } from './costs'
import { JsonStore } from './jsonStore'
import { PHONE_FILES } from './phoneApp'
import type { ProjectRegistry } from './projects'
import { generateVapidKeys, sendPush, validSubscription, type PushSubscription, type VapidKeys } from './push'
import type { ReviewActions } from './reviewActions'
import type { Autopilot } from './autopilot'
import { listRoles } from './roles'
import { DECEPTIVE_CHARS, shellWords } from './permissions'
import { checkinReply, phoneCheckin, phoneIdeas } from './phoneData'
import type { Trends } from './trending'
import { revealHidden } from '@shared/text'

/**
 * Phone remote. Hangar listens on 127.0.0.1 only; `tailscale serve` makes it reachable over HTTPS
 * from your own Tailscale devices (never the public internet).
 *
 * - Pairing: a 6-digit code shown on the desktop for 5 minutes, 5 attempts max; the phone receives a
 *   random device token, of which only a hash is stored. Unpair any device from the desktop.
 * - The phone can: see status, queue tasks, approve/deny normal approvals, review/merge/discard/publish
 *   finished tasks, answer sprint check-ins, read and save ideas, and stop all agents. It can never change settings, rules or permissions, never
 *   choose "always allow", and high-risk (red) approvals must be approved on the computer.
 * - Every API call needs the device token in an Authorization header (no cookies, so no CSRF);
 *   Host and Origin are checked; bodies are size-limited; responses carry a strict CSP.
 */
const DEFAULT_PORT = 47621
const MAX_BODY = 64 * 1024
const PAIR_TTL_MS = 5 * 60 * 1000

interface Device {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
  lastSeen: number | null
  push: PushSubscription | null
}

interface RemoteData {
  enabled: boolean
  port: number
  devices: Device[]
  vapid: VapidKeys | null
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')
const MAX_PHONE_SUMMARY = 2000

/**
 * Whether an approval may be allowed from the phone: not high-risk, shown in full (nothing cut off),
 * and for shell commands only plain ones (no quotes, variables, chaining or redirection) — anything
 * trickier is easier to misjudge on a small screen, so it stays on the computer.
 */
export function phoneCanApprove(r: ApprovalRequest): boolean {
  if (r.dangerous || r.truncated || r.summary.length > MAX_PHONE_SUMMARY) return false
  if (r.toolName === 'Bash') return shellWords(r.summary.replace(/^\$ /, '')) !== null
  return true
}

const DEVICE_IDLE_LIMIT_MS = 30 * 24 * 3600 * 1000

function findTailscale(): Promise<string | null> {
  // Absolute paths only (never a program in the current folder).
  const onPath = resolveCommand('tailscale')
  const candidates = [onPath, process.platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : null].filter((c): c is string => !!c)
  return new Promise((resolveFind) => {
    const tryNext = (i: number): void => {
      if (i >= candidates.length) return resolveFind(null)
      execFile(candidates[i]!, ['status', '--json'], { timeout: 5000, windowsHide: true }, (err, out) => {
        if (err) return tryNext(i + 1)
        try {
          const dns = (JSON.parse(String(out)) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, '')
          resolveFind(dns && /^[a-z0-9.-]+\.ts\.net$/i.test(dns) ? dns : null)
        } catch {
          resolveFind(null)
        }
      })
    }
    tryNext(0)
  })
}

export class RemoteServer {
  private store: JsonStore<RemoteData>
  private server: Server | null = null
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private tailnetHost: string | null = null
  private rate = new Map<string, number[]>()
  private notifyTimer: NodeJS.Timeout | null = null
  private pendingNotes: { title: string; body: string }[] = []
  private notifiedReviews = new Set<string>()
  private autopilotStatus = new Map<string, string>()

  constructor(
    file: string,
    private readonly deps: {
      registry: ProjectRegistry
      autopilot?: Autopilot
      runner: AgentRunner
      reviews: ReviewActions
      costs: CostTracker
      /** Ideas: read, save and unsave only (generating ideas costs money, so it stays on the computer). */
      trends?: Pick<Trends, 'current' | 'saveIdea' | 'unsaveIdea'>
      /** Tells the desktop window about changes made from the phone that have no event of their own. */
      emit?: (e: AgentEvent) => void
    }
  ) {
    this.store = new JsonStore<RemoteData>(file, { enabled: false, port: DEFAULT_PORT, devices: [], vapid: null })
  }

  // ---------- desktop controls ----------

  async status(): Promise<RemoteStatus> {
    const d = this.store.get()
    if (d.enabled && !this.tailnetHost) this.tailnetHost = await findTailscale()
    return {
      enabled: d.enabled,
      port: d.port,
      url: this.tailnetHost ? `https://${this.tailnetHost}/` : null,
      serveCommand: `tailscale serve --bg --https=443 127.0.0.1:${d.port}`,
      devices: d.devices.map((x) => ({ id: x.id, name: x.name, pairedAt: x.pairedAt, lastSeen: x.lastSeen })),
      pushReady: d.devices.some((x) => x.push !== null)
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    this.store.update((d) => ({ ...d, enabled, vapid: d.vapid ?? generateVapidKeys() }))
    if (enabled) await this.start()
    else this.stop()
    return this.status()
  }

  startPairing(): { code: string; expiresAt: number } {
    if (!this.store.get().enabled) throw new Error('Turn on the phone remote first.')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairing = { code, expiresAt: Date.now() + PAIR_TTL_MS, attempts: 0 }
    return { code, expiresAt: this.pairing.expiresAt }
  }

  async unpair(deviceId: string): Promise<RemoteStatus> {
    this.store.update((d) => ({ ...d, devices: d.devices.filter((x) => x.id !== deviceId) }))
    return this.status()
  }

  async start(): Promise<void> {
    const d = this.store.get()
    if (!d.enabled || this.server) return
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: Error) => this.json(res, 500, { error: e.message }))
    })
    server.requestTimeout = 30_000
    await new Promise<void>((resolveStart, reject) => {
      server.once('error', reject)
      server.listen(d.port, '127.0.0.1', () => resolveStart())
    })
    this.server = server
    this.tailnetHost = await findTailscale()
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }

  // ---------- notifications ----------

  /** Called with every agent event; sends a push to paired phones for the ones that need you. */
  onEvent(e: AgentEvent): void {
    if (!this.store.get().enabled) return
    if (e.type === 'approval') {
      const who = this.agentName(e.request.projectId, e.request.agentId)
      this.queueNote(
        e.request.dangerous ? `${who} needs you at your computer` : `${who} needs approval`,
        e.request.dangerous ? 'A high-risk action is waiting (approve it on your computer).' : e.request.summary.slice(0, 140)
      )
    } else if (e.type === 'autopilot') {
      const prev = this.autopilotStatus.get(e.state.projectId)
      this.autopilotStatus.set(e.state.projectId, e.state.status)
      if (prev === e.state.status) return
      const name = this.projectName(e.state.projectId)
      if (e.state.status === 'checkin') this.queueNote(`${name}: sprint ${e.state.sprint} check-in is ready`, 'See what was built and plan the next sprint.')
      else if (e.state.status === 'waiting') this.queueNote(`${name} needs you`, (e.state.reason ?? 'A task is waiting for your review.').slice(0, 140))
      else if (e.state.status === 'paused' && e.state.reason && !/by you|stopped all/i.test(e.state.reason)) this.queueNote(`${name}: autopilot paused`, e.state.reason.slice(0, 140))
    } else if (e.type === 'review' && e.review.status === 'pending') {
      // Once per review (it's updated as checks run), and not for work autopilot is handling itself.
      if (this.notifiedReviews.has(e.review.id)) return
      const ap = this.deps.autopilot?.get(e.review.projectId)
      if (ap && (ap.status === 'running' || ap.awaitingReviewId === e.review.id)) return
      this.notifiedReviews.add(e.review.id)
      const who = this.agentName(e.review.projectId, e.review.agentId)
      this.queueNote(`${who} finished: ${e.review.title.slice(0, 60)}`, `${e.review.files.length} file${e.review.files.length === 1 ? '' : 's'} changed${e.review.incomplete ? ' (stopped early)' : ''}. Tap to review.`)
    } else if (e.type === 'state' && e.state.status === 'error' && e.state.lastError) {
      this.queueNote(`${this.agentName(e.state.projectId, e.state.agentId)} hit a problem`, e.state.lastError.slice(0, 140))
    }
  }

  private queueNote(title: string, body: string): void {
    this.pendingNotes.push({ title, body })
    // Coalesce bursts into one notification.
    this.notifyTimer ??= setTimeout(() => {
      const notes = this.pendingNotes.splice(0)
      this.notifyTimer = null
      const first = notes[0]
      if (!first) return
      void this.pushAll(notes.length === 1 ? first : { title: first.title, body: `${first.body} (+${notes.length - 1} more)` })
    }, 3000)
  }

  private async pushAll(note: { title: string; body: string }): Promise<void> {
    const d = this.store.get()
    if (!d.vapid) return
    for (const dev of d.devices) {
      if (!dev.push) continue
      const result = await sendPush(dev.push, { ...note, url: '/' }, d.vapid).catch(() => 'gone' as const)
      if (result === 'gone') this.store.update((s) => ({ ...s, devices: s.devices.map((x) => (x.id === dev.id ? { ...x, push: null } : x)) }))
    }
  }

  // ---------- HTTP ----------

  private json(res: ServerResponse, code: number, body: unknown): void {
    if (res.headersSent) return
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...this.securityHeaders() })
    res.end(JSON.stringify(body))
  }

  private securityHeaders(): Record<string, string> {
    return {
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY'
    }
  }

  private hostOk(host: string | undefined): boolean {
    const port = this.store.get().port
    if (!host) return false
    if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true
    // Reached through `tailscale serve`: your own machine's tailnet name.
    // Only once Hangar knows this computer's own tailnet name (from `tailscale status`).
    return this.tailnetHost !== null && host.toLowerCase() === this.tailnetHost.toLowerCase()
  }

  private limited(key: string, max: number, windowMs: number): boolean {
    const now = Date.now()
    const hits = (this.rate.get(key) ?? []).filter((t) => now - t < windowMs)
    hits.push(now)
    this.rate.set(key, hits)
    return hits.length > max
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new Error('Expected JSON')
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BODY) throw new Error('Request too large')
      chunks.push(chunk as Buffer)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
    return parsed as Record<string, unknown>
  }

  private device(req: IncomingMessage): Device | null {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization ?? '')
    if (!m) return null
    const h = Buffer.from(hash(m[1]!))
    for (const d of this.store.get().devices) {
      const other = Buffer.from(d.tokenHash)
      if (other.length === h.length && timingSafeEqual(other, h)) {
        // A phone that hasn't been used for 30 days is unpaired automatically (lost or forgotten phones).
        if (Date.now() - (d.lastSeen ?? d.pairedAt) > DEVICE_IDLE_LIMIT_MS) {
          this.store.update((s) => ({ ...s, devices: s.devices.filter((x) => x.id !== d.id) }))
          return null
        }
        return d
      }
    }
    return null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostOk(req.headers.host)) return this.json(res, 421, { error: 'Wrong host' })
    // Never serve requests that came in through Tailscale Funnel (the public internet).
    if (req.headers['tailscale-funnel-request'] !== undefined) return this.json(res, 403, { error: 'Not available over Funnel' })
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'

    // Static phone app (no secrets in it).
    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = PHONE_FILES[url.pathname === '/' ? '/index.html' : url.pathname]
      if (!file) return this.json(res, 404, { error: 'Not found' })
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache', ...this.securityHeaders() })
      return void res.end(file.body)
    }

    // Writes must come from the app's own page (or no browser at all).
    const origin = req.headers.origin
    if (method !== 'GET' && origin !== undefined) {
      const host = req.headers.host ?? ''
      if (origin !== `https://${host}` && origin !== `http://${host}`) return this.json(res, 403, { error: 'Cross-origin request refused' })
    }

    if (url.pathname === '/api/pair' && method === 'POST') {
      if (this.limited('pair', 10, 60_000)) return this.json(res, 429, { error: 'Too many attempts' })
      const p = this.pairing
      // Same answer whether or not pairing is active, so the endpoint doesn't reveal when you're pairing.
      if (!p || Date.now() > p.expiresAt) return this.json(res, 401, { error: 'Wrong or expired code. Start pairing on your computer and try again.' })
      const body = await this.body(req)
      const code = typeof body.code === 'string' ? body.code.trim() : ''
      p.attempts++
      const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(p.code))
      if (!ok) {
        if (p.attempts >= 5) this.pairing = null
        return this.json(res, 401, { error: 'Wrong or expired code. Start pairing on your computer and try again.' })
      }
      this.pairing = null
      const token = randomBytes(32).toString('base64url')
      const cleanName = typeof body.name === 'string' ? body.name.replace(new RegExp(DECEPTIVE_CHARS.source, 'gu'), '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : ''
      const name = cleanName || 'Phone'
      const dev: Device = { id: randomUUID(), name, tokenHash: hash(token), pairedAt: Date.now(), lastSeen: Date.now(), push: null }
      this.store.update((d) => ({ ...d, devices: [...d.devices, dev] }))
      return this.json(res, 200, { token, deviceId: dev.id })
    }

    const dev = this.device(req)
    if (!dev) return this.json(res, 401, { error: 'This phone is not paired (or was unpaired).' })
    if (this.limited(dev.id, 120, 60_000)) return this.json(res, 429, { error: 'Slow down' })
    if (!dev.lastSeen || Date.now() - dev.lastSeen > 60_000) {
      this.store.update((d) => ({ ...d, devices: d.devices.map((x) => (x.id === dev.id ? { ...x, lastSeen: Date.now() } : x)) }))
    }

    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    const [, a, b, c, dPart] = parts

    if (method === 'GET' && a === 'state') return this.json(res, 200, this.stateFor())

    if (method === 'POST' && a === 'approvals' && b) {
      const body = await this.body(req)
      const decision = body.decision
      if (decision !== 'allow' && decision !== 'deny') return this.json(res, 400, { error: 'Decision must be allow or deny.' })
      const reqst = this.deps.runner.pendingApprovals().find((x) => x.id === b)
      if (!reqst) return this.json(res, 404, { error: 'That approval is no longer waiting.' })
      if (decision === 'allow' && !phoneCanApprove(reqst)) return this.json(res, 403, { error: 'This one has to be approved on your computer.' })
      this.deps.runner.respond(b, decision)
      return this.json(res, 200, { ok: true })
    }

    if (method === 'POST' && a === 'tasks') {
      const body = await this.body(req)
      const { projectId, agentId, prompt, record } = body
      if (typeof projectId !== 'string' || typeof agentId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
        return this.json(res, 400, { error: 'Missing project, agent or task.' })
      }
      this.deps.runner.send(projectId, agentId, prompt.slice(0, 20000), { record: record === true })
      return this.json(res, 200, { ok: true })
    }

    if (a === 'reviews' && b) {
      if (method === 'GET' && c === 'diff') {
        const diff = await this.deps.reviews.diff(b)
        return this.json(res, 200, { diff: diff.length > 300_000 ? diff.slice(0, 300_000) + '\n… (diff truncated; see it on your computer)' : diff })
      }
      if (method === 'GET' && c === 'clip' && dPart !== undefined) {
        const { path, type } = this.deps.reviews.clipPath(b, Number(dPart))
        const size = statSync(path).size
        const stream = createReadStream(path)
        stream.on('error', () => res.destroy())
        res.writeHead(200, { 'content-type': type, 'content-length': size, 'cache-control': 'no-store', ...this.securityHeaders() })
        return void stream.pipe(res)
      }
      if (method === 'POST' && (c === 'merge' || c === 'discard' || c === 'publish' || c === 'recheck')) {
        const body = c === 'merge' || c === 'recheck' ? await this.body(req) : {}
        const review: Review =
          c === 'merge'
            ? await this.deps.reviews.merge(b, {
                force: body.force === true,
                acknowledged: Array.isArray(body.acknowledged) ? body.acknowledged.filter((w: unknown): w is string => typeof w === 'string').slice(0, 20) : []
              })
            : c === 'discard'
              ? await this.deps.reviews.discard(b)
              : c === 'recheck'
                ? await this.deps.reviews.recheck(b, { reviewer: body.reviewer === true })
                : await this.deps.reviews.publish(b)
        return this.json(res, 200, { review })
      }
    }

    if (a === 'ideas' && this.deps.trends) {
      const trends = this.deps.trends
      if (method === 'GET' && !b) return this.json(res, 200, phoneIdeas(trends.current()))
      if (method === 'POST' && b && (c === 'save' || c === 'unsave')) {
        const id = b.slice(0, 200)
        const snapshot = c === 'save' ? trends.saveIdea(id) : trends.unsaveIdea(id)
        this.deps.emit?.({ type: 'trends', snapshot })
        return this.json(res, 200, phoneIdeas(snapshot))
      }
    }

    // A check-in answered on the phone: answers by position, the plan as edited, and notes. The server reads the
    // questions from the report it holds and builds the same feedback the desktop would.
    if (method === 'POST' && a === 'autopilot' && b && c === 'checkin' && this.deps.autopilot) {
      const ap = this.deps.autopilot
      this.deps.registry.get(b) // must be a real project
      const body = await this.body(req)
      const st = ap.get(b)
      const report = st.reports[st.reports.length - 1]
      // The reply names the exact report it answers (its sprint and when it was written), so answers can only go
      // with the questions they were typed under.
      const named = typeof body.sprint === 'number' && typeof body.at === 'number'
      if (st.status !== 'checkin' || !report || !named || body.sprint !== report.sprint || body.at !== report.at) return this.json(res, 409, { error: 'This check-in was already answered or replaced. Look again.' })
      let reply: ReturnType<typeof checkinReply>
      try {
        reply = checkinReply(report, body)
      } catch (e) {
        return this.json(res, 400, { error: (e as Error).message })
      }
      const next = ap.start(b, { feedback: reply.feedback, answers: reply.answers })
      return this.json(res, 200, { ok: true, status: next.status })
    }

    if (method === 'POST' && a === 'autopilot' && b && this.deps.autopilot) {
      const ap = this.deps.autopilot
      const body = await this.body(req)
      this.deps.registry.get(b) // must be a real project
      // The old way to answer a check-in (free text, no report named) is closed: a phone page from before the update
      // could otherwise send answers typed under a report that has since been replaced.
      if (c === 'continue') return this.json(res, 409, { error: 'Hangar was updated. Reload this page, then answer the check-in.' })
      const feedback = typeof body.feedback === 'string' ? body.feedback.slice(0, 8000) : ''
      const state =
        c === 'pause' ? ap.pause(b) : c === 'resume' ? ap.resume(b) : c === 'feedback' ? ap.addFeedback(b, feedback) : null
      if (!state) return this.json(res, 404, { error: 'Unknown action' })
      return this.json(res, 200, { ok: true, status: state.status })
    }

    if (method === 'POST' && a === 'stop-all') {
      this.deps.autopilot?.pauseAll('You stopped all agents.')
      for (const r of this.deps.runner.stopAll()) this.deps.autopilot?.returnFeedback(r.projectId, r.tasks)
      return this.json(res, 200, { ok: true })
    }

    if (method === 'POST' && a === 'push' && b === 'subscribe') {
      const body = await this.body(req)
      if (!validSubscription(body)) return this.json(res, 400, { error: 'Unsupported notification service.' })
      const sub: PushSubscription = { endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } }
      this.store.update((d) => ({ ...d, devices: d.devices.map((x) => (x.id === dev.id ? { ...x, push: sub } : x)) }))
      return this.json(res, 200, { ok: true })
    }

    if (method === 'POST' && a === 'unpair') {
      this.store.update((d) => ({ ...d, devices: d.devices.filter((x) => x.id !== dev.id) }))
      return this.json(res, 200, { ok: true })
    }

    return this.json(res, 404, { error: 'Not found' })
  }

  private projectName(projectId: string): string {
    try {
      return this.deps.registry.get(projectId).name
    } catch {
      return 'A project'
    }
  }

  private agentName(projectId: string, agentId: string): string {
    if (agentId === 'main') return 'Main'
    try {
      // Role names come from files in the repo: hidden characters are shown, not obeyed.
      return revealHidden(listRoles(this.deps.registry.get(projectId).path).find((r) => r.id === agentId)?.name ?? agentId)
    } catch {
      return agentId
    }
  }

  private stateFor(): unknown {
    const projects = this.deps.registry.list().map((p) => ({
      id: p.id,
      name: revealHidden(p.name),
      autonomous: p.settings.autonomous,
      autopilot: (() => {
        const ap = this.deps.autopilot?.get(p.id)
        if (!ap) return null
        const report = ap.reports[ap.reports.length - 1]
        return {
          status: ap.status,
          sprint: ap.sprint,
          tasksDone: ap.tasksDone,
          sprintTasks: ap.config.sprintTasks,
          reason: ap.reason,
          awaitingReviewId: ap.awaitingReviewId,
          report: ap.status === 'checkin' && report ? report.text.slice(0, 20_000) : null,
          checkin: ap.status === 'checkin' && report ? phoneCheckin(report) : null
        }
      })(),
      hasTestPlace: p.settings.testPlace !== null,
      agents: this.deps.runner.snapshot(p.id).map((a) => ({
        id: a.agentId,
        name: this.agentName(p.id, a.agentId),
        status: a.status,
        activity: a.activity,
        queued: a.queue.length,
        lastError: a.status === 'error' ? a.lastError : null
      }))
    }))
    const approvals = this.deps.runner.pendingApprovals().map((r: ApprovalRequest) => ({
      id: r.id,
      projectId: r.projectId,
      agent: this.agentName(r.projectId, r.agentId),
      summary: r.summary.slice(0, MAX_PHONE_SUMMARY),
      details: r.inputJson.slice(0, 20_000),
      reason: r.reason,
      dangerous: r.dangerous,
      phoneOk: phoneCanApprove(r),
      ts: r.ts
    }))
    const reviews = this.deps.reviews
      .list()
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        ...r,
        title: revealHidden(r.title),
        agent: this.agentName(r.projectId, r.agentId),
        clip: r.clip ? { kind: r.clip.kind, count: r.clip.files.length } : null,
        // The report itself is loaded on demand (via /diff); the list only needs its provenance.
        research: r.research ? { ...r.research, markdown: '' } : null,
        mergeWarnings: this.deps.reviews.mergeWarnings(r)
      }))
    return { projects, approvals, reviews, costs: this.deps.costs.summary(), vapidPublicKey: this.store.get().vapid?.publicKey ?? null }
  }
}
