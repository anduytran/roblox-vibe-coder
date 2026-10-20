import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { request } from 'node:https'

/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
 * implemented with Node's crypto so no third-party service sees notification contents and
 * no extra dependency is needed. The push service (Apple, Google, Mozilla) only relays
 * ciphertext it cannot read.
 */

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what the browser's applicationServerKey needs). */
  publicKey: string
  /** Private key as a JWK (P-256). */
  privateJwk: { kty: string; crv: string; d: string; x: string; y: string }
}

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

const b64u = (b: Buffer): string => b.toString('base64url')
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url')

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' }) as { kty: string; crv: string; d: string; x: string; y: string }
  const pub = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])
  return { publicKey: b64u(pub), privateJwk: { kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x, y: jwk.y } }
}

/** Only these push services are ever contacted (prevents a paired device from pointing Hangar at other hosts). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]

export function validSubscription(s: unknown): s is PushSubscription {
  if (!s || typeof s !== 'object') return false
  const sub = s as PushSubscription
  try {
    const url = new URL(sub.endpoint)
    if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return false
  } catch {
    return false
  }
  return (
    typeof sub.keys?.p256dh === 'string' &&
    fromB64u(sub.keys.p256dh).length === 65 &&
    typeof sub.keys?.auth === 'string' &&
    fromB64u(sub.keys.auth).length === 16
  )
}

/**
 * RFC 8291 encryption. `testing` lets tests supply the RFC's fixed sender key and salt.
 */
export function encryptPayload(
  payload: Buffer,
  sub: PushSubscription['keys'],
  testing?: { senderPrivateKey: Buffer; salt: Buffer }
): Buffer {
  const uaPublic = fromB64u(sub.p256dh)
  const authSecret = fromB64u(sub.auth)
  const ecdh = createECDH('prime256v1')
  if (testing) ecdh.setPrivateKey(testing.senderPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = testing?.salt ?? randomBytes(16)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // A single record: plaintext followed by the 0x02 "last record" delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

function vapidKeyObject(keys: VapidKeys): KeyObject {
  return createPrivateKey({ key: keys.privateJwk, format: 'jwk' })
}

export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const data = `${header}.${claims}`
  const signature = sign('sha256', Buffer.from(data), { key: vapidKeyObject(keys), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${data}.${b64u(signature)}, k=${keys.publicKey}`
}

/** Send one notification. Resolves 'gone' when the subscription has expired and should be removed. */
export function sendPush(sub: PushSubscription, payload: object, keys: VapidKeys, subject = 'mailto:hangar@localhost'): Promise<'ok' | 'gone' | 'failed'> {
  if (!validSubscription(sub)) return Promise.resolve('gone')
  const body = encryptPayload(Buffer.from(JSON.stringify(payload).slice(0, 3000)), sub.keys)
  const url = new URL(sub.endpoint)
  return new Promise((resolveSend) => {
    const req = request(
      {
        host: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          TTL: '3600',
          Urgency: 'high',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length,
          Authorization: vapidAuthorization(sub.endpoint, keys, subject)
        },
        timeout: 15_000
      },
      (res) => {
        res.resume()
        const code = res.statusCode ?? 0
        resolveSend(code === 404 || code === 410 ? 'gone' : code >= 200 && code < 300 ? 'ok' : 'failed')
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolveSend('failed'))
    req.end(body)
  })
}
