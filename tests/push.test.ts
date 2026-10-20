import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { test } from 'node:test'
import { encryptPayload, generateVapidKeys, validSubscription, vapidAuthorization } from '../src/main/push'

test('Web Push encryption matches the RFC 8291 example exactly', () => {
  const body = encryptPayload(
    Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { senderPrivateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'), salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url') }
  )
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  )
})

test('VAPID tokens are valid ES256 JWTs for the push service origin', () => {
  const keys = generateVapidKeys()
  assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65)
  const auth = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:x@y.z', 1_700_000_000_000)
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)
  assert.ok(m)
  const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString())
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.exp, 1_700_000_000 + 12 * 3600)
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateJwk.x, y: keys.privateJwk.y }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url')))
})

test('only real push services are accepted as subscription endpoints', () => {
  const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }
  assert.equal(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys }), true)
  assert.equal(validSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }), true)
  assert.equal(validSubscription({ endpoint: 'https://evil.example/x', keys }), false)
  assert.equal(validSubscription({ endpoint: 'http://fcm.googleapis.com/x', keys }), false)
  assert.equal(validSubscription({ endpoint: 'https://127.0.0.1/x', keys }), false)
  assert.equal(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'short', auth: keys.auth } }), false)
})
