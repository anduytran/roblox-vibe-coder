import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanPreviews, imageBlocks, MAX_IMAGES, MAX_PREVIEW_BYTES, removeImages, saveImages, sniffImage, sweepImages, withImages } from '../src/main/attachments'

// Images you attach to a message for an agent: checked to be real images, kept under random names, sent with the message.

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1)])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 2)])

test('attachments: only real PNG, JPEG, GIF and WebP images, by their first bytes', () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(JPEG), 'image/jpeg')
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
  assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null)
  const dir = tmp('hangar-att-')
  assert.throws(() => saveImages(dir, [`data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`]), /Only PNG, JPEG/)
  assert.throws(() => saveImages(dir, ['not base64 !!']), /could not be read/)
  assert.throws(() => saveImages(dir, Array(MAX_IMAGES + 1).fill(PNG.toString('base64'))), /at most 6/)
  assert.throws(() => saveImages(dir, [Buffer.alloc(4_000_000).toString('base64')]), /too big/)
  assert.deepEqual(saveImages(dir, undefined), [])
})

test('attachments: saved under random names, sent as image blocks before the text, then removed', async () => {
  const dir = tmp('hangar-att-')
  const names = saveImages(dir, [`data:image/png;base64,${PNG.toString('base64')}`, JPEG.toString('base64')])
  assert.equal(names.length, 2)
  assert.match(names[0]!, /^[0-9a-f-]{36}\.png$/)
  assert.match(names[1]!, /\.jpg$/)
  const blocks = imageBlocks(dir, [...names, '../../etc/passwd', 'x.png'])
  assert.deepEqual(blocks.map((b) => b.source.media_type), ['image/png', 'image/jpeg'], 'names Hangar didn\'t make are ignored')
  assert.equal(Buffer.from(blocks[0]!.source.data, 'base64').equals(PNG), true)
  const msgs: unknown[] = []
  for await (const m of withImages('Make the button look like this', blocks)) msgs.push(m)
  const content = (msgs[0] as { message: { content: { type: string; text?: string }[] } }).message.content
  assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text'])
  assert.equal(content[2]!.text, 'Make the button look like this')
  removeImages(dir, names)
  assert.equal(readdirSync(dir).length, 0)
})

test('attachments: a file swapped for something else is left out; old leftovers are swept', () => {
  const dir = tmp('hangar-att-')
  const [name] = saveImages(dir, [PNG.toString('base64')])
  writeFileSync(join(dir, name!), JPEG)
  assert.equal(imageBlocks(dir, [name!]).length, 0, 'a .png that is now a JPEG')
  const old = join(dir, 'old.png')
  writeFileSync(old, PNG)
  utimesSync(old, new Date(0), new Date(0))
  sweepImages(dir)
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(join(dir, name!)), true)
})

test('attachments: chat previews are small PNGs or JPEGs, checked by their bytes, never anything else', () => {
  const png = `data:image/png;base64,${PNG.toString('base64')}`
  const jpeg = `data:image/jpeg;base64,${JPEG.toString('base64')}`
  assert.deepEqual(cleanPreviews([png, jpeg]), [png, jpeg])
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`
  const lying = `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`
  const relabelled = `data:image/png;base64,${JPEG.toString('base64')}`
  const big = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(MAX_PREVIEW_BYTES)]).toString('base64')}`
  assert.deepEqual(cleanPreviews([svg, lying, big, 'https://example.com/a.png', 7, null]), [])
  assert.deepEqual(cleanPreviews([relabelled]), [jpeg], 'labelled by what it is')
  assert.equal(cleanPreviews(Array(MAX_IMAGES + 3).fill(png)).length, MAX_IMAGES)
  assert.deepEqual(cleanPreviews('nope'), [])
})
