import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Images you attach to a message for an agent. They come from you (picked, pasted or dropped in the chat), are checked
 * to be real images by their first bytes, and are kept in Hangar's data folder under random names until the task has
 * run. The agent sees them in its message; it never gets a path to them.
 */

export const MAX_IMAGES = 6
/** The API takes images up to 5 MB once base64-encoded, which is about 3.75 MB of image. */
export const MAX_IMAGE_BYTES = 3_750_000

export type ImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
const EXT: Record<ImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const TYPE_OF: Record<string, ImageType> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
/** Only names Hangar made: a task read back from disk can't point anywhere else. */
const NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/

/** What kind of image these bytes are, by their signature; null if they aren't one Claude can read. */
export function sniffImage(b: Buffer): ImageType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

/** Saves the images sent with a message (data URLs or plain base64) and returns their names. Throws on a bad one. */
export function saveImages(dir: string, input: unknown): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('Images must be a list.')
  if (input.length > MAX_IMAGES) throw new Error(`Attach at most ${MAX_IMAGES} images to one message.`)
  const bufs = input.map((x) => {
    if (typeof x !== 'string' || x.length > MAX_IMAGE_BYTES * 1.4) throw new Error('An image is too big (3.7 MB at most).')
    const b64 = x.replace(/^data:image\/[a-z+]+;base64,/i, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('An image could not be read.')
    const buf = Buffer.from(b64, 'base64')
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('An image is too big (3.7 MB at most).')
    const type = sniffImage(buf)
    if (!type) throw new Error('Only PNG, JPEG, GIF and WebP images can be attached.')
    return { buf, type }
  })
  if (!bufs.length) return []
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return bufs.map(({ buf, type }) => {
    const name = `${randomUUID()}.${EXT[type]}`
    writeFileSync(join(dir, name), buf, { mode: 0o600 })
    return name
  })
}

export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: ImageType; data: string }
}

/** The saved images as content blocks for the agent's message; missing or altered ones are left out. */
export function imageBlocks(dir: string, names: readonly string[] | undefined): ImageBlock[] {
  const out: ImageBlock[] = []
  for (const name of names ?? []) {
    if (!NAME.test(name)) continue
    try {
      const buf = readFileSync(join(dir, name))
      const type = sniffImage(buf)
      if (!type || type !== TYPE_OF[name.split('.').pop()!] || buf.length > MAX_IMAGE_BYTES) continue
      out.push({ type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } })
    } catch {
      // gone: the message still goes without it
    }
  }
  return out
}

export function removeImages(dir: string, names: readonly string[] | undefined): void {
  for (const name of names ?? []) if (NAME.test(name)) rmSync(join(dir, name), { force: true })
}

/** Removes images left behind (a task removed from its queue, or Hangar closed first) after a few days. */
export function sweepImages(dir: string, maxAgeMs = 3 * 24 * 3600_000, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { force: true })
    }
  } catch {
    // no folder yet
  }
}

/** The agent's prompt with images: one user message holding the images, then the text. */
export async function* withImages(text: string, images: ImageBlock[]): AsyncGenerator<unknown> {
  yield { type: 'user', message: { role: 'user', content: [...images, { type: 'text', text }] }, parent_tool_use_id: null, session_id: '' }
}
