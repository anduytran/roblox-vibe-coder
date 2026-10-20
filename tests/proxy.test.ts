import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { KeyProxy } from '../src/main/keyProxy'

function call(proxy: KeyProxy, opts: { path?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string }> {
  const url = new URL(proxy.baseUrl())
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: opts.path ?? '/v1/messages', method: 'POST', headers: opts.headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end('{}')
  })
}

test('H2: the key-hiding proxy only serves its own token, host and API paths', async () => {
  // Upstream is unreachable on purpose: a request that passes every check fails with 502, proving it got through.
  const proxy = new KeyProxy(() => 'sk-ant-real-key', 'upstream.invalid')
  await proxy.start()
  const token = proxy.issueToken(3)
  try {
    assert.match(proxy.baseUrl(), /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal((await call(proxy, { headers: { 'x-api-key': 'wrong' } })).status, 401)
    assert.equal((await call(proxy, { headers: { 'x-api-key': 'sk-ant-real-key' } })).status, 401, 'the real key is not a valid token')
    assert.equal((await call(proxy, { headers: { 'x-api-key': token, origin: 'https://evil.example' } })).status, 403)
    assert.equal((await call(proxy, { path: '/admin', headers: { 'x-api-key': token } })).status, 404)
    assert.equal((await call(proxy, { headers: { 'x-api-key': token, host: 'evil.example' } })).status, 421)
    const ok = await call(proxy, { headers: { 'x-api-key': token } })
    assert.equal(ok.status, 502)
    assert.doesNotMatch(ok.body, /sk-ant-real-key/)
    const bearer = await call(proxy, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(bearer.status, 502)
    // Batches, files and other endpoints are not reachable with a run token:
    assert.equal((await call(proxy, { path: '/v1/messages/batches', headers: { 'x-api-key': token } })).status, 404)
    assert.equal((await call(proxy, { path: '/v1/files', headers: { 'x-api-key': token } })).status, 404)
    // Request cap per run (3 allowed; 2 used above, the 4th is refused):
    assert.equal((await call(proxy, { headers: { 'x-api-key': token } })).status, 502)
    assert.equal((await call(proxy, { headers: { 'x-api-key': token } })).status, 429)
    // Revoked when the run ends:
    proxy.revokeToken(token)
    assert.equal((await call(proxy, { headers: { 'x-api-key': token } })).status, 401)
  } finally {
    proxy.stop()
  }
})
